import {
    CompactionEvaluation, fingerprint, stockCompaction,
    type CompactionExperiment, type CompactionFixture, type CompactionModel,
    type CompactionStream, type CompactionThinkingLevel,
} from "./CompactionEvaluation.js";
import type {BenchmarkCorpus, BenchmarkReport, PreparedBenchmarkCase, ValueGrade} from "./BenchmarkTypes.js";
import type {BudgetedModel} from "./BudgetedModel.js";
import {scheduleBenchmark} from "./BenchmarkStatistics.js";
import {ValueRetention} from "./ValueRetention.js";
import {boundedOperation} from "./BenchmarkDeadline.js";
import {gradingInputs} from "./BenchmarkCorpus.js";

export type BenchmarkOptions = {
    mode: "smoke" | "live";
    corpus: BenchmarkCorpus;
    cases: PreparedBenchmarkCase[];
    model: CompactionModel;
    thinking: CompactionThinkingLevel;
    strategies: CompactionExperiment[];
    repetitions: number;
    judgeRepetitions: number;
    seed: number;
    timeoutMs: number;
    stream: CompactionStream;
    signal: AbortSignal;
    grader?: ValueRetention;
    budget?: BudgetedModel;
    allowDraftRubrics?: boolean;
    onProgress?: (report: BenchmarkReport) => Promise<void>;
};

/** Summary trials and blinded grading are separate phases, so graders never contend with timed strategies. */
export class CompactionBenchmark {
    constructor(private readonly options: BenchmarkOptions) {
        if (options.strategies[0] !== stockCompaction) throw new Error("The first configured strategy must be stock");
        if (options.cases.length !== options.corpus.cases.length || options.cases.some((item, index) =>
            fingerprint(item.definition) !== fingerprint(options.corpus.cases[index]) ||
            fingerprint(item.preparation) !== item.definition.preparationHash ||
            fingerprint(item.reference) !== item.definition.referenceHash)) throw new Error("Prepared corpus mismatch");
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Invalid benchmark timeout");
        if (!Number.isSafeInteger(options.judgeRepetitions) || options.judgeRepetitions < 0 ||
            Boolean(options.grader) !== (options.judgeRepetitions > 0)) throw new Error("Invalid judge repetitions/grader combination");
        if (options.grader && options.cases.some((item) => !item.definition.rubric ||
            item.definition.rubric.status === "draft" && !options.allowDraftRubrics)) {
            throw new Error("Scoring requires a source-validated rubric for every case; draft rubrics need explicit exploratory permission");
        }
        scheduleBenchmark(options.corpus.cases.map((item) => item.id), options.strategies.map((item) => item.id), options.repetitions, options.seed);
    }

    async run(): Promise<BenchmarkReport> {
        const {options} = this;
        const report: BenchmarkReport = {
            version: 1, mode: options.mode, corpusHash: fingerprint(options.corpus),
            model: `${options.model.provider}/${options.model.id}`, thinking: options.thinking,
            seed: options.seed, repetitions: options.repetitions, judgeRepetitions: options.judgeRepetitions,
            caseIds: options.cases.map((item) => item.definition.id), strategyIds: options.strategies.map((item) => item.id),
            scoringMode: !options.grader ? "speed-only" : options.cases.some((item) => item.definition.rubric?.status === "draft") ? "exploratory" : "curated",
            timingScope: "summary-strategy-including-worker-cleanup", trials: [], judgments: [],
        };
        const fixtures = new Map(options.cases.map((item): [string, CompactionFixture] => [item.definition.id, {
            id: item.definition.id, prepare: () => structuredClone(item.preparation), checks: [], reviewQuestions: [],
        }]));
        const cases = new Map(options.cases.map((item) => [item.definition.id, item]));
        const strategies = new Map(options.strategies.map((item) => [item.id, item]));
        const evaluation = new CompactionEvaluation({
            mode: options.mode, model: options.model, thinkingLevel: options.thinking, stream: options.stream,
            fixtures: [...fixtures.values()], experiments: options.strategies, repetitions: options.repetitions,
            timeoutMs: options.timeoutMs, signal: options.signal,
        });
        for (const step of scheduleBenchmark(report.caseIds, report.strategyIds, options.repetitions, options.seed)) {
            const stopped = this.stopped();
            if (stopped) { report.interrupted = stopped; break; }
            try {
                const result = await evaluation.runTrial(fixtures.get(step.caseId)!, strategies.get(step.strategyId)!, step.repetition);
                report.trials.push({id: `trial-${report.trials.length.toString().padStart(6, "0")}`, cluster: cases.get(step.caseId)!.definition.cluster, result});
                if (!result.cleanupComplete) report.interrupted = "An adapter/provider did not finish cleanup; no further work may overlap it";
            } catch (error) {
                report.interrupted = errorText(error);
            }
            await options.onProgress?.(report);
            if (report.interrupted) break;
        }
        if (!report.interrupted && this.stopped()) report.interrupted = this.stopped();
        await this.grade(report);
        await options.onProgress?.(report);
        return report;
    }

    /** Regrading this owned report never re-runs the latency trials or passes strategy names to the judge. */
    async grade(report: BenchmarkReport): Promise<void> {
        const {options} = this;
        if (!options.grader) return;
        if (report.corpusHash !== fingerprint(options.corpus)) throw new Error("Cannot grade a different corpus");
        const cases = new Map(options.cases.map((item) => [item.definition.id, item]));
        report.judgments = [];
        const trials = new Map(report.trials.map((trial) => [trial.id, trial]));
        if (!trials.size) return;
        // A separate deterministic shuffle hides trial ordering from the judge. Prompt data has no trial/strategy ID.
        for (const step of scheduleBenchmark([...trials.keys()], ["judge"], options.judgeRepetitions, (options.seed ^ 0x4a554447) >>> 0)) {
            const trial = trials.get(step.caseId)!;
            const source = cases.get(trial.result.fixture);
            if (!source || trial.result.inputHash !== source.definition.preparationHash) throw new Error("Trial/source mismatch while grading");
            let grade: ValueGrade;
            const stopped = report.interrupted ?? this.stopped();
            if (stopped) {
                report.interrupted ??= stopped;
                grade = {status: "unscored", error: `Benchmark interrupted before grading: ${stopped}`};
            } else if (trial.result.error || !trial.result.metadataPassed || !trial.result.summary?.trim()) {
                grade = {status: "unscored", error: "No valid checkpoint to grade"};
            } else {
                const result = await this.gradeWithDeadline(source, trial.result.summary);
                grade = result.grade;
                if (!result.cleanupComplete) report.interrupted = "Judge/provider did not settle after cancellation; remaining grades are unscored";
            }
            report.judgments.push({trialId: trial.id, judgeRepetition: step.repetition, grade});
            await options.onProgress?.(report);
        }
    }

    private stopped(): string | undefined {
        if (this.options.signal.aborted) return errorText(this.options.signal.reason ?? "Benchmark cancelled");
        return this.options.budget?.blockedReason;
    }

    private async gradeWithDeadline(source: PreparedBenchmarkCase, summary: string): Promise<{grade: ValueGrade; cleanupComplete: boolean}> {
        const result = await boundedOperation((signal) => this.options.grader!.grade({
            reference: gradingInputs(source), rubric: source.definition.rubric!, summary, signal,
        }), this.options.signal, this.options.timeoutMs);
        return {
            grade: result.status === "ok" ? result.value : {status: "unscored", error: result.error},
            cleanupComplete: result.cleanupComplete,
        };
    }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
