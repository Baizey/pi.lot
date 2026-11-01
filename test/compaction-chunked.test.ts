import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import type {CompactionPreparation, CompactionStream} from "../experiments/compaction/CompactionEvaluation.js";
import {compactionFixtures} from "../experiments/compaction/CompactionFixtures.js";
import {createChunkedCompaction} from "../experiments/compaction/ChunkedCompaction.js";
import {smokeModel} from "../scripts/evaluate-compaction.js";

const model = smokeModel();
const fixture = compactionFixtures.find((item) => item.id === "whole-history")!;

test("parallel workers preserve chunk request/output ordering and use bounded overlap", async () => {
    const preparation = await fixture.prepare();
    const requested: unknown[] = [];
    let active = 0;
    let maximum = 0;
    const stream: CompactionStream = async (m, context) => {
        const call = requested.length;
        const serialized = JSON.stringify(stable(context));
        requested.push(serialized);
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, call % 2 ? 2 : 8));
        active--;
        return reply(m, `response-${call}`);
    };
    const input = {preparation, model, thinkingLevel: "off" as const, signal: new AbortController().signal, stream};
    const parallel = await createChunkedCompaction({id: "parallel", concurrency: 3, chunkTokens: 1, maxChunks: 100}).run(input);
    const parallelRequests = requested.slice();
    requested.length = 0;
    const sync = await createChunkedCompaction({id: "sync", concurrency: 1, chunkTokens: 1, maxChunks: 100}).run(input);
    assert.ok(maximum > 1);
    assert.deepEqual(requested, parallelRequests);
    assert.equal(parallel.summary, sync.summary);
    const mergedRequest = String(parallelRequests.at(-1));
    let previous = -1;
    for (let index = 0; index < parallelRequests.length - 1; index++) {
        const position = mergedRequest.indexOf(`response-${index}`);
        assert.ok(position > previous, `checkpoint ${index} must follow its predecessor`);
        previous = position;
    }
});

test("multi-call tool spans, interleaved messages, and all results stay in one chunk", async () => {
    const original = await fixture.prepare();
    const assistantMessage = original.messagesToSummarize.find((message) =>
        message.role === "assistant" && message.content.some((part) => part.type === "toolCall"));
    assert.ok(assistantMessage && assistantMessage.role === "assistant");
    const firstCall = assistantMessage.content.find((part) => part.type === "toolCall");
    assert.ok(firstCall && firstCall.type === "toolCall");
    const calls = [firstCall, {...firstCall, id: "tool-two", name: "chunk_tool_two"}];
    const multipleCalls = {...assistantMessage, content: [...assistantMessage.content.filter((part) => part.type !== "toolCall"), ...calls]};
    const nestedCall = {...firstCall, id: "nested-tool", name: "nested_chunk_tool"};
    const nestedAssistant = {...assistantMessage, content: [nestedCall]};
    const span = [multipleCalls,
        {role: "user" as const, content: "INTERLEAVED_USER", timestamp: 1},
        nestedAssistant,
        {role: "toolResult" as const, toolCallId: calls[1]!.id, toolName: calls[1]!.name,
            content: [{type: "text" as const, text: "RESULT_TWO"}], isError: false, timestamp: 2},
        {role: "toolResult" as const, toolCallId: calls[0]!.id, toolName: calls[0]!.name,
            content: [{type: "text" as const, text: "RESULT_ONE"}], isError: false, timestamp: 3},
        {role: "toolResult" as const, toolCallId: calls[0]!.id, toolName: calls[0]!.name,
            content: [{type: "text" as const, text: "RESULT_ONE_DUPLICATE_ID"}], isError: false, timestamp: 4},
        {role: "toolResult" as const, toolCallId: nestedCall.id, toolName: nestedCall.name,
            content: [{type: "text" as const, text: "NESTED_RESULT"}], isError: false, timestamp: 5},
        {role: "user" as const, content: "OUTSIDE_TOOL_SPAN", timestamp: 6},
    ] as CompactionPreparation["messagesToSummarize"];
    const preparation = {...original, messagesToSummarize: span, turnPrefixMessages: []};
    const contexts: string[] = [];
    const stream: CompactionStream = (m, context) => { contexts.push(JSON.stringify(context)); return reply(m, "tool evidence"); };
    const output = await createChunkedCompaction({id: "tools", concurrency: 1, chunkTokens: 1, maxChunks: 10}).run({
        preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream,
    });
    assert.ok(output.summary);
    const maps = contexts.slice(0, -1);
    assert.equal(maps.length, 2);
    const atomicMap = maps.filter((context) => ["chunk_tool_two", "RESULT_TWO", "RESULT_ONE",
        "RESULT_ONE_DUPLICATE_ID", "nested_chunk_tool", "NESTED_RESULT", "INTERLEAVED_USER"]
        .every((marker) => context.includes(marker)));
    assert.equal(atomicMap.length, 1);
    assert.equal(maps.some((context) => context.includes("OUTSIDE_TOOL_SPAN")), true);

    const unresolvedAssistant = {...assistantMessage, content: [
        ...assistantMessage.content.filter((part) => part.type !== "toolCall"),
        {...firstCall, id: "unresolved-id", name: "UNRESOLVED_TOOL"},
    ]};
    const unresolved = {...original, turnPrefixMessages: [], messagesToSummarize: [unresolvedAssistant,
        {role: "user" as const, content: "LATER_USER_A", timestamp: 10},
        {role: "user" as const, content: "LATER_USER_B", timestamp: 11}] as CompactionPreparation["messagesToSummarize"]};
    const unresolvedContexts: string[] = [];
    const result = await createChunkedCompaction({id: "unresolved", concurrency: 1, chunkTokens: 1, maxChunks: 10}).run({
        preparation: unresolved, model, thinkingLevel: "off", signal: new AbortController().signal,
        stream: (m, context) => { unresolvedContexts.push(JSON.stringify(context)); return reply(m, "checkpoint"); },
    });
    assert.ok(result.summary);
    const unresolvedMaps = unresolvedContexts.slice(0, -1);
    assert.equal(unresolvedMaps.length, 3);
    assert.equal(unresolvedMaps.filter((context) => context.includes("UNRESOLVED_TOOL")).length, 1);
    assert.equal(unresolvedMaps.filter((context) => context.includes("LATER_USER_A")).length, 1);
    assert.equal(unresolvedMaps.filter((context) => context.includes("LATER_USER_B")).length, 1);
    assert.ok(unresolvedMaps.every((context) => !context.includes("UNRESOLVED_RESULT_SENTINEL")));
});

test("previous context appears in the first map request only and merge preserves result metadata", async () => {
    const original = await fixture.prepare();
    const preparation = {...original, previousSummary: "PRIOR_CONTEXT_SENTINEL"};
    const preparationBefore = stable(preparation);
    const requests: string[] = [];
    const stream: CompactionStream = (m, context) => {
        requests.push(JSON.stringify(context));
        return reply(m, "chunk checkpoint");
    };
    const result = await createChunkedCompaction({id: "context", concurrency: 2, chunkTokens: 1, maxChunks: 100}).run({
        preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream,
    });
    assert.ok(result.summary);
    assert.ok(requests.length > 2);
    assert.equal(requests.filter((request) => request.includes("PRIOR_CONTEXT_SENTINEL")).length, 1);
    assert.deepEqual(stable(preparation), preparationBefore);
    assert.equal(result.firstKeptEntryId, preparation.firstKeptEntryId);
    assert.equal(result.tokensBefore, preparation.tokensBefore);
    const requestCount = requests.length;
    assert.deepEqual({input: result.usage?.input, output: result.usage?.output,
        cacheRead: result.usage?.cacheRead, cacheWrite: result.usage?.cacheWrite,
        totalTokens: result.usage?.totalTokens}, {input: requestCount * 4, output: requestCount * 2,
        cacheRead: requestCount, cacheWrite: requestCount * 3, totalTokens: requestCount * 10});
    assert.ok(Math.abs(result.usage!.cost.input - requestCount * 0.1) < 1e-10);
    assert.ok(Math.abs(result.usage!.cost.output - requestCount * 0.2) < 1e-10);
    assert.ok(Math.abs(result.usage!.cost.cacheRead - requestCount * 0.3) < 1e-10);
    assert.ok(Math.abs(result.usage!.cost.cacheWrite - requestCount * 0.4) < 1e-10);
    assert.equal(result.usage!.cost.total, requestCount);
    assert.ok(typeof result.details === "object" && result.details !== null &&
        "modifiedFiles" in result.details && Array.isArray(result.details.modifiedFiles) &&
        "readFiles" in result.details && Array.isArray(result.details.readFiles));
    assert.deepEqual(result.details.modifiedFiles.slice().sort(), [...preparation.fileOps.written, ...preparation.fileOps.edited].sort());
    assert.deepEqual(result.details.readFiles.slice().sort(), [...preparation.fileOps.read]
        .filter((file) => !preparation.fileOps.written.has(file) && !preparation.fileOps.edited.has(file)).sort());
});

test("maxChunks is enforced before any request and configuration values are validated", async () => {
    const preparation = await fixture.prepare();
    let calls = 0;
    const stream: CompactionStream = (m) => { calls++; return reply(m, "summary"); };
    await assert.rejects(createChunkedCompaction({id: "limited", concurrency: 1, chunkTokens: 1, maxChunks: 1}).run({
        preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream,
    }), /exceeds maxChunks/);
    assert.equal(calls, 0);
    for (const key of ["concurrency", "chunkTokens", "maxChunks"] as const) {
        assert.throws(() => createChunkedCompaction({id: "bad", concurrency: 1, chunkTokens: 10, maxChunks: 10, [key]: 0}), /positive safe integer/);
    }
    assert.throws(() => createChunkedCompaction({id: "   ", concurrency: 1, chunkTokens: 1, maxChunks: 10}), /id/);
    assert.throws(() => createChunkedCompaction({id: "missing-required-option"} as never), /positive safe integer/);

    const mutableOptions = {id: "snapshotted", concurrency: 1, chunkTokens: 1, maxChunks: 100};
    const experiment = createChunkedCompaction(mutableOptions);
    mutableOptions.maxChunks = 1;
    let snapshotCalls = 0;
    await experiment.run({preparation, model, thinkingLevel: "off", signal: new AbortController().signal,
        stream: (m) => { snapshotCalls++; return reply(m, "summary"); }});
    assert.ok(snapshotCalls > 1);
});

test("peer failures abort active siblings and join their cleanup before rejection", async () => {
    const preparation = await fixture.prepare();
    const bothStarted = deferred();
    let started = 0;
    let cleaned = false;
    const stream: CompactionStream = async (m, _context, options) => {
        const call = ++started;
        if (started === 2) bothStarted.resolve();
        if (call === 1) {
            await bothStarted.promise;
            return reply(m, "provider failed", "error");
        }
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), {once: true}));
        await new Promise((resolve) => setImmediate(resolve));
        cleaned = true;
        return reply(m, "cancelled", "aborted");
    };
    await assert.rejects(createChunkedCompaction({id: "failure", concurrency: 2, chunkTokens: 1, maxChunks: 100}).run({
        preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream,
    }), /provider failed/);
    assert.equal(started, 2);
    assert.equal(cleaned, true);
});

test("external cancellation aborts and joins active workers without starting queued chunks", async () => {
    const preparation = await fixture.prepare();
    const controller = new AbortController();
    let started = 0;
    let cleaned = 0;
    const stream: CompactionStream = async (m, _context, options) => {
        started++;
        if (started === 2) queueMicrotask(() => controller.abort(new Error("external cancellation")));
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), {once: true}));
        await new Promise((resolve) => setImmediate(resolve));
        cleaned++;
        return reply(m, "cancelled", "aborted");
    };
    await assert.rejects(createChunkedCompaction({id: "cancel", concurrency: 2, chunkTokens: 1, maxChunks: 100}).run({
        preparation, model, thinkingLevel: "off", signal: controller.signal, stream,
    }), /external cancellation/);
    assert.equal(started, 2);
    assert.equal(cleaned, 2);
});

test("native responses with length, tool calls, or blank text abort peers and stop queued work", async () => {
    const preparation = await fixture.prepare();
    for (const mode of ["length", "tool", "blank"] as const) {
        let calls = 0;
        const stream: CompactionStream = (m) => {
            calls++;
            if (mode === "length") return reply(m, "partial", "length");
            if (mode === "blank") return reply(m, "  ");
            const response = createAssistantMessageEventStream();
            response.push({type: "done", reason: "stop", message: {...assistant(m, "nonblank text"), content: [
                {type: "text", text: "nonblank text"}, {type: "toolCall", id: "x", name: "tool", arguments: {}},
            ]}});
            return response;
        };
        await assert.rejects(createChunkedCompaction({id: mode, concurrency: 2, chunkTokens: 1, maxChunks: 100}).run({
            preparation, model, thinkingLevel: "off", signal: new AbortController().signal, stream,
        }));
        assert.ok(calls > 0 && calls <= 2, `${mode} must not start queued chunks after failure`);
    }
});

function reply(m: Parameters<CompactionStream>[0], text: string, reason: "stop" | "length" | "error" | "aborted" = "stop") {
    const response = createAssistantMessageEventStream();
    const message = assistant(m, text);
    message.stopReason = reason;
    if (reason === "error" || reason === "aborted") message.errorMessage = text;
    response.push(reason === "error" || reason === "aborted"
        ? {type: "error", reason, error: message}
        : {type: "done", reason, message});
    return response;
}

function assistant(m: Parameters<CompactionStream>[0], text: string): AssistantMessage {
    return {role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: 0,
        stopReason: "stop", content: [{type: "text", text}],
        usage: {input: 4, output: 2, cacheRead: 1, cacheWrite: 3, totalTokens: 10,
            cost: {input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1}}};
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !["timestamp", "sessionId", "signal"].includes(key)).map(([key, item]) => [key, stable(item)]));
    return value;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return {promise, resolve};
}
