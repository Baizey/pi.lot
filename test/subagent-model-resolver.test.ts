import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {
    CatalogueSubagentModelPerformanceRanker,
    SubagentModelResolver,
    type SubagentModel,
    type SubagentModelPerformanceRanker,
} from "../src/subagents/SubagentModelResolver.js";
import {
    initialSubagentDefaults,
    SubagentDefaultsJsonStore,
    SubagentDefaultsRuntime,
} from "../src/subagents/SubagentDefaults.js";
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
    const ranker = new FixedPerformanceRanker({"automatic-winner": 100, configured: 1, "low-only": 2});
    const rank = t.mock.method(ranker, "rank", async () => {
        throw new Error("exact pins must bypass auto ranking");
    });
    const resolver = new SubagentModelResolver(await runtime(t, models), ranker);

    const configured = await resolver.resolve(
        SubagentReasoningSkill.MAX,
        SubagentReasoningAmount.HIGH,
        "other/configured",
    );
    assert.equal(configured.model.id, "configured");
    assert.equal(configured.performanceSource, "configured-exact-model");
    const clamped = await resolver.resolve(
        SubagentReasoningSkill.HIGH,
        SubagentReasoningAmount.HIGH,
        "provider/low-only",
    );
    assert.equal(clamped.model.id, "low-only");
    assert.equal(clamped.thinkingLevel, "medium");
    assert.equal(clamped.performanceSource, "configured-exact-model");
    assert.equal(rank.mock.callCount(), 0);
});

test("missing pins use the existing auto frontier for every requested skill with visible fallback metadata", async (t) => {
    const models = [model("economy", 1), model("small", 2), model("balanced", 3), model("strong", 4), model("maximum", 5)];
    let availabilityReads = 0;
    const resolver = new SubagentModelResolver(
        await runtime(t, () => {
            availabilityReads++;
            return models;
        }),
        new FixedPerformanceRanker({economy: 1, small: 2, balanced: 3, strong: 4, maximum: 5}),
    );

    for (const skill of Object.values(SubagentReasoningSkill)) {
        const automatic = await resolver.resolve(skill, SubagentReasoningAmount.MID);
        const readsBeforeFallback = availabilityReads;
        const fallback = await resolver.resolve(skill, SubagentReasoningAmount.MID, "missing/pinned");
        assert.equal(availabilityReads, readsBeforeFallback + 1);
        assert.equal(fallback.model, automatic.model);
        assert.equal(fallback.thinkingLevel, automatic.thinkingLevel);
        assert.equal(fallback.estimatedCost, automatic.estimatedCost);
        assert.equal(fallback.performanceScore, automatic.performanceScore);
        assert.equal(
            fallback.performanceSource,
            "test-performance (auto fallback from missing/pinned: not authenticated or available)",
        );
    }
});

test("a catalogued but unauthenticated pin falls back without probing providers", async (t) => {
    const pinned = model("pinned", 1, {provider: "unauthenticated"});
    const authenticated = model("authenticated", 2);
    const modelRuntime = await runtime(t, [authenticated]);
    t.mock.method(modelRuntime, "getModel", () => pinned);
    const auth = t.mock.method(modelRuntime, "getAuth", async () => {
        throw new Error("resolution must not request provider credentials");
    });
    const refresh = t.mock.method(modelRuntime, "refresh", async () => {
        throw new Error("resolution must not refresh provider catalogues");
    });
    const resolver = new SubagentModelResolver(modelRuntime);

    const fallback = await resolver.resolve(
        SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH, "unauthenticated/pinned",
    );
    assert.equal(fallback.model, authenticated);
    assert.equal(
        fallback.performanceSource,
        "catalogue-cost-capability (auto fallback from unauthenticated/pinned: not authenticated or available)",
    );
    assert.equal(auth.mock.callCount(), 0);
    assert.equal(refresh.mock.callCount(), 0);
});

test("pins no longer eligible for normal reasoning fall back and clamp the selected model's amount", async (t) => {
    for (const pinned of [
        model("non-reasoning", 10, {reasoning: false}),
        model("extended-only", 10, {thinkingLevelMap: {low: null, medium: null, high: null, max: "max"}}),
    ]) {
        const eligible = model("medium-only", 1, {thinkingLevelMap: {low: null, high: null}});
        const ranker = new FixedPerformanceRanker({"medium-only": 1});
        const rank = t.mock.method(ranker, "rank");
        const resolver = new SubagentModelResolver(await runtime(t, [pinned, eligible]), ranker);
        const fallback = await resolver.resolve(
            SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH, `provider/${pinned.id}`,
        );

        assert.equal(fallback.model, eligible);
        assert.equal(fallback.thinkingLevel, "medium");
        assert.deepEqual(rank.mock.calls[0]!.arguments[0], [eligible]);
        assert.equal(
            fallback.performanceSource,
            `test-performance (auto fallback from provider/${pinned.id}: does not support normal reasoning amounts)`,
        );
    }
});

test("fallback preserves the saved preference and uses the exact pin again when availability recovers", async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "pilot-model-preference-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const store = new SubagentDefaultsJsonStore("subagent-defaults", directory);
    store.save({...initialSubagentDefaults, max: "provider/pinned"});
    const saved = readFileSync(store.file, "utf8");
    const defaults = new SubagentDefaultsRuntime(store);
    const pinned = model("pinned", 1);
    const alternative = model("alternative", 2);
    let available = [alternative];
    const resolver = new SubagentModelResolver(await runtime(t, () => available));

    const fallback = await resolver.resolve(
        SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH, defaults.values.max,
    );
    assert.equal(fallback.model, alternative);
    assert.equal(defaults.values.max, "provider/pinned");
    assert.equal(readFileSync(store.file, "utf8"), saved);
    assert.equal(store.load().max, "provider/pinned");

    available = [alternative, pinned];
    const recovered = await resolver.resolve(
        SubagentReasoningSkill.MAX, SubagentReasoningAmount.HIGH, defaults.values.max,
    );
    assert.equal(recovered.model, pinned);
    assert.equal(recovered.performanceSource, "configured-exact-model");
    assert.equal(readFileSync(store.file, "utf8"), saved);
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

    for (const preference of ["auto", "missing/model", "provider/non-reasoning", "provider/extended-only"]) {
        await assert.rejects(
            resolver.resolve(SubagentReasoningSkill.HIGH, SubagentReasoningAmount.HIGH, preference),
            (error: Error) => {
                assert.match(error.message, /No authenticated model supports normal subagent reasoning amounts/);
                if (preference !== "auto") assert.match(error.message, new RegExp(`cannot fall back from configured model ${preference}`));
                return true;
            },
        );
    }
    const empty = new SubagentModelResolver(await runtime(t, []));
    await assert.rejects(
        empty.resolve(SubagentReasoningSkill.MIN, SubagentReasoningAmount.LOW, "missing/model"),
        /No authenticated model supports normal subagent reasoning amounts; cannot fall back/,
    );
});

test("registry errors and registry aborts propagate unchanged instead of becoming fallback", async (t) => {
    const modelRuntime = await runtime(t, [model("available", 1)]);
    const ranker = new FixedPerformanceRanker({available: 1});
    const rank = t.mock.method(ranker, "rank");
    const resolver = new SubagentModelResolver(modelRuntime, ranker);
    for (const failure of [new Error("registry failed"), new DOMException("cancelled", "AbortError")]) {
        t.mock.method(modelRuntime, "getAvailable", async () => { throw failure; });
        await assert.rejects(
            resolver.resolve(SubagentReasoningSkill.MID, SubagentReasoningAmount.MID, "missing/model"),
            (error) => error === failure,
        );
    }
    assert.equal(rank.mock.callCount(), 0);
});

test("pre-aborted resolution never reads availability or ranks a fallback", async (t) => {
    const modelRuntime = await runtime(t, [model("available", 1)]);
    const available = t.mock.method(modelRuntime, "getAvailable");
    const resolver = new SubagentModelResolver(modelRuntime);
    await assert.rejects(
        resolver.resolve(
            SubagentReasoningSkill.MID, SubagentReasoningAmount.MID, "missing/model", AbortSignal.abort(),
        ),
        {name: "AbortError"},
    );
    assert.equal(available.mock.callCount(), 0);
});

test("abort after availability prevents exact selection and fallback ranking", async (t) => {
    for (const preference of ["provider/available", "missing/model"]) {
        const controller = new AbortController();
        const modelRuntime = await runtime(t, [model("available", 1)]);
        const ranker = new FixedPerformanceRanker({available: 1});
        const rank = t.mock.method(ranker, "rank");
        t.mock.method(modelRuntime, "getAvailable", async (...[_provider, options]: Parameters<ModelRuntime["getAvailable"]>) => {
            assert.equal(options?.signal, controller.signal);
            controller.abort();
            return [model("available", 1)];
        });
        const resolver = new SubagentModelResolver(modelRuntime, ranker);
        await assert.rejects(
            resolver.resolve(SubagentReasoningSkill.MID, SubagentReasoningAmount.MID, preference, controller.signal),
            {name: "AbortError"},
        );
        assert.equal(rank.mock.callCount(), 0);
    }
});

test("abort during fallback ranking prevents returning a selected model", async (t) => {
    const controller = new AbortController();
    const ranker = new FixedPerformanceRanker({available: 1});
    t.mock.method(ranker, "rank", async (models: readonly SubagentModel[], signal?: AbortSignal) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        return models.map((model) => ({model, score: 1}));
    });
    const resolver = new SubagentModelResolver(await runtime(t, [model("available", 1)]), ranker);
    await assert.rejects(
        resolver.resolve(SubagentReasoningSkill.MID, SubagentReasoningAmount.MID, "missing/model", controller.signal),
        {name: "AbortError"},
    );
});

test("fallback ranking errors and invalid ranking evidence are not swallowed", async (t) => {
    const ranker = new FixedPerformanceRanker({available: 1});
    const resolver = new SubagentModelResolver(await runtime(t, [model("available", 1)]), ranker);
    const failure = new Error("ranker failed");
    t.mock.method(ranker, "rank", async () => { throw failure; });
    await assert.rejects(
        resolver.resolve(SubagentReasoningSkill.MID, SubagentReasoningAmount.MID, "missing/model"),
        (error) => error === failure,
    );
    t.mock.method(ranker, "rank", async () => []);
    await assert.rejects(
        resolver.resolve(SubagentReasoningSkill.MID, SubagentReasoningAmount.MID, "missing/model"),
        /ranker did not score every candidate model/,
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
