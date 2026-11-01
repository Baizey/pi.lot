import test from "node:test";
import assert from "node:assert/strict";
import {compact} from "@earendil-works/pi-coding-agent";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import {fingerprint, type CompactionStream} from "../experiments/compaction/CompactionEvaluation.js";
import parallelSplit from "../experiments/compaction/ParallelSplit.js";
import {compactionFixtures} from "../experiments/compaction/CompactionFixtures.js";
import {smokeModel, smokeStream} from "../scripts/evaluate-compaction.js";

const fixture = compactionFixtures.find((item) => item.id === "split-request")!;
const model = smokeModel();

test("split requests overlap and match native prompts, options, output and metadata", async () => {
    const preparation = await fixture.prepare();
    const stockCalls: unknown[] = [];
    const deterministic: CompactionStream = (m, context, options) => {
        stockCalls.push(stable({m, context, options}));
        return reply(m, requestLabel(context));
    };
    const stock = await compact(preparation, model, undefined, undefined, undefined, new AbortController().signal, "off", deterministic);
    const gate = deferred();
    const calls: unknown[] = [];
    let active = 0;
    let max = 0;
    const stream: CompactionStream = async (m, context, options) => {
        calls.push(stable({m, context, options}));
        max = Math.max(max, ++active);
        if (active === 2) gate.resolve();
        await gate.promise;
        active--;
        return reply(m, requestLabel(context));
    };
    const result = await parallelSplit.run({preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream});
    assert.equal(max, 2);
    assert.deepEqual(calls, stockCalls);
    assert.deepEqual(result, stock);
    assert.match(result.summary, /HISTORY_SUMMARY[\s\S]+PREFIX_SUMMARY/);
    assert.equal(fingerprint(preparation), fingerprint(await fixture.prepare()));
});

test("whole-history and prefix-only compactions retain native single-call fallback", async () => {
    for (const fixtureId of ["whole-history", "split-request"]) {
        const preparation = await compactionFixtures.find((item) => item.id === fixtureId)!.prepare();
        const input = fixtureId === "split-request" ? {...preparation, messagesToSummarize: []} : preparation;
        let calls = 0;
        const stream: CompactionStream = (requestedModel) => { calls++; return smokeStream(requestedModel); };
        const actual = await parallelSplit.run({preparation: input, model, thinkingLevel: "off", signal: new AbortController().signal, stream});
        const expected = await compact(input, model, undefined, undefined, undefined, new AbortController().signal, "off", (requestedModel) => smokeStream(requestedModel));
        assert.equal(calls, 1);
        assert.deepEqual(actual, expected);
    }
});

test("an error response aborts its peer and waits for peer cleanup before rejecting", async () => {
    const preparation = await fixture.prepare();
    const started = deferred();
    let count = 0;
    let siblingCleaned = false;
    let siblingSignal: AbortSignal | undefined;
    const stream: CompactionStream = async (requestedModel, _context, options) => {
        const index = count++;
        if (count === 2) started.resolve();
        if (index === 0) {
            await started.promise;
            return reply(requestedModel, "first worker failed", "error");
        }
        siblingSignal = options!.signal!;
        await new Promise<void>((resolve) => siblingSignal!.addEventListener("abort", () => resolve(), {once: true}));
        await new Promise<void>((resolve) => setImmediate(resolve));
        siblingCleaned = true;
        return reply(requestedModel, "peer aborted", "aborted");
    };
    await assert.rejects(parallelSplit.run({preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream}), /first worker failed/);
    assert.equal(count, 2);
    assert.equal(siblingSignal?.aborted, true);
    assert.equal(siblingCleaned, true);
});

test("external cancellation aborts and joins both active requests", async () => {
    const preparation = await fixture.prepare();
    const controller = new AbortController();
    let started = 0;
    let cleaned = 0;
    const stream: CompactionStream = async (requestedModel, _context, options) => {
        started++;
        if (started === 2) queueMicrotask(() => controller.abort(new Error("outer cancel")));
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), {once: true}));
        await new Promise<void>((resolve) => setImmediate(resolve));
        cleaned++;
        return reply(requestedModel, "outer cancel", "aborted");
    };
    await assert.rejects(parallelSplit.run({preparation, model, thinkingLevel: "off", signal: controller.signal, stream}), /outer cancel/);
    assert.equal(started, 2);
    assert.equal(cleaned, 2);
});

function requestLabel(context: Parameters<CompactionStream>[1]): string {
    return JSON.stringify(context).includes("# Conversation\\n") ? "PREFIX_SUMMARY" : "HISTORY_SUMMARY";
}

function reply(requestedModel: Parameters<CompactionStream>[0], text: string, stopReason: "stop" | "error" | "aborted" = "stop") {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {role: "assistant", api: requestedModel.api, provider: requestedModel.provider,
        model: requestedModel.id, timestamp: 0, stopReason, content: [{type: "text", text}],
        usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        ...(stopReason === "stop" ? {} : {errorMessage: text})};
    if (stopReason === "stop") stream.push({type: "done", reason: "stop", message});
    else stream.push({type: "error", reason: stopReason, error: message});
    return stream;
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !["timestamp", "sessionId", "signal"].includes(key)).map(([key, item]) => [key, stable(item)]));
    return value;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return {promise, resolve}; }
