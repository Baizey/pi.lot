import assert from "node:assert/strict";
import test from "node:test";
import {explorationCarry, explorationModelTransition, explorationSourceFiles, explorationStrategies, parseContinuationAnswers, parseExplorationArguments, validateFrozenCandidate} from "../scripts/explore-compaction.js";
import type {BudgetSnapshot} from "../experiments/compaction/BudgetedModel.js";
import {smokeModel} from "../scripts/evaluate-compaction.js";

test("exploration requires explicit SDK resource guards and freezes later-stage selection", () => {
    const plan = parseExplorationArguments(["--output", "/tmp/plan.json"]);
    assert.equal(plan.live, false);
    assert.equal(plan.version, 3);
    assert.equal(plan.thinking, "low");
    assert.equal(plan.model, "openai/gpt-6-luna");
    assert.equal(plan.modelExplicit, false);
    assert.equal(plan.suite, "legacy");
    assert.equal(plan.allowDraftRubrics, false);
    assert.equal(plan.nativeParallel, false);
    assert.equal(plan.extendBudget, false);
    assert.equal(parseExplorationArguments(["--output", "/tmp/plan.json", "--native-parallel"]).nativeParallel, true);
    assert.equal(parseExplorationArguments(["--output", "/tmp/plan.json", "--allow-draft-rubrics"]).allowDraftRubrics, true);
    for (const flags of [[], ["--max-calls", "129", "--max-cost-usd", ".25"], ["--max-calls", "128", "--max-cost-usd", ".26"]]) {
        assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", "--live", ...flags]));
    }
    assert.throws(() => parseExplorationArguments(["--phase", "holdout", "--output", "/tmp/plan.json"]));
    assert.throws(() => parseExplorationArguments(["--phase", "historical", "--candidate", "dual", "--previous", "/tmp/prior.json", "--output", "/tmp/plan.json"]));
    assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", "--retry", "1"]));
});

test("development restart requires both explicit flags, overall caps, and no ordinary previous stage", () => {
    const base = ["--output", "/tmp/plan.json", "--max-calls", "128", "--max-cost-usd", ".25"];
    const restart = ["--restart-from", "/tmp/interrupted.json", "--reserve-unknown-usage"];
    const options = parseExplorationArguments([...base, ...restart]);
    assert.equal(options.restartFrom, "/tmp/interrupted.json");
    assert.equal(options.reserveUnknownUsage, true);
    assert.equal(options.nativeParallel, false);
    assert.equal(parseExplorationArguments([...base, ...restart, "--native-parallel"]).nativeParallel, true);
    for (const flags of [["--restart-from", "/tmp/interrupted.json"], ["--reserve-unknown-usage"],
        [...restart, "--previous", "/tmp/other.json"], [...restart, "--phase", "refinement", "--candidate", "dual", "--previous", "/tmp/other.json"],
        [...restart, "--phase", "holdout", "--candidate", "dual", "--previous", "/tmp/other.json"]]) {
        assert.throws(() => parseExplorationArguments([...base, ...flags]));
    }
    assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", ...restart]));
});

test("budget extension is an explicit bounded development restart, not an ordinary continuation flag", () => {
    const base = ["--output", "/tmp/plan.json", "--max-calls", "256", "--max-cost-usd", "5"];
    const restart = ["--restart-from", "/tmp/prior.json", "--reserve-unknown-usage", "--extend-budget"];
    const options = parseExplorationArguments([...base, ...restart]);
    assert.equal(options.extendBudget, true);
    assert.equal(options.maxCalls, 256);
    assert.equal(options.maxCostUsd, 5);
    assert.equal(options.phase, "development");
    // A later stage may retain these caps, but its receipt chain must prove the authorized transition.
    assert.equal(parseExplorationArguments([...base, "--phase", "holdout", "--candidate", "dual", "--previous", "/tmp/prior.json"]).maxCalls, 256);
    for (const flags of [["--extend-budget"], ["--restart-from", "/tmp/prior.json", "--extend-budget"],
        ["--phase", "holdout", "--candidate", "dual", "--previous", "/tmp/prior.json", "--extend-budget"],
        ["--phase", "refinement", "--candidate", "dual", "--previous", "/tmp/prior.json", "--extend-budget"],
        ["--phase", "historical", "--candidate", "dual", "--previous", "/tmp/prior.json", "--corpus", "/tmp/corpus.json", "--extend-budget"],
        ["--extend-call-limit"]]) assert.throws(() => parseExplorationArguments([...base, ...flags]));
    for (const caps of [["513", "5"], ["256", "10.01"], ["NaN", "5"], ["256", "Infinity"]]) {
        assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", ...restart, "--max-calls", caps[0]!, "--max-cost-usd", caps[1]!]));
    }
    assert.equal(parseExplorationArguments(["--output", "/tmp/plan.json", ...restart, "--max-calls", "512", "--max-cost-usd", "10"]).maxCalls, 512);
    assert.throws(() => parseExplorationArguments([...base, "--live"]), /not a fresh ledger/);
});

test("strategy fanout defaults to stock plus selected semantics; native parallel is explicit", () => {
    const base = parseExplorationArguments(["--output", "/tmp/plan.json"]);
    const ids = explorationStrategies(base).map((strategy) => strategy.id);
    assert.equal(ids.length, 3);
    assert.ok(ids.includes("semantic-unified-v3"));
    assert.ok(ids.includes("semantic-dual-v3"));
    const selected = explorationStrategies({...base, candidate: "dual"});
    assert.equal(selected.length, 2);
    assert.deepEqual(explorationStrategies({...base, candidate: "dual", nativeParallel: true}).map((strategy) => strategy.id),
        [selected[0]!.id, "parallel-split", "semantic-dual-v3"]);
});

test("v4/v5/v6 runner selects the working-memory policy and rejects unimplemented revisions or dual mode", () => {
    const base = parseExplorationArguments(["--output", "/tmp/plan.json", "--candidate", "unified", "--version", "4"]);
    const strategies = explorationStrategies(base);
    assert.equal(strategies.length, 2);
    assert.equal(strategies[1]!.id, "semantic-unified-v4");
    assert.throws(() => explorationStrategies({...base, candidate: "dual"}), /v4 requires unified/);
    for (const candidate of ["both", "dual"]) {
        assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", "--version", "4", "--candidate", candidate]), /v4 requires/);
    }
    const v5 = parseExplorationArguments(["--output", "/tmp/plan.json", "--version", "5", "--candidate", "unified"]);
    assert.equal(explorationStrategies(v5)[1]!.id, "semantic-unified-v5");
    assert.throws(() => explorationStrategies({...v5, candidate: "dual"}));
    const v6 = parseExplorationArguments(["--output", "/tmp/plan.json", "--version", "6", "--candidate", "unified"]);
    assert.equal(v6.suite, "validation");
    assert.equal(v6.thinking, "low");
    assert.equal(explorationStrategies(v6)[1]!.id, "semantic-unified-v6");
    assert.throws(() => explorationStrategies({...v6, candidate: "dual"}));
    for (const candidate of ["both", "dual"]) assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", "--version", "6", "--candidate", candidate]));
    assert.equal(parseExplorationArguments(["--output", "/tmp/plan.json", "--version", "6", "--candidate", "unified", "--suite", "regression"]).suite, "regression");
    assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", "--version", "7", "--candidate", "unified"]));
});

test("physical model syntax and explicit suite selection are validated independently of candidate version", () => {
    const base = ["--output", "/tmp/plan.json", "--candidate", "unified", "--version", "5"];
    assert.equal(parseExplorationArguments(base).suite, "validation");
    assert.equal(parseExplorationArguments(["--output", "/tmp/plan.json", "--candidate", "unified", "--version", "4"]).suite, "validation");
    const sol = parseExplorationArguments([...base, "--model", "openai/gpt-6.1-sol", "--suite", "regression"]);
    assert.equal(sol.model, "openai/gpt-6.1-sol");
    assert.equal(sol.modelExplicit, true);
    assert.equal(sol.suite, "regression");
    assert.equal(explorationStrategies(sol)[1]!.id, "semantic-unified-v5", "model profile does not change candidate revision");
    for (const suite of ["legacy", "validation", "regression"]) assert.equal(parseExplorationArguments([...base, "--suite", suite]).suite, suite);
    for (const model of ["gpt-6.1-sol", "/gpt-6.1-sol", "openai/", "openai//gpt-6.1-sol", "openai/gpt 6", " openai/gpt-6.1-sol", "openai/gpt-6.1-sol/extra"]) {
        assert.throws(() => parseExplorationArguments([...base, "--model", model]), /provider\/model/);
    }
    for (const suite of ["other", "Regression", " regression"]) assert.throws(() => parseExplorationArguments([...base, "--suite", suite]), /suite/);
    assert.throws(() => parseExplorationArguments([...base, "--model"]));
    assert.throws(() => parseExplorationArguments([...base, "--suite"]));
    assert.ok(explorationSourceFiles.includes("experiments/compaction/CondenserRegressionScenarios.ts"));
    assert.equal(new Set(explorationSourceFiles).size, explorationSourceFiles.length);
});

test("thinking is an optional validated benchmark control, independent of model/suite selection", () => {
    const base = ["--output", "/tmp/plan.json", "--candidate", "unified", "--version", "6"];
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        const options = parseExplorationArguments([...base, "--thinking", thinking]);
        assert.equal(options.thinking, thinking);
        assert.equal(options.model, "openai/gpt-6-luna", "thinking does not select a model/provider");
        assert.equal(options.suite, "validation");
    }
    for (const thinking of ["", "none", "LOW", " high", "ultra", "1"]) {
        assert.throws(() => parseExplorationArguments([...base, "--thinking", thinking]));
    }
    assert.throws(() => parseExplorationArguments([...base, "--thinking"]));
    const restart = parseExplorationArguments([...base, "--thinking", "high", "--restart-from", "/tmp/prior.json",
        "--reserve-unknown-usage", "--extend-budget", "--max-calls", "512", "--max-cost-usd", "10"]);
    assert.equal(restart.thinking, "high");
    assert.equal(restart.maxCalls, 512);
});

test("model, thinking and suite are frozen for every ordinary later stage, including refinement, with legacy fallbacks", () => {
    const base = parseExplorationArguments(["--output", "/tmp/plan.json", "--candidate", "unified", "--version", "5",
        "--model", "openai/gpt-6.1-sol", "--suite", "regression"]);
    for (const phase of ["refinement", "holdout", "historical"]) {
        const previous = phase === "refinement" ? {...base, version: 4} : base;
        const current = {...base, phase};
        assert.doesNotThrow(() => validateFrozenCandidate(current, previous));
        assert.throws(() => validateFrozenCandidate({...current, model: "openai/gpt-6-luna"}, previous), /frozen model/);
        assert.throws(() => validateFrozenCandidate({...current, thinking: "high"}, previous), /frozen thinking/);
        assert.doesNotThrow(() => validateFrozenCandidate({...current, thinking: "high"}, {...previous, thinking: "high"}));
        assert.throws(() => validateFrozenCandidate({...current, suite: "validation"}, previous), /frozen suite/);
    }
    for (const version of [3, 5]) {
        const legacy = parseExplorationArguments(["--output", "/tmp/plan.json", "--candidate", "unified", "--version", String(version)]);
        const current = {...legacy, phase: "holdout"};
        Reflect.deleteProperty(legacy, "model");
        Reflect.deleteProperty(legacy, "suite");
        Reflect.deleteProperty(legacy, "thinking");
        assert.doesNotThrow(() => validateFrozenCandidate(current, legacy));
        assert.throws(() => validateFrozenCandidate({...current, thinking: "off"}, legacy), /frozen thinking/);
        assert.throws(() => validateFrozenCandidate({...current, suite: "regression"}, legacy), /frozen suite/);
        assert.throws(() => validateFrozenCandidate({...current, model: "openai/gpt-6.1-sol"}, legacy), /frozen model/);
    }
});

test("only explicit model transitions on fresh development restarts permit a new rate-card profile", () => {
    const base = ["--output", "/tmp/plan.json", "--candidate", "unified", "--version", "5",
        "--max-calls", "384", "--max-cost-usd", "10", "--restart-from", "/tmp/prior.json", "--reserve-unknown-usage", "--extend-budget"];
    const options = parseExplorationArguments([...base, "--model", "openai/gpt-6.1-sol", "--suite", "regression"]);
    const priorHash = "a".repeat(64);
    const transition = explorationModelTransition(options, "openai/gpt-6-luna", priorHash)!;
    assert.equal(transition.oldModel, "openai/gpt-6-luna");
    assert.equal(transition.newModel, "openai/gpt-6.1-sol");
    assert.equal(transition.priorHash, priorHash);
    assert.match(transition.declaration, /recalibrate judges/);
    assert.match(transition.declaration, /retain all prior catalogue estimates and unknown reservations/);
    assert.equal(explorationModelTransition(options, options.model, priorHash), undefined, "same-model restarts retain rate-card matching");
    assert.throws(() => explorationModelTransition({...options, modelExplicit: false}, "openai/gpt-6-luna", priorHash), /explicit --model/);
    assert.throws(() => explorationModelTransition({...options, phase: "holdout"}, "openai/gpt-6-luna", priorHash));
    assert.throws(() => explorationModelTransition({...options, restartFrom: ""}, "openai/gpt-6-luna", priorHash));
    assert.throws(() => explorationModelTransition({...options, previous: "/tmp/other.json"}, "openai/gpt-6-luna", priorHash));
    assert.throws(() => explorationModelTransition(options, "openai/gpt-6-luna", "missing"), /provenance/);
    assert.throws(() => explorationModelTransition(parseExplorationArguments(base), "openai/gpt-6.1-sol", priorHash), /explicit --model/,
        "omitting --model cannot silently switch a prior Sol profile back to the Luna default");
});

test("historical quality criteria are explicit, historical-only, and optional for speed-only controls", () => {
    const base = ["--phase", "historical", "--candidate", "unified", "--version", "4", "--previous", "/tmp/prior.json",
        "--corpus", "/tmp/corpus.json", "--output", "/tmp/plan.json", "--max-calls", "256", "--max-cost-usd", "5"];
    assert.equal(parseExplorationArguments(base).historicalCriteria, "");
    assert.equal(parseExplorationArguments([...base, "--historical-criteria", "/tmp/criteria.json"]).historicalCriteria, "/tmp/criteria.json");
    assert.throws(() => parseExplorationArguments(["--output", "/tmp/plan.json", "--historical-criteria", "/tmp/criteria.json"]), /historical-only/);
});

test("selection may choose from development alternatives but cannot change a refined candidate or frozen version", () => {
    const base = {...parseExplorationArguments(["--output", "/tmp/plan.json"]), version: 1};
    assert.doesNotThrow(() => validateFrozenCandidate({...base, phase: "holdout", candidate: "dual"}, base));
    const refined = {...base, phase: "refinement", candidate: "dual", version: 2};
    assert.doesNotThrow(() => validateFrozenCandidate(refined, base));
    assert.doesNotThrow(() => validateFrozenCandidate({...refined, phase: "holdout"}, refined));
    assert.throws(() => validateFrozenCandidate({...refined, phase: "holdout", candidate: "unified"}, refined));
    assert.throws(() => validateFrozenCandidate({...refined, phase: "historical", version: 3}, refined));
    assert.throws(() => validateFrozenCandidate({...refined, version: 1}, base));
    assert.throws(() => validateFrozenCandidate({...refined, nativeParallel: true}, base));
    assert.throws(() => validateFrozenCandidate({...refined, phase: "holdout"}, {...refined, nativeParallel: true}));
    assert.doesNotThrow(() => validateFrozenCandidate({...refined, phase: "holdout", nativeParallel: true}, {...refined, nativeParallel: true}));
});

test("stage budget validates settled totals without inventing inherited usage", () => {
    const model = smokeModel();
    const budget: BudgetSnapshot = {calls: [{phase: "summary", durationMs: 1, model: "test/test", completion: false,
        outputCap: 4096, reservedOutputTokens: 4096, status: "settled", costUsd: .001}], spentUsd: .001, reservedUsd: 0,
        limits: {maxCalls: 128, maxCostUsd: .25, maxOutputTokens: 4096, thinkingLevel: "low"},
        modelRateCard: {provider: model.provider, id: model.id, api: model.api, contextWindow: model.contextWindow,
            maxTokens: model.maxTokens, reasoning: model.reasoning, cost: model.cost}};
    const previous = {options: {thinking: "low"}, budget, carry: {calls: 0, spentUsd: 0}, cumulative: {calls: 1, spentUsd: .001}};
    assert.deepEqual(explorationCarry(previous, {maxCalls: 128, maxCostUsd: .25}),
        {...previous.cumulative, unknownCalls: 0, reservedUnknownUsd: 0, reservations: []});
    for (const mutate of [
        (value: typeof previous) => { value.budget.calls[0]!.status = "unknown"; },
        (value: typeof previous) => { value.budget.reservedUsd = .01; },
        (value: typeof previous) => { value.budget.spentUsd = 0; },
        (value: typeof previous) => { value.cumulative.calls = 4; },
        (value: typeof previous) => { value.cumulative.spentUsd = Number.NaN; },
    ]) {
        const changed = structuredClone(previous); mutate(changed);
        assert.throws(() => explorationCarry(changed, {maxCalls: 128, maxCostUsd: .25}));
    }
});

test("continuation grading receives complete answers, never question text as evidence", () => {
    assert.deepEqual(parseContinuationAnswers('{"answers":[{"id":"a","answer":"Not established."}]}', ["a"]), [{id: "a", answer: "Not established."}]);
    for (const text of ['{"answers":[]}', '{"answers":[{"id":"b","answer":"x"}]}',
        '{"answers":[{"id":"a","answer":" "}]}', '{"answers":[{"id":"a","answer":"x","extra":true}]}',
        '{"answers":[{"id":"a","answer":"x"},{"id":"a","answer":"x"}]}', '{"answers":[{"id":"a","answer":"x"}],"extra":1}']) {
        assert.throws(() => parseContinuationAnswers(text, ["a"]));
    }
});
