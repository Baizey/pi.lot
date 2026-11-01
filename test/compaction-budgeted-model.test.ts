import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {createAssistantMessageEventStream, normalizeContext, type AssistantMessage} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {BudgetedModel} from "../experiments/compaction/BudgetedModel.js";
import type {CompactionModel, CompactionStream} from "../experiments/compaction/CompactionEvaluation.js";
import {smokeModel} from "../scripts/evaluate-compaction.js";

const model = {...smokeModel(), reasoning: true, cost: {input: 1, output: 2, cacheRead: 1, cacheWrite: 1}, maxTokens: 1000};
const limits = {maxCalls: 3, maxCostUsd: 1, maxOutputTokens: 40, thinkingLevel: "low" as const};

async function runtime(t: TestContext, fake: (model: CompactionModel, context: unknown, options: unknown) => ReturnType<typeof createAssistantMessageEventStream>) {
    const instance = await ModelRuntime.create({credentials: {
        async read() { return undefined; }, async list() { return []; },
        async modify() { throw new Error("Unexpected credential mutation"); }, async delete() { throw new Error("Unexpected credential deletion"); },
    }, modelsPath: null, refreshOnCreate: false});
    t.mock.method(instance, "streamSimple", fake as never);
    return instance;
}

function reply(requested: CompactionModel, cost = 0.001, stopReason: "stop" | "error" | "aborted" = "stop",
    input = 20, totalCost = cost, errorMessage = "failed") {
    const stream = createAssistantMessageEventStream();
    const content: AssistantMessage["content"] = stopReason === "stop" ? [{type: "text", text: "ok"}] : [
        {type: "text", text: "PRIVATE_CONTEXT_SECRET"},
        {type: "thinking", thinking: "PRIVATE_THINKING_SECRET"},
        {type: "toolCall", id: "call-1", name: "private_tool", arguments: {secret: "PRIVATE_TOOL_SECRET"}},
    ];
    const message: AssistantMessage = {role: "assistant", api: requested.api, provider: requested.provider, model: requested.id,
        timestamp: 0, stopReason, content,
        usage: {input, output: cost === 0 ? 0 : 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + (cost === 0 ? 0 : 4),
            cost: {input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: totalCost}},
        ...(stopReason !== "stop" ? {errorMessage} : {})};
    if (stopReason !== "stop") Object.assign(message, {privateDiagnostic: "PRIVATE_DIAGNOSTIC_SECRET"});
    if (stopReason === "stop") stream.push({type: "done", reason: "stop", message});
    else stream.push({type: "error", reason: stopReason, error: message});
    return stream;
}

function context() { return normalizeContext({messages: [{role: "user" as const, content: "content", timestamp: 0}]}); }

test("shares concurrent reservations and call cap across phases; caps output and cache retention", async (t) => {
    let invocations = 0;
    const receivedOptions: unknown[] = [];
    const sdk = await runtime(t, (requested, _context, options) => {
        invocations++;
        receivedOptions.push(options);
        return reply(requested);
    });
    const budget = new BudgetedModel(sdk, model, {...limits, maxCalls: 2});
    const first = budget.stream("summary")(model, context(), {maxTokens: 900, maxRetries: 8, reasoning: "low"});
    const second = budget.stream("judge")(model, context(), {maxTokens: 900, maxRetries: 8, reasoning: "low"});
    assert.throws(() => budget.stream("rubric")(model, context(), {reasoning: "low"}), /Maximum provider call count/);
    assert.equal(invocations, 2);
    await Promise.all([(await first).result(), (await second).result()]);
    await new Promise((done) => setImmediate(done));
    const snapshot = budget.snapshot();
    assert.equal(snapshot.calls.length, 2);
    assert.deepEqual(snapshot.calls.map((call) => call.phase), ["summary", "judge"]);
    assert.ok(snapshot.calls.every((call) => call.outputCap === 40 && call.status === "settled"));
    assert.ok(receivedOptions.every((options) => (options as {maxTokens: number; cacheRetention: string; maxRetries: number}).maxTokens === 40 &&
        (options as {cacheRetention: string; maxRetries: number}).cacheRetention === "none" &&
        (options as {maxRetries: number}).maxRetries === 0));
    assert.ok(snapshot.spentUsd > 0);
});

test("concurrent reservations prevent aggregate overspend before either provider settles", async (t) => {
    const sdk = await runtime(t, (requested) => reply(requested));
    const budget = new BudgetedModel(sdk, model, {...limits, maxCostUsd: 0.0007});
    const first = budget.stream("summary")(model, context(), {reasoning: "low"});
    const reservation = budget.snapshot().reservedUsd;
    assert.ok(reservation > 0);
    assert.throws(() => budget.stream("judge")(model, context(), {reasoning: "low"}), /Insufficient remaining cost budget/);
    assert.equal(budget.snapshot().calls.length, 1);
    assert.ok(budget.snapshot().reservedUsd >= reservation);
    await (await first).result();
});

test("OpenAI reasoning reserves the requested response cap instead of the model maximum", async (t) => {
    const sdk = await runtime(t, (requested) => reply(requested, 0.00002));
    const openAiModel = {...model, api: "openai-responses", maxTokens: 128_000,
        cost: {input: 0, output: 1, cacheRead: 0, cacheWrite: 0}};
    const budget = new BudgetedModel(sdk, openAiModel, {...limits, maxCostUsd: 0.0005});
    const response = await budget.stream("summary")(openAiModel, context(), {maxTokens: 40, reasoning: "low"});
    assert.equal(budget.snapshot().calls[0]!.reservedOutputTokens, 40);
    await (await response).result();
});

test("Anthropic and Bedrock reservations include SDK thinking-budget expansion", async (t) => {
    for (const api of ["anthropic-messages", "bedrock-converse-stream"] as const) {
        const sdk = await runtime(t, (requested) => reply(requested, 0.0001));
        const reasoningModel = {...model, api, maxTokens: 1000,
            cost: {input: 0, output: 1, cacheRead: 0, cacheWrite: 0}};
        const budget = new BudgetedModel(sdk, reasoningModel, {...limits, maxCostUsd: 0.001});
        const response = budget.stream("summary")(reasoningModel, context(), {
            maxTokens: 40, reasoning: "low", thinkingBudgets: {low: 500},
        });
        assert.equal(budget.snapshot().calls[0]!.reservedOutputTokens, 540);
        await (await response).result();
    }
});

test("settled success releases reservation and rejects model/reasoning changes", async (t) => {
    const sdk = await runtime(t, (requested) => reply(requested));
    const budget = new BudgetedModel(sdk, model, limits);
    const call = budget.stream("summary")(model, context(), {reasoning: "low"});
    await (await call).result();
    await new Promise((done) => setImmediate(done));
    assert.equal(budget.snapshot().reservedUsd, 0);
    assert.throws(() => budget.stream("summary")({...model, name: "changed"}, context(), {reasoning: "low"}), /changed model/);
    assert.throws(() => budget.stream("summary")(model, context(), {reasoning: "high"}), /thinking level/);
});

test("unknown, zero-usage, failed, and thrown provider responses retain reservation and block future calls", async (t) => {
    for (const variant of ["zero", "inconsistent", "failed", "throw"] as const) {
        let providerCalls = 0;
        const sdk = await runtime(t, (requested) => {
            providerCalls++;
            if (variant === "throw") throw new Error("prompt secret from provider");
            return reply(requested, variant === "zero" ? 0 : 0.001, variant === "failed" ? "error" : "stop",
                variant === "zero" ? 0 : 20, variant === "inconsistent" ? 0 : undefined, "prompt secret from provider");
        });
        const budget = new BudgetedModel(sdk, model, limits);
        if (variant === "throw") {
            assert.throws(() => budget.stream("summary")(model, context(), {reasoning: "low"}),
                (error: Error) => error.message === "Provider request failed" && !error.message.includes("prompt secret"));
        } else {
            const response = await budget.stream("summary")(model, context(), {reasoning: "low"});
            if (variant === "failed") {
                const result = await response.result();
                assert.equal(result.errorMessage, "Provider request failed");
                assert.deepEqual(result.content, []);
                const finalEvent = await response[Symbol.asyncIterator]().next();
                assert.equal(finalEvent.value?.type, "error");
                if (finalEvent.value?.type === "error") {
                    assert.equal(finalEvent.value.error.errorMessage, "Provider request failed");
                    assert.deepEqual(finalEvent.value.error.content, []);
                }
                const exposedFailure = JSON.stringify([result, finalEvent.value]);
                for (const secret of ["PRIVATE_CONTEXT_SECRET", "PRIVATE_THINKING_SECRET", "PRIVATE_TOOL_SECRET", "PRIVATE_DIAGNOSTIC_SECRET"])
                    assert.equal(exposedFailure.includes(secret), false);
            } else await assert.rejects(response.result(), /Provider request failed/);
        }
        const snapshot = budget.snapshot();
        assert.equal(snapshot.calls[0]!.status, "unknown");
        assert.ok(snapshot.reservedUsd > 0);
        assert.match(budget.blockedReason!, /unknown/);
        assert.throws(() => budget.stream("judge")(model, context(), {reasoning: "low"}), /unknown/);
        assert.equal(providerCalls, 1);
        assert.equal(JSON.stringify(snapshot).includes("prompt secret"), false);
    }
});

test("constructor rejects negative and non-finite catalogue rates before provider calls", async (t) => {
    let providerCalls = 0;
    const sdk = await runtime(t, (requested) => {
        providerCalls++;
        return reply(requested);
    });
    assert.throws(() => new BudgetedModel(sdk, {...model, cost: {...model.cost, input: -0.1}}, limits), /finite and non-negative/);
    assert.throws(() => new BudgetedModel(sdk, {...model, cost: {...model.cost,
        tiers: [{input: 0, output: Number.NaN, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 0}]}}, limits), /finite and non-negative/);
    assert.equal(providerCalls, 0);
});

test("constructor owns immutable model/limits and snapshots a sanitized rate card with full usage", async (t) => {
    let providerModel: CompactionModel | undefined;
    let providerOptions: unknown;
    const sdk = await runtime(t, (requested, _context, options) => {
        providerModel = requested;
        providerOptions = options;
        return reply(requested, 0.0001);
    });
    const sourceModel = {...model, baseUrl: "https://private.invalid", cost: {...model.cost}};
    const requestModel = structuredClone(sourceModel);
    const sourceLimits = {...limits};
    const budget = new BudgetedModel(sdk, sourceModel, sourceLimits);
    sourceModel.maxTokens = 1;
    sourceModel.id = "mutated";
    sourceModel.cost.output = 99_999;
    sourceLimits.maxOutputTokens = 1;
    sourceLimits.maxCostUsd = 0.000001;

    const result = budget.stream("summary")(requestModel, context(), {reasoning: "low"});
    await (await result).result();
    await budget.complete("judge")("system", "prompt", new AbortController().signal);
    const snapshot = budget.snapshot();
    assert.equal(snapshot.limits.maxOutputTokens, 40);
    assert.equal(snapshot.limits.maxCostUsd, 1);
    assert.equal(snapshot.modelRateCard.id, model.id);
    assert.equal(snapshot.modelRateCard.maxTokens, 1000);
    assert.equal("baseUrl" in snapshot.modelRateCard, false);
    assert.equal(providerModel?.id, model.id);
    assert.equal((providerOptions as {maxTokens: number}).maxTokens, 40);
    assert.equal(snapshot.calls[1]!.outputCap, 40);
    assert.equal(snapshot.calls[1]!.model, `${model.provider}/${model.id}`);
    assert.deepEqual({input: snapshot.calls[0]!.inputTokens, output: snapshot.calls[0]!.outputTokens,
        total: snapshot.calls[0]!.totalTokens, cacheRead: snapshot.calls[0]!.cacheReadTokens,
        cacheWrite: snapshot.calls[0]!.cacheWriteTokens}, {input: 20, output: 4, total: 24, cacheRead: 0, cacheWrite: 0});
    assert.deepEqual({input: snapshot.calls[0]!.inputCostUsd, output: snapshot.calls[0]!.outputCostUsd,
        cacheRead: snapshot.calls[0]!.cacheReadCostUsd, cacheWrite: snapshot.calls[0]!.cacheWriteCostUsd,
        total: snapshot.calls[0]!.costUsd}, {input: 0, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0001});
    assert.equal(JSON.stringify(snapshot).includes("private.invalid"), false);
});

test("completion sends structured system/user context without recording prompt or secrets", async (t) => {
    let sent: unknown;
    const sdk = await runtime(t, (requested, requestContext) => {
        sent = requestContext;
        return reply(requested);
    });
    const budget = new BudgetedModel(sdk, model, limits);
    await budget.complete("rubric")("system secret", "prompt secret", new AbortController().signal);
    assert.deepEqual((sent as {messages: unknown[]}).messages.map((item) => (item as {role: string}).role), ["system", "user"]);
    const snapshot = budget.snapshot();
    assert.equal(snapshot.calls[0]!.phase, "rubric");
    assert.equal(snapshot.calls[0]!.completion, true);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});
