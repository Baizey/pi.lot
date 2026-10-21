import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {
    CatalogueSubagentModelPerformanceRanker,
    SubagentModelResolver,
    type SubagentModel,
    type SubagentModelPerformanceRanker,
} from "../src/subagents/SubagentModelResolver.js";
import {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "../src/subagents/SubagentReasoning.js";

class FixedPerformanceRanker implements SubagentModelPerformanceRanker {
    readonly source = "test-performance";

    constructor(private readonly scores: Readonly<Record<string, number>>) {
    }

    async rank(models: readonly SubagentModel[]) {
        return models.map((model) => ({model, score: this.scores[model.id]!}));
    }
}

test("catalogue ranking applies cost, thinking capacity, context, and output limits in order", async () => {
    const nonReasoning = model("non-reasoning", 1, {reasoning: false, contextWindow: 1_000_000});
    const restricted = model("restricted", 1, {
        thinkingLevelMap: {off: null, minimal: null, xhigh: null, max: null},
        contextWindow: 1_000_000,
    });
    const normal = model("normal", 1);
    const tied = model("tied", 1, {provider: "other"});
    const extended = model("extended", 1, {thinkingLevelMap: {xhigh: "xhigh", max: null}});
    const largerContext = model("larger-context", 1, {
        thinkingLevelMap: {max: "max"},
        contextWindow: 256_000,
    });
    const largerOutput = model("larger-output", 1, {
        thinkingLevelMap: {max: "max"},
        contextWindow: 256_000,
        maxTokens: 64_000,
    });
    const expensive = model("expensive", 2, {reasoning: false});
    const models = Object.freeze([
        largerOutput, tied, expensive, restricted, extended, nonReasoning, largerContext, normal,
    ]);
    const ranked = await new CatalogueSubagentModelPerformanceRanker().rank(models);

    assert.deepEqual(ranked.map(({score}) => score), [5, 2, 6, 1, 3, 0, 4, 2]);
    for (const [index, entry] of ranked.entries()) assert.equal(entry.model, models[index]);
});

test("catalogue ranking selects the highest applicable cost tier and clamps negative rates", async () => {
    const tiered = model("tiered", 5, {
        cost: {
            input: 1, output: 5, cacheRead: 0, cacheWrite: 0,
            tiers: [
                {inputTokensAbove: 50_000, input: 3, output: 15, cacheRead: 0, cacheWrite: 0},
                {inputTokensAbove: 100_000, input: 100, output: 500, cacheRead: 0, cacheWrite: 0},
                {inputTokensAbove: 20_000, input: 2, output: 10, cacheRead: 0, cacheWrite: 0},
            ],
        },
    });
    const boundary = model("boundary", 5, {
        cost: {
            input: 1, output: 5, cacheRead: 0, cacheWrite: 0,
            tiers: [{inputTokensAbove: 100_000, input: 100, output: 500, cacheRead: 0, cacheWrite: 0}],
        },
    });
    const models = [tiered, model("free", 0), boundary, model("equivalent-tier", 15), model("negative", -1)];
    const ranked = await new CatalogueSubagentModelPerformanceRanker().rank(models);

    assert.deepEqual(ranked.map(({score}) => score), [2, 0, 1, 2, 0]);
});

test("catalogue ranking recomputes keys when the same model changes between calls", async () => {
    const changing = model("changing", 3);
    const models = [changing, model("steady", 1)];
    const ranker = new CatalogueSubagentModelPerformanceRanker();

    assert.deepEqual((await ranker.rank(models)).map(({score}) => score), [1, 0]);
    changing.cost = {...changing.cost, input: 0, output: 0};
    assert.deepEqual((await ranker.rank(models)).map(({score}) => score), [0, 1]);
    changing.cost = {...models[1]!.cost};
    changing.thinkingLevelMap = {high: null};
    assert.deepEqual((await ranker.rank(models)).map(({score}) => score), [0, 1]);
    changing.thinkingLevelMap = undefined;
    changing.contextWindow = 256_000;
    assert.deepEqual((await ranker.rank(models)).map(({score}) => score), [1, 0]);
});

test("catalogue ranking preserves existing non-finite comparison and score semantics", async () => {
    const ranker = new CatalogueSubagentModelPerformanceRanker();
    const incomparableCosts = [model("nan-cost", NaN), model("finite-cost", 1)];
    assert.deepEqual((await ranker.rank(incomparableCosts)).map(({score}) => score), [0, 0]);

    const incomparableLimits = [
        model("first", 1, {maxTokens: NaN}),
        model("second", 1, {maxTokens: NaN}),
        model("third", 1, {maxTokens: NaN}),
    ];
    assert.deepEqual((await ranker.rank(incomparableLimits)).map(({score}) => score), [0, 1, 2]);
    assert.deepEqual(await ranker.rank([]), []);
    assert.deepEqual(await ranker.rank([incomparableLimits[0]!]), [{model: incomparableLimits[0], score: 0}]);
});

test("reasoning skills select five positions across the available performance-cost frontier", async (t) => {
    const models = [
        model("economy", 1),
        model("small", 2),
        model("balanced", 3),
        model("strong", 4),
        model("maximum", 5),
    ];
    const ranker = new FixedPerformanceRanker({economy: 1, small: 2, balanced: 3, strong: 4, maximum: 5});
    const resolver = new SubagentModelResolver(await runtime(t, models), ranker);

    const expected = new Map([
        [SubagentReasoningSkill.MIN, "economy"],
        [SubagentReasoningSkill.LOW, "small"],
        [SubagentReasoningSkill.MID, "balanced"],
        [SubagentReasoningSkill.HIGH, "strong"],
        [SubagentReasoningSkill.MAX, "maximum"],
    ]);
    for (const [level, modelId] of expected) {
        const resolved = await resolver.resolve(level, SubagentReasoningAmount.MID);
        assert.equal(resolved.model.id, modelId);
        assert.equal(resolved.thinkingLevel, "medium");
        assert.equal(resolved.performanceSource, "test-performance");
    }
});

test("min optimizes cost while max uses replaceable performance evidence", async (t) => {
    const models = [model("cheap", 1), model("benchmark-winner", 3), model("expensive", 8)];
    const resolver = new SubagentModelResolver(
        await runtime(t, models),
        new FixedPerformanceRanker({cheap: 1, "benchmark-winner": 100, expensive: 2}),
    );

    assert.equal(
        (await resolver.resolve(SubagentReasoningSkill.MIN, SubagentReasoningAmount.LOW)).model.id,
        "cheap",
    );
    assert.equal(
        (await resolver.resolve(SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH)).model.id,
        "benchmark-winner",
    );
});

test("an exact skill default bypasses auto ranking and clamps amount after model selection", async (t) => {
    const models = [
        model("automatic-winner", 8, {provider: "provider"}),
        model("configured", 1, {provider: "other"}),
        model("low-only", 2, {provider: "provider", thinkingLevelMap: {high: null}}),
    ];
    const resolver = new SubagentModelResolver(
        await runtime(t, models),
        new FixedPerformanceRanker({"automatic-winner": 100, configured: 1, "low-only": 2}),
    );

    const configured = await resolver.resolve(
        SubagentReasoningSkill.MAX,
        SubagentReasoningAmount.HIGH,
        "other/configured",
    );
    assert.equal(configured.model.id, "configured");
    assert.equal(configured.performanceSource, "configured-exact-model");
    await assert.rejects(
        resolver.resolve(SubagentReasoningSkill.LOW, SubagentReasoningAmount.LOW, "missing/model"),
        /not authenticated or available/,
    );
    const clamped = await resolver.resolve(
        SubagentReasoningSkill.HIGH,
        SubagentReasoningAmount.HIGH,
        "provider/low-only",
    );
    assert.equal(clamped.model.id, "low-only");
    assert.equal(clamped.thinkingLevel, "medium");
});

test("reasoning amount does not affect model selection and unsupported amounts clamp normally", async (t) => {
    const unavailableAtMedium = model("same-model", 1, {
        provider: "preferred",
        thinkingLevelMap: {medium: null},
    });
    const alternative = model("same-model", 1, {provider: "alternative"});
    const resolver = new SubagentModelResolver(
        await runtime(t, [unavailableAtMedium, alternative]),
        new FixedPerformanceRanker({"same-model": 5}),
        "preferred",
    );

    const low = await resolver.resolve(SubagentReasoningSkill.MAX, SubagentReasoningAmount.LOW);
    const mid = await resolver.resolve(SubagentReasoningSkill.MAX, SubagentReasoningAmount.MID);
    const high = await resolver.resolve(SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH);

    assert.equal(low.model.provider, "preferred");
    assert.equal(mid.model.provider, "preferred");
    assert.equal(high.model.provider, "preferred");
    assert.equal(low.model.id, mid.model.id);
    assert.equal(mid.model.id, high.model.id);
    assert.equal(low.thinkingLevel, "low");
    assert.equal(mid.thinkingLevel, "high");
    assert.equal(high.thinkingLevel, "high");
});

test("resolution reads the authenticated catalogue again when availability changes", async (t) => {
    let models = [model("initial", 1)];
    const modelRuntime = await runtime(t, () => models);
    const resolver = new SubagentModelResolver(
        modelRuntime,
        new CatalogueSubagentModelPerformanceRanker(),
    );

    assert.equal(
        (await resolver.resolve(SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH)).model.id,
        "initial",
    );
    models = [model("replacement", 2)];
    assert.equal(
        (await resolver.resolve(SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH)).model.id,
        "replacement",
    );
});

test("resolution fails clearly when no authenticated model supports normal reasoning amounts", async (t) => {
    const resolver = new SubagentModelResolver(await runtime(t, [
        model("non-reasoning", 0, {reasoning: false}),
        model("extended-only", 1, {thinkingLevelMap: {low: null, medium: null, high: null, max: "max"}}),
    ]));

    await assert.rejects(
        resolver.resolve(SubagentReasoningSkill.HIGH, SubagentReasoningAmount.HIGH),
        /No authenticated model supports normal subagent reasoning amounts/,
    );
});

async function runtime(t: TestContext, models: SubagentModel[] | (() => SubagentModel[])): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
        credentials: {
            async read() { return undefined; },
            async list() { return []; },
            async modify() { throw new Error("unexpected credential mutation"); },
            async delete() { throw new Error("unexpected credential deletion"); },
        },
        modelsPath: null,
        refreshOnCreate: false,
    });
    t.mock.method(runtime, "getAvailable", async () => typeof models === "function" ? models() : models);
    return runtime;
}

function model(
    id: string,
    outputCost: number,
    overrides: Partial<SubagentModel> = {},
): SubagentModel {
    return {
        id,
        name: id,
        api: "openai-responses",
        provider: "provider",
        baseUrl: "https://example.test",
        reasoning: true,
        input: ["text"],
        cost: {input: outputCost / 5, output: outputCost, cacheRead: 0, cacheWrite: 0},
        contextWindow: 128_000,
        maxTokens: 32_000,
        ...overrides,
    } as SubagentModel;
}
