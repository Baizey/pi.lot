import assert from "node:assert/strict";
import test from "node:test";
import type {ModelRuntime} from "@earendil-works/pi-coding-agent";
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

test("reasoning skills select five positions across the available performance-cost frontier", async () => {
    const models = [
        model("economy", 1),
        model("small", 2),
        model("balanced", 3),
        model("strong", 4),
        model("maximum", 5),
    ];
    const ranker = new FixedPerformanceRanker({economy: 1, small: 2, balanced: 3, strong: 4, maximum: 5});
    const resolver = new SubagentModelResolver(runtime(models), ranker);

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

test("min optimizes cost while max uses replaceable performance evidence", async () => {
    const models = [model("cheap", 1), model("benchmark-winner", 3), model("expensive", 8)];
    const resolver = new SubagentModelResolver(
        runtime(models),
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

test("an exact skill default bypasses auto ranking and clamps amount after model selection", async () => {
    const models = [
        model("automatic-winner", 8, {provider: "provider"}),
        model("configured", 1, {provider: "other"}),
        model("low-only", 2, {provider: "provider", thinkingLevelMap: {high: null}}),
    ];
    const resolver = new SubagentModelResolver(
        runtime(models),
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

test("reasoning amount does not affect model selection and unsupported amounts clamp normally", async () => {
    const unavailableAtMedium = model("same-model", 1, {
        provider: "preferred",
        thinkingLevelMap: {medium: null},
    });
    const alternative = model("same-model", 1, {provider: "alternative"});
    const resolver = new SubagentModelResolver(
        runtime([unavailableAtMedium, alternative]),
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

test("resolution reads the authenticated catalogue again when availability changes", async () => {
    let models = [model("initial", 1)];
    const modelRuntime = {
        async getAvailable() {
            return models;
        },
    } as unknown as Pick<ModelRuntime, "getAvailable">;
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

test("resolution fails clearly when no authenticated model supports normal reasoning amounts", async () => {
    const resolver = new SubagentModelResolver(runtime([
        model("non-reasoning", 0, {reasoning: false}),
        model("extended-only", 1, {thinkingLevelMap: {low: null, medium: null, high: null, max: "max"}}),
    ]));

    await assert.rejects(
        resolver.resolve(SubagentReasoningSkill.HIGH, SubagentReasoningAmount.HIGH),
        /No authenticated model supports normal subagent reasoning amounts/,
    );
});

function runtime(models: SubagentModel[]): Pick<ModelRuntime, "getAvailable"> {
    return {
        async getAvailable() {
            return models;
        },
    } as unknown as Pick<ModelRuntime, "getAvailable">;
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
