import assert from "node:assert/strict";
import test from "node:test";
import {compact, ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createAssistantMessageEventStream, type AssistantMessage, type RetryCallbacks} from "@earendil-works/pi-ai";
import {getModel, registerApiProvider, unregisterApiProviders} from "@earendil-works/pi-ai/compat";
import {ParallelCompaction} from "../src/compaction/ParallelCompaction.js";

type Input = Parameters<typeof compact>;
type Preparation = Input[0];
type Stream = NonNullable<Input[7]>;
type Request = Parameters<Stream>;
const model = getModel("anthropic", "claude-sonnet-4-5");
const parallel = new ParallelCompaction();
const cost = {input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1};

function preparation(overrides: Partial<Preparation> = {}): Preparation {
    return {
        firstKeptEntryId: "kept-entry", isSplitTurn: true, tokensBefore: 98765,
        messagesToSummarize: [
            {role: "user", content: "HISTORY SOURCE: preserve exact old constraint", timestamp: 1},
            {role: "assistant", content: [{type: "thinking", thinking: "DO NOT SERIALIZE THINKING"},
                {type: "toolCall", id: "read", name: "read", arguments: {path: "/project/read.ts"}}],
                api: model.api, provider: model.provider, model: model.id, timestamp: 2, stopReason: "toolUse",
                usage: response(model, 0).usage},
            {role: "toolResult", toolCallId: "read", toolName: "read", isError: false,
                content: [{type: "text", text: "tool output ".repeat(400)}], timestamp: 3},
            {role: "custom", customType: "context", content: "CUSTOM SOURCE", display: true, timestamp: 4},
        ],
        turnPrefixMessages: [{role: "user", content: "PREFIX SOURCE: current user's request", timestamp: 5},
            {role: "bashExecution", command: "pwd", output: "/project", exitCode: 0, cancelled: false, truncated: false, timestamp: 6}],
        fileOps: {read: new Set(["/project/z.ts", "/project/read.ts", "/project/edited.ts"]),
            written: new Set(["/project/new.ts"]), edited: new Set(["/project/edited.ts"])},
        settings: {enabled: true, reserveTokens: 42, keepRecentTokens: 500},
        ...overrides,
    };
}

function response(requested: Request[0], index: number, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
    return {
        role: "assistant", api: requested.api, provider: requested.provider, model: requested.id, timestamp: 0,
        content: [{type: "text", text: index === 0 ? "History checkpoint.\nExact constraint." : "Prefix checkpoint.\nCurrent progress."}],
        stopReason: "stop", usage: {input: 10 + index, output: 5 + index, cacheRead: 3, cacheWrite: 2,
            cacheWrite1h: 1, reasoning: 2, totalTokens: 20 + 2 * index, cost: {...cost}},
        ...overrides,
    };
}

function finished(message: AssistantMessage) {
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    return stream;
}

function input(prepared: Preparation, stream?: Stream): Input {
    return [prepared, model, "caller-api-key", {"x-caller": "header"}, "Keep exact constraints and tool paths",
        undefined, "high", stream, {OFFLINE_AUTH: "caller-env"}, undefined, undefined, "caller-routing-id"];
}

function normalized(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== "timestamp" && key !== "sessionId" && key !== "signal")
        .map(([key, item]) => [key, normalized(item)]));
    return value;
}

function prompt(context: Request[1]): string {
    return context.messages.map((message) => typeof message.content === "string" ? message.content
        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => { resolve = finish; });
    return {promise, resolve};
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("both independent calls overlap; native stock remains sequential and results/requests are identical", {timeout: 3000}, async () => {
    const prepared = preparation();
    const original = structuredClone(prepared);
    const stockRequests: Request[] = [];
    const stockGate = deferred<void>();
    const stockStarted = deferred<void>();
    const stockInput = input(prepared, async (...request) => {
        const index = stockRequests.push(request) - 1;
        if (index === 0) { stockStarted.resolve(); await stockGate.promise; }
        return finished(response(request[0], index));
    });
    const stock = compact(...stockInput);
    await stockStarted.promise;
    await tick();
    assert.equal(stockRequests.length, 1, "stock cannot start prefix before history returns");
    stockGate.resolve();
    const expected = await stock;

    const requests: Request[] = [];
    const bothStarted = deferred<void>();
    const gates = [deferred<void>(), deferred<void>()];
    const actualInput = input(prepared, async (...request) => {
        const index = requests.push(request) - 1;
        if (requests.length === 2) bothStarted.resolve();
        await gates[index]!.promise;
        return finished(response(request[0], index));
    });
    const actual = parallel.run(...actualInput);
    await bothStarted.promise;
    assert.equal(requests.length, 2, "planning/replay never enter the real stream");
    gates[1]!.resolve();
    await tick();
    gates[0]!.resolve();
    assert.deepEqual(await actual, expected, "native assembly includes exact summary, usage and file metadata");
    assert.deepEqual(requests.map(normalized), stockRequests.map(normalized));
    assert.deepEqual(prepared, original, "no preparation or source mutation");
    assert.match(prompt(requests[0]![1]), /HISTORY SOURCE/);
    assert.doesNotMatch(prompt(requests[0]![1]), /PREFIX SOURCE|DO NOT SERIALIZE THINKING/);
    assert.match(prompt(requests[0]![1]), /CUSTOM SOURCE|truncated/);
    assert.match(prompt(requests[1]![1]), /PREFIX SOURCE/);
    assert.doesNotMatch(prompt(requests[1]![1]), /HISTORY SOURCE/);
    for (const request of requests) {
        assert.equal(request[0], model);
        assert.equal(request[2]?.apiKey, actualInput[2]);
        assert.equal(request[2]?.headers, actualInput[3]);
        assert.equal(request[2]?.env, actualInput[8]);
        assert.equal(request[2]?.sessionId, actualInput[11]);
        assert.equal(request[2]?.cacheRetention, "none");
        assert.equal(request[2]?.reasoning, "high");
        assert.equal(request[2]?.maxTokens, undefined, "do not invent an output cap from reserveTokens");
        assert.match(prompt(request[1]), /Additional focus: Keep exact constraints and tool paths/);
    }
    assert.deepEqual(expected.details, {readFiles: ["/project/read.ts", "/project/z.ts"],
        modifiedFiles: ["/project/edited.ts", "/project/new.ts"]});
    assert.equal(expected.usage?.totalTokens, 42);
    assert.equal(expected.usage?.cacheWrite1h, 2);
    assert.equal(expected.usage?.reasoning, 4);
});

for (const scenario of ["single", "empty-history", "empty-prefix", "both-empty", "iterative-single", "iterative-empty-history"] as const) {
    test(`${scenario} delegates unchanged to the exact native single-request path`, async () => {
        const prepared = preparation({isSplitTurn: scenario !== "single" && scenario !== "iterative-single",
            ...(scenario.includes("history") || scenario === "both-empty" ? {messagesToSummarize: []} : {}),
            ...(scenario === "empty-prefix" || scenario === "both-empty" ? {turnPrefixMessages: []} : {}),
            ...(scenario.startsWith("iterative") ? {previousSummary: "PREVIOUS SUMMARY"} : {})});
        const controller = new AbortController();
        const requests: Request[][] = [[], []];
        const results = [];
        for (const [index, run] of [compact, parallel.run.bind(parallel)].entries()) {
            const args = input(prepared, (...request) => {
                requests[index]!.push(request);
                assert.equal(request[2]?.signal, controller.signal, "fallback does not substitute a signal or stream options");
                return finished(response(request[0], 0));
            });
            args[5] = controller.signal;
            results.push(await run(...args));
        }
        assert.deepEqual(results[1], results[0]);
        assert.equal(requests[1]!.length, 1);
        assert.deepEqual(requests[1]!.map(normalized), requests[0]!.map(normalized));
    });
}

test("planning failure makes zero real calls", async () => {
    let calls = 0;
    await assert.rejects(parallel.run(...input(preparation({firstKeptEntryId: ""}), (...request) => {
        calls++;
        return finished(response(request[0], 0));
    })), /First kept entry has no UUID/);
    assert.equal(calls, 0);
});

for (const thinking of [undefined, "off", "low", "xhigh"] as const) {
    test(`iterative split preserves native prompts and caller thinking=${thinking}`, async () => {
        const prepared = preparation({previousSummary: "PREVIOUS SUMMARY: prior goals and files"});
        const requests: Request[][] = [[], []];
        const results = [];
        for (const [index, run] of [compact, parallel.run.bind(parallel)].entries()) {
            const args = input(prepared, (...request) => {
                const order = requests[index]!.push(request) - 1;
                return finished(response(request[0], order));
            });
            args[6] = thinking;
            results.push(await run(...args));
        }
        assert.deepEqual(results[1], results[0]);
        assert.deepEqual(requests[1]!.map(normalized), requests[0]!.map(normalized));
        assert.match(prompt(requests[1]![0]![1]), /<previous-summary>\nPREVIOUS SUMMARY/);
        assert.doesNotMatch(prompt(requests[1]![1]![1]), /PREVIOUS SUMMARY/);
        assert.ok(requests[1]!.every((request) => request[2]?.reasoning === (thinking === "off" ? undefined : thinking)));
    });
}

for (const retry of [undefined, {enabled: false, maxRetries: 4, baseDelayMs: 29, maxAgentDelayMs: 0},
    {enabled: true, maxRetries: 0, baseDelayMs: 29, maxAgentDelayMs: 0},
    {enabled: true, maxRetries: 2, baseDelayMs: 29, maxAgentDelayMs: 0}]) {
    test(`native retry policy preserved: ${JSON.stringify(retry)}`, async () => {
        const requests: Request[] = [];
        const events: unknown[][] = [];
        const callbacks: RetryCallbacks = {
            onRetryScheduled: (...args) => { events.push(["scheduled", ...args]); },
            onRetryAttemptStart: () => { events.push(["start"]); },
            onRetryFinished: (...args) => { events.push(["finished", ...args]); },
        };
        let historyAttempts = 0;
        const args = input(preparation(), (...request) => {
            requests.push(request);
            const history = prompt(request[1]).includes("HISTORY SOURCE");
            if (history && ++historyAttempts < 3) return finished(response(request[0], 0,
                {stopReason: "error", errorMessage: "terminated"}));
            return finished(response(request[0], history ? 0 : 1));
        });
        args[9] = retry;
        args[10] = callbacks;
        args[11] = undefined;
        if (retry?.enabled && retry.maxRetries === 2) {
            await parallel.run(...args);
            assert.equal(historyAttempts, 3);
            assert.deepEqual(events, [["scheduled", 1, 2, 0, "terminated"], ["start"],
                ["scheduled", 2, 2, 0, "terminated"], ["start"], ["finished", true, 2]]);
            const historyRequests = requests.filter((request) => prompt(request[1]).includes("HISTORY SOURCE"));
            assert.equal(new Set(historyRequests.map((request) => request[2]?.sessionId)).size, 1, "retry retains native routing id");
            assert.equal(requests.length, 4, "only the failed branch retries; planning and replay do not call providers");
        } else {
            await assert.rejects(parallel.run(...args), /Summarization failed: terminated/);
            assert.equal(historyAttempts, 1);
            assert.deepEqual(events, []);
            assert.equal(requests.length, 2);
        }
        assert.ok(requests.every((request) => typeof request[2]?.sessionId === "string" && request[2].cacheRetention === "none"));
    });
}

const failures: Array<[string, Partial<AssistantMessage>, RegExp]> = [
    ["deterministic error", {stopReason: "error", errorMessage: "insufficient_quota billing exhausted"}, /failed: insufficient_quota/],
    ["toolcall", {stopReason: "toolUse", content: [{type: "text", text: "partial"},
        {type: "toolCall", id: "invalid", name: "read", arguments: {}}]}, /attempted to call a tool/],
    ["length", {stopReason: "length"}, /token cap/],
    ["blank", {content: [{type: "text", text: " \n\t "}]}, /summary was empty/],
    ["thinking-only", {content: [{type: "thinking", thinking: "not a summary"}]}, /summary was empty/],
    ["aborted", {stopReason: "aborted"}, /invalid stop reason aborted/],
    ["pending", {stopReason: "pending"}, /invalid stop reason pending/],
    ["blank-tool-use", {stopReason: "toolUse", content: []}, /invalid stop reason toolUse/],
];
for (const [name, invalid, error] of failures) {
    for (const failingBranch of [0, 1]) {
        test(`${name} in branch ${failingBranch} aborts AND joins sibling without retry`, {timeout: 3000}, async () => {
            const bothStarted = deferred<void>();
            const fail = deferred<void>();
            const aborted = deferred<void>();
            const releasePeer = deferred<void>();
            let calls = 0;
            let peerFinished = false;
            let returned = false;
            let retries = 0;
            const args = input(preparation(), async (...request) => {
                const index = calls++;
                if (calls === 2) bothStarted.resolve();
                if (index === failingBranch) {
                    await fail.promise;
                    return finished(response(request[0], index, invalid));
                }
                request[2]!.signal!.addEventListener("abort", () => { aborted.resolve(); }, {once: true});
                await releasePeer.promise;
                peerFinished = true;
                return finished(response(request[0], index));
            });
            args[9] = {enabled: true, maxRetries: 3, baseDelayMs: 0, maxAgentDelayMs: 0};
            args[10] = {onRetryScheduled: () => { retries++; }};
            const result = parallel.run(...args).finally(() => { returned = true; });
            const rejected = assert.rejects(result, error);
            await bothStarted.promise;
            fail.resolve();
            await aborted.promise;
            await tick();
            assert.equal(returned, false, "logical failure must wait for physical peer cleanup");
            assert.equal(peerFinished, false);
            releasePeer.resolve();
            await rejected;
            assert.equal(peerFinished, true);
            assert.equal(calls, 2);
            assert.equal(retries, 0);
        });
    }
}

test("pre-aborted split never plans or calls a provider", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller preabort"));
    let calls = 0;
    const args = input(preparation(), (...request) => { calls++; return finished(response(request[0], 0)); });
    args[5] = controller.signal;
    await assert.rejects(parallel.run(...args), /caller preabort/);
    assert.equal(calls, 0);
});

test("caller mid-abort signals and joins BOTH in-flight calls, even if they return successful text", {timeout: 3000}, async () => {
    const controller = new AbortController();
    const bothStarted = deferred<void>();
    const gates = [deferred<void>(), deferred<void>()];
    let started = 0;
    let aborted = 0;
    let finishedCalls = 0;
    let returned = false;
    const args = input(preparation(), async (...request) => {
        const index = started++;
        request[2]!.signal!.addEventListener("abort", () => { aborted++; }, {once: true});
        if (started === 2) bothStarted.resolve();
        await gates[index]!.promise;
        finishedCalls++;
        return finished(response(request[0], index));
    });
    args[5] = controller.signal;
    const result = parallel.run(...args).finally(() => { returned = true; });
    const rejected = assert.rejects(result, /caller midabort/);
    await bothStarted.promise;
    controller.abort(new Error("caller midabort"));
    assert.equal(aborted, 2);
    gates[0]!.resolve();
    await tick();
    assert.equal(returned, false);
    gates[1]!.resolve();
    await rejected;
    assert.equal(finishedCalls, 2);
});

for (const failure of ["stream-promise", "stream-result"] as const) {
    test(`${failure} rejection also aborts and joins a sibling`, {timeout: 3000}, async (t) => {
        const bothStarted = deferred<void>();
        const fail = deferred<void>();
        const aborted = deferred<void>();
        const release = deferred<void>();
        let calls = 0;
        let returned = false;
        const args = input(preparation(), async (...request) => {
            const index = calls++;
            if (calls === 2) bothStarted.resolve();
            if (index === 0) {
                await fail.promise;
                if (failure === "stream-promise") throw new Error("stream threw");
                const stream = createAssistantMessageEventStream();
                t.mock.method(stream, "result", async () => { throw new Error("stream threw"); });
                return stream;
            }
            request[2]!.signal!.addEventListener("abort", () => { aborted.resolve(); }, {once: true});
            await release.promise;
            return finished(response(request[0], index));
        });
        const result = parallel.run(...args).finally(() => { returned = true; });
        const rejected = assert.rejects(result, /stream threw/);
        await bothStarted.promise;
        fail.resolve();
        await aborted.promise;
        await tick();
        assert.equal(returned, false);
        release.resolve();
        await rejected;
    });
}

test("abort during native retry backoff joins callbacks and does not launch another attempt", {timeout: 3000}, async () => {
    const controller = new AbortController();
    const scheduled = deferred<void>();
    const events: string[] = [];
    let calls = 0;
    const args = input(preparation(), (...request) => {
        calls++;
        return finished(response(request[0], 0, {stopReason: "error", errorMessage: "terminated"}));
    });
    args[5] = controller.signal;
    args[9] = {enabled: true, maxRetries: 5, baseDelayMs: 10000, maxAgentDelayMs: 10000};
    args[10] = {onRetryScheduled: () => { events.push("scheduled"); scheduled.resolve(); },
        onRetryAttemptStart: () => { events.push("start"); }, onRetryFinished: () => { events.push("finished"); }};
    const result = parallel.run(...args);
    const rejected = assert.rejects(result, /cancel backoff/);
    await scheduled.promise;
    controller.abort(new Error("cancel backoff"));
    await rejected;
    assert.equal(calls, 2);
    assert.deepEqual(events, ["scheduled", "scheduled", "finished", "finished"]);
});

test("replay rejects changed source data instead of making additional provider calls", async () => {
    const prepared = preparation();
    let calls = 0;
    const args = input(prepared, (...request) => {
        calls++;
        if (calls === 2) prepared.messagesToSummarize.push({role: "user", content: "unexpected mutation", timestamp: 99});
        return finished(response(request[0], calls - 1));
    });
    await assert.rejects(parallel.run(...args), /replay request 1 differed/);
    assert.equal(calls, 2);
});

test("no supplied stream uses the native public completeSimple dispatch, with native cache/auth/options", async (t) => {
    const sourceId = "pilot-parallel-compaction-offline";
    const requests: Request[] = [];
    registerApiProvider({api: model.api,
        stream: () => { throw new Error("must use streamSimple"); },
        streamSimple: (...request) => {
            const index = requests.push(request) - 1;
            return finished(response(request[0], index));
        }}, sourceId);
    t.after(() => { unregisterApiProviders(sourceId); });
    const args = input(preparation());
    const expected = await compact(...args);
    const stockRequests = requests.splice(0);
    const result = await parallel.run(...args);
    assert.equal(requests.length, 2);
    assert.deepEqual(result, expected);
    assert.deepEqual(requests.map(normalized), stockRequests.map(normalized));
    assert.equal(result.usage?.totalTokens, 42);
    assert.ok(requests.every((request) => request[2]?.cacheRetention === "none"
        && request[2]?.sessionId === "caller-routing-id" && request[2]?.apiKey === "caller-api-key"));
});

for (const virtual of [false, true]) {
    test(`public supplied ${virtual ? "virtual" : "physical"} runtime stream preserves dispatch/auth/thinking and native result`, async () => {
        const runtime = await ModelRuntime.create({
            credentials: {async read() { return undefined; }, async list() { return []; },
                async modify() { throw new Error("no credential writes"); }, async delete() { throw new Error("no credential deletes"); }},
            modelsPath: null, refreshOnCreate: false,
        });
        const requests: Request[] = [];
        const routes: string[] = [];
        runtime.registerProvider("parallel-offline", {
            apiKey: "runtime-key", api: "openai-responses", baseUrl: "https://offline.invalid",
            models: [{id: "physical", name: "Offline physical", reasoning: true, input: ["text"], cost,
                contextWindow: 100000, maxTokens: 8192}],
            streamSimple: (...request) => {
                const index = prompt(request[1]).includes("HISTORY SOURCE") ? 0 : 1;
                requests.push(request);
                return finished(response(request[0], index));
            },
        });
        const physical = runtime.getModel("parallel-offline", "physical");
        assert.ok(physical);
        if (virtual) runtime.registerVirtualModel({provider: "parallel-offline", id: "router", name: "Offline router",
            thinkingLevels: ["off", "high"], route: (request) => {
                routes.push(request.reason);
                return {model: physical, thinkingLevel: "low"};
            }});
        const selected = runtime.getModel("parallel-offline", virtual ? "router" : "physical");
        assert.ok(selected);
        const args = input(preparation(), (requested, context, options) => runtime.streamSimple(requested, context, options));
        args[1] = selected;
        args[2] = undefined;
        const expected = await compact(...args);
        const stockRequests = requests.splice(0);
        routes.length = 0;
        assert.deepEqual(await parallel.run(...args), expected);
        assert.equal(requests.length, 2, "no planning/replay provider dispatch or virtual route");
        assert.deepEqual(requests.map(normalized), stockRequests.map(normalized));
        assert.ok(requests.every((request) => request[0].id === "physical" && request[2]?.apiKey === "runtime-key"
            && request[2]?.reasoning === (virtual ? "low" : "high") && request[2]?.sessionId === "caller-routing-id"
            && request[2]?.cacheRetention === "none"));
        assert.deepEqual(routes, virtual ? ["direct", "direct"] : []);
    });
}
