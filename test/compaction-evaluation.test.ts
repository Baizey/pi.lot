import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {createAssistantMessageEventStream, normalizeContext, type AssistantMessage} from "@earendil-works/pi-ai";
import {
    CompactionEvaluation,
    fingerprint,
    scoreRetention,
    stockCompaction,
    type CompactionExperiment,
    type CompactionExperimentInput,
    type CompactionFixture,
    type CompactionStream,
    type RetentionCheck,
} from "../experiments/compaction/CompactionEvaluation.js";
import {compactionFixtures} from "../experiments/compaction/CompactionFixtures.js";
import {parseArguments, smokeModel, smokeStream} from "../scripts/evaluate-compaction.js";

const model = smokeModel();
const check: RetentionCheck = {id: "constraint", description: "Preserve public API and migration protection.",
    required: [["next_cursor"], ["do not edit", "must not edit"], ["migration.sql"]]};
const goodSummary = "Keep next_cursor. Do not edit migration.sql.";

test("public SDK fixtures exercise whole-history, split-request, iterative, and truncated-tool cases reproducibly", async () => {
    const byId = new Map(await Promise.all(compactionFixtures.map(async (fixture) => [fixture.id, await fixture.prepare()] as const)));
    assert.equal(byId.get("whole-history")?.isSplitTurn, false);
    assert.equal(byId.get("split-request")?.isSplitTurn, true);
    assert.ok(byId.get("split-request")!.messagesToSummarize.length > 0);
    assert.ok(byId.get("split-request")!.turnPrefixMessages.length > 0);
    assert.match(byId.get("iterative-checkpoint")!.previousSummary!, /Never retry non-idempotent POST/);
    for (const fixture of compactionFixtures) {
        assert.equal(fingerprint(await fixture.prepare()), fingerprint(byId.get(fixture.id)));
    }
});

test("retention checks require every fact group and allow explicit wording alternatives", () => {
    assert.deepEqual(scoreRetention("NEXT_CURSOR. Must not\nedit migration.sql.", [check]), [{id: "constraint", passed: true}]);
    assert.deepEqual(scoreRetention("Keep next_cursor. Migration.sql exists.", [check]), [{id: "constraint", passed: false}]);
});

test("stock smoke runs the actual one/two-call summarizers and records model usage without a real provider", async () => {
    const report = await evaluation({fixtures: compactionFixtures, mode: "smoke"}).run();
    assert.deepEqual(report.trials.map((trial) => trial.calls.length), [1, 1, 2, 1]);
    for (const trial of report.trials) {
        assert.equal(trial.error, undefined);
        assert.equal(trial.metadataPassed, true);
        assert.equal(trial.usageComplete, true);
        assert.equal(trial.usage.input, trial.calls.length);
        assert.equal(trial.usage.output, trial.calls.length);
        assert.equal(trial.summaryHash, fingerprint(trial.summary));
    }
});

test("paired experiments alternate order and never declare semantic-quality equivalence", async () => {
    const fixture = await checkedFixture();
    const candidate: CompactionExperiment = {id: "same-output", run: stockCompaction.run};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate], repetitions: 2,
        stream: () => reply(goodSummary)}).run();
    assert.deepEqual(report.trials.map((trial) => trial.experiment), ["stock", "same-output", "same-output", "stock"]);
    assert.ok(report.comparisons[0]!.pairedMedianSpeedup! > 0);
    assert.equal(report.comparisons[0]!.deterministicNonRegression, true);
    assert.equal(report.comparisons[0]!.candidatePassedAllChecks, true);
    assert.equal(report.comparisons[0]!.conclusion, "requires-semantic-review");
    assert.equal(report.review[0]!.questions.length > 0, true);
});

test("literal regressions fail the candidate gate even when its output is faster to produce", async () => {
    const fixture = await checkedFixture();
    const candidate: CompactionExperiment = {id: "drops-constraint", async run(input) {
        const result = await stockCompaction.run(input);
        return {...result, summary: "Keep next_cursor."};
    }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate],
        stream: () => reply(goodSummary)}).run();
    assert.equal(report.comparisons[0]!.deterministicNonRegression, false);
    assert.equal(report.comparisons[0]!.candidatePassedAllChecks, false);
    assert.equal(report.comparisons[0]!.conclusion, "failed-checks");
});

test("input preparations are isolated and fixture answers are not passed to experiments", async () => {
    const fixture = await checkedFixture();
    const candidate: CompactionExperiment = {id: "mutates-input", async run(input) {
        assert.equal("checks" in input, false);
        assert.equal("reviewQuestions" in input, false);
        input.preparation.messagesToSummarize.splice(0);
        return resultFor(input, goodSummary);
    }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate], repetitions: 2,
        stream: () => reply(goodSummary)}).run();
    assert.equal(new Set(report.trials.map((trial) => trial.inputHash)).size, 1);
    assert.equal(new Set(report.trials.map((trial) => trial.messagesToSummarize)).size, 1);
    assert.ok(report.trials.filter((trial) => trial.experiment === "stock").every((trial) => trial.calls.length === 1));
});

test("changed retained boundaries and file lists invalidate apples-to-apples timing comparisons", async () => {
    const fixture = await checkedFixture();
    const candidate: CompactionExperiment = {id: "wrong-boundary", async run(input) {
        return {...resultFor(input, goodSummary), firstKeptEntryId: "wrong-boundary"};
    }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate]}).run();
    assert.equal(report.trials[1]!.metadataPassed, false);
    assert.equal(report.comparisons[0]!.pairedMedianSpeedup, null);
    assert.equal(report.comparisons[0]!.conclusion, "failed-checks");
});

test("the meter owns asynchronous fire-and-forget calls and rejects incomplete experiments", async () => {
    const fixture = await checkedFixture();
    let aborted = false;
    const candidate: CompactionExperiment = {id: "unawaited-worker", async run(input) {
        void input.stream(input.model, normalizeContext({messages: []}), {signal: input.signal});
        return resultFor(input, goodSummary);
    }};
    const stream: CompactionStream = (requestedModel, context, options) => {
        if (context.messages.length !== 0) return reply(goodSummary);
        const response = createAssistantMessageEventStream();
        const cancel = () => {
            aborted = true;
            response.push({type: "error", reason: "aborted", error: message("", "aborted")});
        };
        if (options?.signal?.aborted) cancel();
        else options?.signal?.addEventListener("abort", cancel, {once: true});
        return response;
    };
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate], stream}).run();
    assert.match(report.trials[1]!.error!, /before its model calls finished/);
    assert.equal(report.trials[1]!.metadataPassed, false);
    assert.equal(report.trials[1]!.calls.length, 1);
    // Cancellation can happen before provider construction or while the response is pending.
    assert.ok(aborted || report.trials[1]!.calls[0]!.error);
});

test("deadlines cancel metered model calls and report incomplete usage honestly", async () => {
    const fixture = await checkedFixture();
    let aborted = false;
    const stream: CompactionStream = (_model, _context, options) => {
        const response = createAssistantMessageEventStream();
        options?.signal?.addEventListener("abort", () => {
            aborted = true;
            response.push({type: "error", reason: "aborted", error: message("", "aborted")});
        }, {once: true});
        return response;
    };
    const report = await evaluation({fixtures: [fixture], stream, timeoutMs: 15}).run();
    assert.match(report.trials[0]!.error!, /timed out/);
    assert.equal(aborted, true);
    assert.equal(report.trials[0]!.metadataPassed, false);
});

test("failed provider calls are not reported as known zero-cost requests", async () => {
    const fixture = await checkedFixture();
    const report = await evaluation({fixtures: [fixture], stream: () => { throw new Error("provider unavailable"); }}).run();
    assert.match(report.trials[0]!.error!, /provider unavailable/);
    assert.equal(report.trials[0]!.usageComplete, false);
    assert.equal(report.trials[0]!.calls[0]!.usage, undefined);
});

test("SDK error responses with placeholder usage retain the error without claiming known zero cost", async () => {
    const fixture = await checkedFixture();
    const report = await evaluation({fixtures: [fixture], stream: () => {
        const stream = createAssistantMessageEventStream();
        const response = message("", "error");
        response.errorMessage = "HTTP 503 provider unavailable";
        response.usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
        stream.push({type: "error", reason: "error", error: response});
        return stream;
    }}).run();
    assert.match(report.trials[0]!.calls[0]!.error!, /503/);
    assert.equal(report.trials[0]!.usageComplete, false);
    assert.equal(report.trials[0]!.calls[0]!.usageComplete, false);
});

test("synchronous adapter throws are observed without an unhandled cancellation rejection", async () => {
    const fixture = await checkedFixture();
    const candidate: CompactionExperiment = {id: "sync-throw", run() { throw new Error("candidate initialization failed"); }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate]}).run();
    assert.match(report.trials[1]!.error!, /candidate initialization failed/);
    assert.equal(report.trials[1]!.cleanupComplete, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
});

test("cancellation includes asynchronous adapter cleanup in timing before starting another trial", async () => {
    const fixture = await checkedFixture();
    const events: string[] = [];
    const candidate: CompactionExperiment = {id: "async-cleanup", async run(input) {
        try {
            await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), {once: true}));
        } finally {
            events.push("cleanup-start");
            await new Promise((resolve) => setTimeout(resolve, 35));
            events.push("cleanup-finished");
        }
        return resultFor(input, goodSummary);
    }};
    const observer: CompactionExperiment = {id: "observer", async run(input) {
        events.push("next-trial");
        return resultFor(input, goodSummary);
    }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate, observer], timeoutMs: 15}).run();
    assert.deepEqual(events, ["cleanup-start", "cleanup-finished", "next-trial"]);
    assert.ok(report.trials[1]!.durationMs >= 35);
    assert.equal(report.trials[1]!.cleanupComplete, true);
});

test("an uncooperative adapter stops evaluation instead of contaminating subsequent timings", async () => {
    const fixture = await checkedFixture();
    let laterStarted = false;
    const candidate: CompactionExperiment = {id: "never-settles", run() { return new Promise(() => {}); }};
    const observer: CompactionExperiment = {id: "observer", async run(input) {
        laterStarted = true;
        return resultFor(input, goodSummary);
    }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate, observer], timeoutMs: 10}).run();
    assert.equal(laterStarted, false);
    assert.equal(report.trials[1]!.cleanupComplete, false);
    assert.match(report.interrupted!, /contaminated/);
    assert.equal(report.comparisons[1]!.pairedMedianSpeedup, null);
    assert.equal(report.comparisons[1]!.conclusion, "failed-checks");
});

test("a candidate cannot silently switch models or contaminate later baseline trials", async () => {
    const fixture = await checkedFixture();
    const candidate: CompactionExperiment = {id: "switches-model", async run(input) {
        input.model.id = "different-model";
        return stockCompaction.run(input);
    }};
    const report = await evaluation({fixtures: [fixture], experiments: [stockCompaction, candidate], repetitions: 2}).run();
    assert.ok(report.trials.filter((trial) => trial.experiment === "switches-model")
        .every((trial) => /changed the model/.test(trial.error ?? "")));
    assert.ok(report.trials.filter((trial) => trial.experiment === "stock").every((trial) => !trial.error));
    assert.equal(model.id, "synthetic");
});

test("length-limited stock summaries are failures, not quality or speed wins", async () => {
    const fixture = await checkedFixture();
    const report = await evaluation({fixtures: [fixture], stream: () => reply("Incomplete", "length")}).run();
    assert.match(report.trials[0]!.error!, /incomplete/);
    assert.equal(report.trials[0]!.summary, undefined);
    assert.equal(report.trials[0]!.calls[0]!.stopReason, "length");
});

test("tool-tail fixture demonstrates evidence stock serialization does not give the summarizer", async () => {
    const fixture = compactionFixtures.find((entry) => entry.id === "tool-result-tail")!;
    let observed = "";
    const report = await evaluation({fixtures: [fixture], stream: (_model, context) => {
        observed = JSON.stringify(context);
        return reply("A query test failed. The bug remains unfixed.");
    }}).run();
    assert.doesNotMatch(observed, /QUERY-482/);
    assert.match(observed, /characters truncated/);
    assert.equal(report.trials[0]!.checks[0]!.passed, false);
});

test("CLI defaults are offline and reject accidental or malformed live parameters", () => {
    assert.equal(parseArguments([]).live, false);
    assert.equal(parseArguments(["--live", "--model", "provider/model"]).model, "provider/model");
    assert.throws(() => parseArguments(["--repetitions", "0"]), /positive/);
    assert.throws(() => parseArguments(["--thinking", "invented"]), /Invalid thinking/);
    assert.throws(() => parseArguments(["--output"]), /Missing value/);
    assert.throws(() => parseArguments(["--unexpected", "value"]), /Unknown option/);
});

test("CLI smoke report clearly labels synthetic output and validates the installed Pi version", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const stdout = execFileSync(process.execPath, ["--import", "jiti/register", "scripts/evaluate-compaction.ts",
        "--fixture", "split-request", "--repetitions", "1",
        "--candidate", "experiments/compaction/IdentityControl.ts"], {cwd: root, encoding: "utf8"});
    const report = JSON.parse(stdout);
    assert.equal(report.mode, "smoke");
    assert.equal(report.environment.pi, "1.4.0");
    assert.match(report.note, /SMOKE ONLY/);
    assert.equal(report.trials[0].calls.length, 2);
    assert.equal(report.comparisons[0].conclusion, "smoke-only");
    assert.equal(report.comparisons[0].pairedMedianSpeedup, null);
    assert.match(report.environment.candidate.sha256, /^[0-9a-f]{64}$/);
});

function evaluation(overrides: Partial<ConstructorParameters<typeof CompactionEvaluation>[0]> = {}) {
    return new CompactionEvaluation({mode: "live", model, thinkingLevel: "off", stream: () => smokeStream(model),
        fixtures: [], experiments: [stockCompaction], repetitions: 1, timeoutMs: 2000, ...overrides});
}

async function checkedFixture(): Promise<CompactionFixture> {
    const preparation = await compactionFixtures.find((fixture) => fixture.id === "whole-history")!.prepare();
    return {id: "checked", prepare: () => structuredClone(preparation), checks: [check],
        reviewQuestions: ["Is the migration protected, not merely mentioned?"]};
}

function resultFor(input: CompactionExperimentInput, summary: string) {
    const modifiedFiles = [...new Set([...input.preparation.fileOps.written, ...input.preparation.fileOps.edited])].sort();
    return {summary, firstKeptEntryId: input.preparation.firstKeptEntryId, tokensBefore: input.preparation.tokensBefore,
        details: {modifiedFiles, readFiles: [...input.preparation.fileOps.read].filter((file) => !modifiedFiles.includes(file)).sort()}};
}

function message(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
    return {role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{type: "text", text}], stopReason, timestamp: Date.now(),
        usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
}

function reply(text: string, reason: "stop" | "length" = "stop") {
    const stream = createAssistantMessageEventStream();
    stream.push({type: "done", reason, message: message(text, reason)});
    return stream;
}
