import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {compact, type CompactionResult} from "@earendil-works/pi-coding-agent";
import type {AssistantMessage} from "@earendil-works/pi-ai/compat";

export type CompactionPreparation = Parameters<typeof compact>[0];
export type CompactionModel = Parameters<typeof compact>[1];
export type CompactionStream = NonNullable<Parameters<typeof compact>[7]>;
export type CompactionThinkingLevel = NonNullable<Parameters<typeof compact>[6]>;

export type RetentionCheck = {
    id: string;
    description: string;
    /** Every group must have at least one alternative present in the summary. */
    required: string[][];
};

export type CompactionFixture = {
    id: string;
    prepare(): CompactionPreparation | Promise<CompactionPreparation>;
    checks: RetentionCheck[];
    /** Human review is necessary: literal checks cannot establish semantic equivalence. */
    reviewQuestions: string[];
};

export type CompactionExperimentInput = {
    preparation: CompactionPreparation;
    model: CompactionModel;
    thinkingLevel: CompactionThinkingLevel;
    signal: AbortSignal;
    stream: CompactionStream;
};

/** Experimental adapters receive model input, never the fixture's retention answers. */
export type CompactionExperiment = {
    id: string;
    run(input: CompactionExperimentInput): Promise<CompactionResult>;
};

export const stockCompaction: CompactionExperiment = {
    id: "stock",
    run: ({preparation, model, thinkingLevel, signal, stream}) => compact(
        preparation, model, undefined, undefined, undefined, signal, thinkingLevel, stream,
    ),
};

export type EvaluationCall = {
    durationMs: number;
    inputHash: string;
    model: string;
    reasoning: string;
    maxTokens?: number;
    stopReason?: AssistantMessage["stopReason"];
    usage?: AssistantMessage["usage"];
    usageComplete: boolean;
    error?: string;
};

export type EvaluationTrial = {
    fixture: string;
    experiment: string;
    repetition: number;
    inputHash: string;
    durationMs: number;
    tokensBefore: number;
    messagesToSummarize: number;
    turnPrefixMessages: number;
    settings: CompactionPreparation["settings"];
    usage: {input: number; output: number; cacheRead: number; cacheWrite: number; cost: number};
    usageComplete: boolean;
    cleanupComplete: boolean;
    summary?: string;
    summaryHash?: string;
    calls: EvaluationCall[];
    checks: Array<{id: string; passed: boolean}>;
    metadataPassed: boolean;
    error?: string;
};

export type EvaluationReport = {
    version: 1;
    mode: "smoke" | "live";
    timingScope: "summary-strategy-including-worker-cleanup";
    model: string;
    thinkingLevel: CompactionThinkingLevel;
    interrupted?: string;
    trials: EvaluationTrial[];
    comparisons: Array<{
        fixture: string;
        experiment: string;
        pairedMedianSpeedup: number | null;
        deterministicNonRegression: boolean;
        candidatePassedAllChecks: boolean;
        /** Never a claim that an LLM preserves all the information needed to continue. */
        conclusion: "smoke-only" | "failed-checks" | "requires-semantic-review";
    }>;
    review: Array<{fixture: string; questions: string[]; checks: RetentionCheck[]}>;
};

export type CompactionEvaluationOptions = {
    mode: EvaluationReport["mode"];
    model: CompactionModel;
    thinkingLevel: CompactionThinkingLevel;
    stream: CompactionStream;
    fixtures: CompactionFixture[];
    experiments: CompactionExperiment[];
    repetitions: number;
    timeoutMs: number;
    signal?: AbortSignal;
};

/** Owns paired trials; the stopwatch includes all worker calls and their cleanup. */
export class CompactionEvaluation {
    constructor(private readonly options: CompactionEvaluationOptions) {
        if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1) {
            throw new Error("repetitions must be a positive safe integer");
        }
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
            throw new Error("timeoutMs must be a positive safe integer");
        }
        if (options.fixtures.length === 0) throw new Error("At least one fixture is required");
        if (options.experiments[0] !== stockCompaction) throw new Error("The first experiment must be the stock implementation");
        if (new Set(options.experiments.map((experiment) => experiment.id)).size !== options.experiments.length) {
            throw new Error("Experiment IDs must be unique");
        }
    }

    async run(): Promise<EvaluationReport> {
        const trials: EvaluationTrial[] = [];
        let interrupted: string | undefined;
        fixtures: for (const fixture of this.options.fixtures) {
            for (let repetition = 0; repetition < this.options.repetitions; repetition++) {
                // Alternate order to expose rather than consistently favour provider/cache warmup effects.
                const experiments = repetition % 2 === 0
                    ? this.options.experiments : [...this.options.experiments].reverse();
                for (const experiment of experiments) {
                    if (this.options.signal?.aborted) { interrupted = errorText(this.options.signal.reason); break fixtures; }
                    const trial = await this.runTrial(fixture, experiment, repetition);
                    trials.push(trial);
                    if (!trial.cleanupComplete) {
                        interrupted = "Evaluation stopped: prior trial did not finish cleanup; later timings would be contaminated";
                        break fixtures;
                    }
                }
            }
        }
        return {
            version: 1,
            mode: this.options.mode,
            timingScope: "summary-strategy-including-worker-cleanup",
            model: `${this.options.model.provider}/${this.options.model.id}`,
            thinkingLevel: this.options.thinkingLevel,
            interrupted,
            trials,
            comparisons: this.compare(trials),
            review: this.options.fixtures.map((fixture) => ({
                fixture: fixture.id, questions: fixture.reviewQuestions, checks: fixture.checks,
            })),
        };
    }

    async runTrial(
        fixture: CompactionFixture, experiment: CompactionExperiment, repetition: number,
    ): Promise<EvaluationTrial> {
        const preparation = await fixture.prepare();
        const inputHash = fingerprint(preparation);
        const boundary = preparation.firstKeptEntryId;
        const tokensBefore = preparation.tokensBefore;
        const model = structuredClone(this.options.model);
        const modelHash = fingerprint(model);
        const reasoning = model.reasoning && this.options.thinkingLevel !== "off" ? this.options.thinkingLevel : "off";
        const messagesToSummarize = preparation.messagesToSummarize.length;
        const turnPrefixMessages = preparation.turnPrefixMessages.length;
        const settings = structuredClone(preparation.settings);
        const modifiedFiles = [...new Set([...preparation.fileOps.edited, ...preparation.fileOps.written])].sort();
        const readFiles = [...preparation.fileOps.read].filter((file) => !modifiedFiles.includes(file)).sort();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("Compaction evaluation timed out")), this.options.timeoutMs);
        const calls: EvaluationCall[] = [];
        const pending = new Set<Promise<void>>();
        let result: CompactionResult | undefined;
        let error: string | undefined;
        let expired!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
            const listener = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", listener, {once: true});
            expired = () => controller.signal.removeEventListener("abort", listener);
        });
        const forwardAbort = () => controller.abort(this.options.signal?.reason);
        this.options.signal?.addEventListener("abort", forwardAbort, {once: true});
        if (this.options.signal?.aborted) forwardAbort();
        const started = performance.now();
        const stream: CompactionStream = (requestedModel, context, options) => {
            controller.signal.throwIfAborted();
            if (fingerprint(requestedModel) !== modelHash || (options?.reasoning ?? "off") !== reasoning) {
                throw new Error("Experiment changed the model configuration or requested thinking level");
            }
            const call: EvaluationCall = {durationMs: 0, inputHash: fingerprint(context), usageComplete: false,
                model: `${requestedModel.provider}/${requestedModel.id}`, reasoning, maxTokens: options?.maxTokens};
            calls.push(call);
            const callStarted = performance.now();
            const callModel = structuredClone(requestedModel);
            const callContext = structuredClone(context);
            const requestOptions = {...options, cacheRetention: "none" as const,
                signal: options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal};
            // Register before awaiting the provider: even a fire-and-forget adapter call is owned by this trial.
            const provider = Promise.resolve().then(() => {
                controller.signal.throwIfAborted();
                return this.options.stream(callModel, callContext, requestOptions);
            });
            const measured = provider.then((responseStream) => responseStream.result()).then((response) => {
                call.stopReason = response.stopReason;
                if (response.stopReason !== "stop") call.error = response.errorMessage || `Provider response ${response.stopReason}`;
                if (!response.content.some((part) => part.type === "text" && part.text.trim()) ||
                    response.content.some((part) => part.type === "toolCall")) call.error ??= "Provider did not return a complete text summary";
                const usage = response.usage;
                const counters = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite,
                    usage?.totalTokens, usage?.cost?.input, usage?.cost?.output, usage?.cost?.cacheRead,
                    usage?.cost?.cacheWrite, usage?.cost?.total];
                if (counters.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
                    throw new Error("Provider returned invalid or missing usage");
                }
                call.usage = usage;
                // Error/abort responses commonly carry synthetic zero counters, not a provider billing receipt.
                const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
                call.usageComplete = response.stopReason !== "error" && response.stopReason !== "aborted" && tokens > 0;
            }).catch((failure: unknown) => {
                // Observe malformed-success parsing errors too; a two-argument then() would leak that rejection.
                call.error ??= errorText(failure);
            }).finally(() => {
                call.durationMs = performance.now() - callStarted;
                pending.delete(measured);
            });
            pending.add(measured);
            return provider;
        };
        // Install all observers before invoking user code: run() may throw synchronously despite its type.
        let operationSettled = false;
        const operation = Promise.resolve().then(() => experiment.run({
            preparation, model, thinkingLevel: this.options.thinkingLevel, signal: controller.signal, stream,
        }));
        const operationCleanup = operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
        try {
            result = await Promise.race([operation, aborted]);
            if (pending.size > 0) throw new Error("Experiment returned before its model calls finished");
            if (!result.summary.trim()) throw new Error("Experiment returned an empty summary");
        } catch (failure) {
            error = errorText(failure);
        } finally {
            // An adapter must not leave billable workers running after returning/failing.
            controller.abort(new Error("Compaction evaluation trial finished"));
            // Abort is cooperative. Do not let an adapter/provider that ignores it hang the entire suite.
            let cleanup: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([Promise.allSettled([operationCleanup, ...pending]), new Promise<void>((resolve) => {
                cleanup = setTimeout(resolve, 1000);
            })]);
            clearTimeout(cleanup);
            expired();
            this.options.signal?.removeEventListener("abort", forwardAbort);
            clearTimeout(timeout);
        }
        const durationMs = performance.now() - started;
        const cleanupComplete = operationSettled && pending.size === 0;
        if (!cleanupComplete) error = `${error ? `${error}; ` : ""}Adapter/provider did not settle after cancellation; results are invalid`;
        error ??= calls.find((call) => call.error)?.error;
        const details = result?.details;
        const metadataPassed = !error && result?.firstKeptEntryId === boundary && result.tokensBefore === tokensBefore &&
            hasFileLists(details) && fingerprint(details.readFiles.slice().sort()) === fingerprint(readFiles) &&
            fingerprint(details.modifiedFiles.slice().sort()) === fingerprint(modifiedFiles);
        return {
            fixture: fixture.id, experiment: experiment.id, repetition, inputHash, durationMs,
            tokensBefore, messagesToSummarize, turnPrefixMessages, settings,
            usage: calls.reduce((total, call) => ({
                input: total.input + (call.usage?.input ?? 0), output: total.output + (call.usage?.output ?? 0),
                cacheRead: total.cacheRead + (call.usage?.cacheRead ?? 0),
                cacheWrite: total.cacheWrite + (call.usage?.cacheWrite ?? 0),
                cost: total.cost + (call.usage?.cost.total ?? 0),
            }), {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0}),
            summary: result?.summary, summaryHash: result ? fingerprint(result.summary) : undefined,
            usageComplete: calls.every((call) => call.usageComplete === true),
            cleanupComplete,
            calls: structuredClone(calls), checks: scoreRetention(result?.summary ?? "", fixture.checks), metadataPassed,
            error,
        };
    }

    private compare(trials: EvaluationTrial[]): EvaluationReport["comparisons"] {
        return this.options.fixtures.flatMap((fixture) => this.options.experiments.slice(1).map((experiment) => {
            const candidates = trials.filter((trial) => trial.fixture === fixture.id && trial.experiment === experiment.id);
            const pairs = candidates.flatMap((candidate) => {
                const baseline = trials.find((trial) => trial.fixture === fixture.id && trial.experiment === "stock" &&
                    trial.repetition === candidate.repetition);
                return baseline ? [{candidate, baseline}] : [];
            });
            const complete = pairs.length === this.options.repetitions;
            const validTiming = complete && pairs.every(({candidate, baseline}) => !candidate.error && !baseline.error &&
                candidate.metadataPassed && baseline.metadataPassed && candidate.inputHash === baseline.inputHash);
            const deterministicNonRegression = complete && pairs.every(({candidate, baseline}) => !candidate.error && !baseline.error &&
                candidate.metadataPassed && baseline.metadataPassed &&
                candidate.inputHash === baseline.inputHash && baseline.checks.every((check, index) =>
                    !check.passed || candidate.checks[index]?.passed));
            const candidatePassedAllChecks = candidates.length === this.options.repetitions &&
                candidates.every((candidate) => !candidate.error && candidate.metadataPassed &&
                candidate.checks.every((check) => check.passed));
            return {
                fixture: fixture.id, experiment: experiment.id,
                pairedMedianSpeedup: validTiming && this.options.mode === "live" ? median(pairs.map(({baseline, candidate}) =>
                    baseline.durationMs / Math.max(candidate.durationMs, 0.001))) : null,
                deterministicNonRegression,
                candidatePassedAllChecks,
                conclusion: this.options.mode === "smoke" ? "smoke-only" as const
                    : !deterministicNonRegression || !candidatePassedAllChecks ? "failed-checks" as const
                        : "requires-semantic-review" as const,
            };
        }));
    }
}

export function scoreRetention(summary: string, checks: RetentionCheck[]): EvaluationTrial["checks"] {
    const normalized = summary.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
    return checks.map((check) => ({
        id: check.id,
        passed: check.required.every((alternatives) => alternatives.some((alternative) =>
            normalized.includes(alternative.toLocaleLowerCase("en-US").replace(/\s+/g, " ")))),
    }));
}

export function fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Set ? [...item].sort() : item)).digest("hex");
}

function hasFileLists(value: unknown): value is {readFiles: string[]; modifiedFiles: string[]} {
    return typeof value === "object" && value !== null && "readFiles" in value && "modifiedFiles" in value &&
        Array.isArray(value.readFiles) && value.readFiles.every((file) => typeof file === "string") &&
        Array.isArray(value.modifiedFiles) && value.modifiedFiles.every((file) => typeof file === "string");
}

function median(values: number[]): number {
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
