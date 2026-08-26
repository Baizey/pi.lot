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
    SubagentReasoningLevel,
} from "../src/subagents/SubagentReasoning.js";

class FixedPerformanceRanker implements SubagentModelPerformanceRanker {
    readonly source = "test-performance";

    constructor(private readonly scores: Readonly<Record<string, number>>) {
    }

    async rank(models: readonly SubagentModel[]) {
        return models.map((model) => ({model, score: this.scores[model.id]!}));
    }
}

test("reasoning levels select five positions across the available performance-cost frontier", async () => {
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
        [SubagentReasoningLevel.MIN, "economy"],
        [SubagentReasoningLevel.LOW, "small"],
        [SubagentReasoningLevel.MID, "balanced"],
        [SubagentReasoningLevel.HIGH, "strong"],
        [SubagentReasoningLevel.MAX, "maximum"],
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
        (await resolver.resolve(SubagentReasoningLevel.MIN, SubagentReasoningAmount.LOW)).model.id,
        "cheap",
    );
    assert.equal(
        (await resolver.resolve(SubagentReasoningLevel.MAX, SubagentReasoningAmount.HIGH)).model.id,
        "benchmark-winner",
    );
});

test("resolution filters by exact thinking support and prefers the active provider on ties", async () => {
    const unavailableAtMedium = model("same-model", 1, {
        provider: "preferred",
        thinkingLevelMap: {medium: null},
    });
    const alternative = model("same-model", 1, {provider: "alternative"});
    const preferred = model("other-model", 1, {provider: "preferred"});
    const resolver = new SubagentModelResolver(
        runtime([unavailableAtMedium, alternative, preferred]),
        new FixedPerformanceRanker({"same-model": 5, "other-model": 5}),
        "preferred",
    );

    const resolved = await resolver.resolve(SubagentReasoningLevel.MAX, SubagentReasoningAmount.MID);

    assert.equal(resolved.model.provider, "preferred");
    assert.equal(resolved.model.id, "other-model");
    assert.equal(resolved.thinkingLevel, "medium");
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
        (await resolver.resolve(SubagentReasoningLevel.MAX, SubagentReasoningAmount.HIGH)).model.id,
        "initial",
    );
    models = [model("replacement", 2)];
    assert.equal(
        (await resolver.resolve(SubagentReasoningLevel.MAX, SubagentReasoningAmount.HIGH)).model.id,
        "replacement",
    );
});

test("resolution fails clearly when no authenticated model supports the requested amount", async () => {
    const resolver = new SubagentModelResolver(runtime([
        model("non-reasoning", 0, {reasoning: false}),
        model("low-only", 1, {thinkingLevelMap: {high: null}}),
    ]));

    await assert.rejects(
        resolver.resolve(SubagentReasoningLevel.HIGH, SubagentReasoningAmount.HIGH),
        /No authenticated model supports subagent reasoning amount high/,
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
