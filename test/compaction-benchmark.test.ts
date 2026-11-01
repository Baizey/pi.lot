import assert from "node:assert/strict";
import test from "node:test";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {CompactionBenchmark, type BenchmarkOptions} from "../experiments/compaction/CompactionBenchmark.js";
import {gradingInputs, referenceInputs} from "../experiments/compaction/BenchmarkCorpus.js";
import {fingerprint, stockCompaction, type CompactionExperiment} from "../experiments/compaction/CompactionEvaluation.js";
import {compactionFixtures} from "../experiments/compaction/CompactionFixtures.js";
import {summarizeBenchmark} from "../experiments/compaction/BenchmarkStatistics.js";
import {ValueRetention, scoreValue} from "../experiments/compaction/ValueRetention.js";
import type {BenchmarkReport, PreparedBenchmarkCase, ValueGrade} from "../experiments/compaction/BenchmarkTypes.js";
import {smokeModel, smokeStream} from "../scripts/evaluate-compaction.js";

async function options(overrides: Partial<BenchmarkOptions> = {}): Promise<BenchmarkOptions> {
    const preparation = await compactionFixtures[0]!.prepare();
    const reference = referenceInputs(preparation);
    const first = reference[0]!;
    const definition: PreparedBenchmarkCase["definition"] = {
        id: "source:checkpoint-0", cluster: "source", source: {file: "/unused/source.jsonl", checkpoint: 0, sha256: "f".repeat(64)},
        preparationHash: fingerprint(preparation), referenceHash: fingerprint(reference), tokensBefore: preparation.tokensBefore,
        historyMessages: preparation.messagesToSummarize.length, prefixMessages: preparation.turnPrefixMessages.length,
        rubric: {version: 1, status: "curated", facts: [{id: "RUBRIC_ONLY_ID", statement: first.text.slice(0, 60),
            category: "goal", weight: 5, critical: true, evidence: [{inputId: first.id, quote: first.text.slice(0, 60)}]}]},
    };
    return {mode: "live", corpus: {version: 1, piVersion: "1.4.0", cases: [definition], rejected: []},
        cases: [{definition, preparation, reference}], model: smokeModel(), thinking: "off", strategies: [stockCompaction],
        repetitions: 1, judgeRepetitions: 0, seed: 7, timeoutMs: 1000, stream: () => smokeStream(smokeModel()),
        signal: new AbortController().signal, ...overrides};
}

function retained(summary: string, rubric: NonNullable<PreparedBenchmarkCase["definition"]["rubric"]>): ValueGrade {
    const judgments = rubric.facts.map((fact) => ({factId: fact.id, status: "retained" as const, evidence: summary.slice(0, 20), reason: "Fake test judge"}));
    return {status: "graded", judgments, unsupportedClaims: [], value: scoreValue(rubric, judgments), gate: "pass"};
}

test("benchmark isolates answers, balances repetitions, and grades only after all timing trials finish", async (t) => {
    const events: string[] = [];
    const progress: BenchmarkReport[] = [];
    const grader = new ValueRetention(async () => { throw new Error("Unexpected real completion"); });
    t.mock.method(grader, "grade", async ({summary, rubric}: Parameters<ValueRetention["grade"]>[0]) => {
        assert.equal(events.filter((event) => event === "summary").length, 4);
        events.push("grade");
        return retained(summary, rubric);
    });
    const candidate: CompactionExperiment = {id: "candidate", async run(input) {
        assert.doesNotMatch(JSON.stringify(input), /RUBRIC_ONLY_ID/);
        assert.equal("rubric" in input, false);
        assert.equal("reference" in input, false);
        return stockCompaction.run(input);
    }};
    const setup = await options({strategies: [stockCompaction, candidate], repetitions: 2, judgeRepetitions: 2, grader,
        stream: () => { events.push("summary"); return smokeStream(smokeModel()); },
        onProgress: async (report) => { progress.push(structuredClone(report)); }});
    const report = await new CompactionBenchmark(setup).run();
    assert.equal(report.trials.length, 4);
    assert.equal(report.judgments.length, 8);
    assert.ok(report.judgments.every((judgment) => judgment.grade.status === "graded"));
    assert.ok(progress.some((report) => report.trials.length === 4 && report.judgments.length === 0));
    assert.equal(new Set(report.trials.map((trial) => trial.result.inputHash)).size, 1);
    assert.equal(report.scoringMode, "curated");
    assert.equal(report.interrupted, undefined);
    assert.equal(summarizeBenchmark(report).quality.complete, true);
    assert.deepEqual(report.trials.map((trial) => trial.result.experiment).slice(0, 2).sort(), ["candidate", "stock"]);
    assert.notEqual(report.trials[0]!.result.experiment, report.trials[2]!.result.experiment);
});

test("judge receives native assembly inventory while strategies and generation prompts receive no grading context", async (t) => {
    const grader = new ValueRetention(async () => { throw new Error("Unexpected real completion"); });
    let candidateCalls = 0;
    let judgeCalls = 0;
    const candidate: CompactionExperiment = {id: "inventory-candidate", async run(input) {
        candidateCalls++;
        assert.equal("reference" in input, false);
        assert.equal("rubric" in input, false);
        assert.doesNotMatch(JSON.stringify(input), /file-operations|Authoritative native assembly|RUBRIC_ONLY_ID/);
        return stockCompaction.run(input);
    }};
    const setup = await options({strategies: [stockCompaction, candidate], judgeRepetitions: 1, grader,
        stream: (_model, context) => {
            assert.doesNotMatch(JSON.stringify(context), /file-operations|Authoritative native assembly|RUBRIC_ONLY_ID|inventory-only/);
            return smokeStream(smokeModel());
        }});
    const source = setup.cases[0]!;
    source.preparation.fileOps = {read: new Set(["/inventory-only-read.ts", "/inventory-only-edited.ts"]),
        written: new Set(["/inventory-only-written.ts"]), edited: new Set(["/inventory-only-edited.ts"])};
    source.definition.preparationHash = fingerprint(source.preparation);
    const before = structuredClone(source);
    t.mock.method(grader, "grade", async ({reference, summary, rubric}: Parameters<ValueRetention["grade"]>[0]) => {
        judgeCalls++;
        assert.deepEqual(reference, gradingInputs(source));
        assert.notEqual(reference, source.reference);
        assert.match(reference.at(-1)!.text, /inventory-only-read\.ts/);
        assert.match(reference.at(-1)!.text, /inventory-only-edited\.ts/);
        assert.match(reference.at(-1)!.text, /inventory-only-written\.ts/);
        assert.doesNotMatch(reference.at(-1)!.text, /inventory-candidate|duration|cost|timing/);
        assert.match(summary, /<read-files>/);
        assert.match(summary, /<modified-files>/);
        return retained(summary, rubric);
    });
    const report = await new CompactionBenchmark(setup).run();
    assert.equal(candidateCalls, 1);
    assert.equal(judgeCalls, 2);
    assert.equal(report.interrupted, undefined);
    assert.ok(report.judgments.every((item) => item.grade.status === "graded"));
    assert.deepEqual(source, before);
    assert.equal(fingerprint(source.reference), source.definition.referenceHash);
});

test("invalid checkpoint metadata is explicitly unscored and invalidates paired comparisons", async (t) => {
    const grader = new ValueRetention(async () => { throw new Error("Unexpected real completion"); });
    let calls = 0;
    t.mock.method(grader, "grade", async ({summary, rubric}: Parameters<ValueRetention["grade"]>[0]) => { calls++; return retained(summary, rubric); });
    const invalid: CompactionExperiment = {id: "invalid", async run(input) {
        return {...await stockCompaction.run(input), firstKeptEntryId: "wrong-boundary"};
    }};
    const report = await new CompactionBenchmark(await options({strategies: [stockCompaction, invalid], grader, judgeRepetitions: 1})).run();
    assert.equal(calls, 1);
    const invalidTrial = report.trials.find((trial) => trial.result.experiment === "invalid")!;
    assert.equal(report.judgments.find((item) => item.trialId === invalidTrial.id)!.grade.status, "unscored");
    const stats = summarizeBenchmark(report);
    assert.equal(stats.comparisons[0]!.speedup, null);
    assert.equal(stats.quality.complete, false);
    assert.equal(stats.quality.means[0]!.value, null);
});

test("draft rubrics require explicit exploratory permission; changed prepared input is rejected before calls", async () => {
    const grader = new ValueRetention(async () => { throw new Error("Unexpected completion"); });
    const setup = await options({grader, judgeRepetitions: 1});
    setup.corpus.cases[0]!.rubric!.status = "draft";
    assert.throws(() => new CompactionBenchmark(setup), /draft rubrics/);
    assert.doesNotThrow(() => new CompactionBenchmark({...setup, allowDraftRubrics: true}));
    setup.cases[0]!.preparation.tokensBefore++;
    assert.throws(() => new CompactionBenchmark({...setup, allowDraftRubrics: true}), /Prepared corpus mismatch/);
});

test("external cancellation is propagated into an active summary and no later trial starts", async () => {
    const controller = new AbortController();
    let calls = 0, cleaned = false;
    const setup = await options({signal: controller.signal, repetitions: 2,
        stream: async (_model, _context, request) => {
            calls++;
            await new Promise<void>((resolve) => {
                request!.signal!.addEventListener("abort", () => { setTimeout(() => { cleaned = true; resolve(); }, 10); }, {once: true});
                controller.abort(new Error("User cancelled"));
            });
            throw new Error("Cancelled provider");
        }});
    const report = await new CompactionBenchmark(setup).run();
    assert.equal(calls, 1);
    assert.equal(cleaned, true);
    assert.equal(report.trials.length, 1);
    assert.match(report.interrupted!, /User cancelled/);
    assert.equal(report.trials[0]!.result.cleanupComplete, true);
});

test("a judge which ignores cancellation stops later grading and leaves explicit unscored outcomes", async (t) => {
    const grader = new ValueRetention(async () => { throw new Error("Unexpected completion"); });
    let calls = 0;
    t.mock.method(grader, "grade", async () => { calls++; return new Promise<ValueGrade>(() => {}); });
    const report = await new CompactionBenchmark(await options({grader, judgeRepetitions: 2, timeoutMs: 10})).run();
    assert.equal(calls, 1);
    assert.match(report.interrupted!, /did not settle/);
    assert.equal(report.judgments.length, 2);
    assert.ok(report.judgments.every((judgment) => judgment.grade.status === "unscored"));
});

test("truncated, blank and tool-call responses cannot become valid checkpoints merely through native file tags", async () => {
    for (const defect of ["length", "blank", "tool-call"]) {
        const report = await new CompactionBenchmark(await options({stream: async () => {
            const response = await smokeStream(smokeModel()).result();
            if (defect === "length") response.stopReason = "length";
            else if (defect === "blank") response.content = [{type: "text", text: "   "}];
            else response.content.push({type: "toolCall", id: "unexpected", name: "read", arguments: {}});
            const stream = createAssistantMessageEventStream();
            stream.push({type: "done", reason: response.stopReason === "length" ? "length" : "stop", message: response});
            return stream;
        }})).run();
        const trial = report.trials[0]!.result;
        assert.equal(trial.metadataPassed, false, defect);
        assert.ok(trial.error, defect);
        assert.equal(trial.usageComplete, true, "Known billed usage is preserved even for an invalid checkpoint");
        assert.equal(trial.cleanupComplete, true);
    }
});

test("malformed success usage is observed and remains unknown, not an unhandled rejection or known zero cost", async () => {
    const report = await new CompactionBenchmark(await options({stream: async () => {
        const response = await smokeStream(smokeModel()).result();
        Reflect.deleteProperty(response, "usage"); // Simulate malformed external SDK data without weakening owned types.
        const stream = createAssistantMessageEventStream();
        stream.push({type: "done", reason: "stop", message: response});
        return stream;
    }})).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const trial = report.trials[0]!.result;
    assert.equal(trial.metadataPassed, false);
    assert.equal(trial.usageComplete, false);
    assert.match(trial.calls[0]!.error!, /invalid or missing usage/);
    assert.equal(summarizeBenchmark(report).strategies[0]!.cost, null);
});

test("pre-aborted benchmarks make no calls and smoke runs never advertise real speedups or quality scores", async () => {
    const signal = AbortSignal.abort(new Error("Already cancelled"));
    const report = await new CompactionBenchmark(await options({signal, stream: () => { throw new Error("Must not call"); }})).run();
    assert.equal(report.trials.length, 0);
    assert.match(report.interrupted!, /Already cancelled/);
    const smoke = await new CompactionBenchmark(await options({mode: "smoke", strategies: [stockCompaction, {id: "identity", run: stockCompaction.run}]})).run();
    const stats = summarizeBenchmark(smoke);
    assert.equal(stats.conclusion, "smoke-only");
    assert.equal(stats.comparisons[0]!.speedup, null);
    assert.equal(stats.quality.means[0]!.value, null);
});
