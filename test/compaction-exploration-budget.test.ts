import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import type {BudgetSnapshot} from "../experiments/compaction/BudgetedModel.js";
import {cumulativeExplorationBudget, emptyExplorationTotals, explorationBudgetExtension, explorationCarry, readExplorationBudget, remainingExplorationBudget,
    type ExplorationBudgetExtension, type ExplorationLimits, type ExplorationTotals} from "../experiments/compaction/ExplorationBudget.js";
import {fingerprint} from "../experiments/compaction/CompactionEvaluation.js";
import {smokeModel} from "../scripts/evaluate-compaction.js";

const limits = {maxCalls: 128, maxCostUsd: .25};
const unknownReason = "Provider usage is unknown; future calls are blocked";
type Totals = Partial<ExplorationTotals> & {calls: number; spentUsd: number};

function receipt(calls: number, spentUsd: number, carry: Totals = {calls: 0, spentUsd: 0}, unknownUsd = 0, caps = limits) {
    const model = smokeModel();
    const budget: BudgetSnapshot = {calls: Array.from({length: calls}, () => ({phase: "summary", durationMs: 1,
        model: `${model.provider}/${model.id}`, completion: false, outputCap: 4096, reservedOutputTokens: 4096,
        status: "settled", costUsd: spentUsd / calls})), spentUsd, reservedUsd: unknownUsd,
        limits: {...caps, maxCalls: caps.maxCalls - carry.calls,
            maxCostUsd: caps.maxCostUsd - carry.spentUsd - (carry.reservedUnknownUsd ?? 0), maxOutputTokens: 4096, thinkingLevel: "low"},
        modelRateCard: {provider: model.provider, id: model.id, api: model.api, contextWindow: model.contextWindow,
            maxTokens: model.maxTokens, reasoning: model.reasoning, cost: model.cost}};
    if (unknownUsd) {
        budget.calls.push({phase: "summary", durationMs: 1, model: "test/test", completion: false, outputCap: 4096,
            reservedOutputTokens: 4096, status: "unknown", costUsd: 0});
        budget.blockedReason = unknownReason;
    }
    const cumulative: Totals = {calls: carry.calls + budget.calls.length, spentUsd: carry.spentUsd + spentUsd};
    if (carry.reservations) Object.assign(cumulative, cumulativeExplorationBudget(carry as ExplorationTotals, budget));
    return {status: "complete", options: {phase: "development", live: true, ...caps, previous: "", restartFrom: "", reserveUnknownUsage: false, extendBudget: false},
        budgetExtension: undefined as ExplorationBudgetExtension | undefined,
        budget, carry, cumulative, hashes: {"source.ts": "a".repeat(64)}, previousHash: undefined as string | undefined,
        cleanupComplete: true, continuationInterrupted: undefined as string | undefined,
        report: {mode: "live", trials: [{result: {cleanupComplete: true}}], interrupted: unknownUsd ? unknownReason : undefined}};
}

async function fixtures(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "exploration-ledger-"));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const first = receipt(40, .0193678);
    const firstFile = path.join(directory, "first.json");
    const firstRaw = JSON.stringify(first);
    await writeFile(firstFile, firstRaw);
    const interrupted = receipt(11, .0039772, first.cumulative, .0048555);
    interrupted.options.phase = "refinement";
    interrupted.options.previous = firstFile;
    interrupted.previousHash = fingerprint(firstRaw);
    const stoppedFile = path.join(directory, "interrupted.json");
    const save = () => writeFile(stoppedFile, JSON.stringify(interrupted));
    await save();
    return {directory, first, firstFile, interrupted, stoppedFile, save};
}

test("authorized restart retains all 52 calls, known cost, unknown reservation and source provenance", async (t) => {
    const {interrupted, stoppedFile} = await fixtures(t);
    const original = await readFile(stoppedFile, "utf8");
    await assert.rejects(readExplorationBudget(stoppedFile, limits));
    const carry = await readExplorationBudget(stoppedFile, limits, true);
    assert.equal(carry.calls, 52);
    assert.ok(Math.abs(carry.spentUsd - .023345) < 1e-12);
    assert.equal(carry.unknownCalls, 1);
    assert.equal(carry.reservedUnknownUsd, .0048555);
    assert.deepEqual(remainingExplorationBudget(carry, limits), {maxCalls: 76, maxCostUsd: .25 - carry.spentUsd - .0048555});
    assert.equal(carry.reservations.length, 1);
    assert.deepEqual(carry.reservations[0], {source: stoppedFile, sourceHash: fingerprint(original),
        sourceHashes: interrupted.hashes, calls: 1, reservedUsd: .0048555,
        declaration: "Explicitly authorized development restart: retain unknown usage as a reservation, not known or settled billing."});
    assert.equal(await readFile(stoppedFile, "utf8"), original, "source receipt is never rewritten");
});

test("ordinary continuation accepts inherited authorization only when the current stage settled", async (t) => {
    const {directory, stoppedFile} = await fixtures(t);
    const carry = await readExplorationBudget(stoppedFile, limits, true);
    const development = receipt(4, .002, carry);
    development.options.restartFrom = stoppedFile;
    development.options.reserveUnknownUsage = true;
    development.previousHash = fingerprint(await readFile(stoppedFile, "utf8"));
    const developmentFile = path.join(directory, "restarted.json");
    await writeFile(developmentFile, JSON.stringify(development));
    const next = await readExplorationBudget(developmentFile, limits);
    assert.equal(next.calls, 56);
    assert.equal(next.unknownCalls, 1);
    assert.equal(next.reservedUnknownUsd, .0048555);
    assert.ok(Math.abs(next.spentUsd - .025345) < 1e-12);
    assert.deepEqual(next.reservations, carry.reservations);
    const holdout = receipt(6, .003, next);
    holdout.options.phase = "holdout";
    holdout.options.previous = developmentFile;
    holdout.previousHash = fingerprint(await readFile(developmentFile, "utf8"));
    const holdoutFile = path.join(directory, "holdout.json");
    await writeFile(holdoutFile, JSON.stringify(holdout));
    assert.equal((await readExplorationBudget(holdoutFile, limits)).calls, 62);
    development.budget.calls[0]!.status = "reserved";
    await writeFile(developmentFile, JSON.stringify(development));
    await assert.rejects(readExplorationBudget(developmentFile, limits), /Nonterminal/);
});

test("ledger chain rejects missing or changed provenance and fabricated inherited accounting", async (t) => {
    const {firstFile, interrupted, stoppedFile, save} = await fixtures(t);
    const mutations = [
        () => { interrupted.carry.calls--; },
        () => { interrupted.carry.spentUsd = 0; },
        () => { interrupted.previousHash = "b".repeat(64); },
        () => { interrupted.options.previous = ""; },
        () => { interrupted.options.maxCalls = 127; },
        () => { interrupted.options.maxCostUsd = .24; },
        () => { interrupted.budget.limits.maxCalls++; },
        () => { interrupted.budget.limits.maxCostUsd += .004; },
        () => { interrupted.hashes["source.ts"] = "missing"; },
    ];
    for (const mutate of mutations) {
        const original = structuredClone(interrupted);
        mutate(); await save();
        await assert.rejects(readExplorationBudget(stoppedFile, limits, true));
        Object.assign(interrupted, original);
    }
    interrupted.options.previous = stoppedFile;
    await save();
    await assert.rejects(readExplorationBudget(stoppedFile, limits, true), /Cyclic/);
    interrupted.options.previous = firstFile;
    await save();
    const first = JSON.parse(await readFile(firstFile, "utf8"));
    first.budget.spentUsd = 0;
    await writeFile(firstFile, JSON.stringify(first));
    await assert.rejects(readExplorationBudget(stoppedFile, limits, true));
});

test("restart never waives terminal cleanup or converts pending calls to unknown", async (t) => {
    const {interrupted, stoppedFile, save} = await fixtures(t);
    for (const mutate of [
        () => { interrupted.status = "running"; },
        () => { interrupted.cleanupComplete = false; },
        () => { interrupted.report.trials[0]!.result.cleanupComplete = false; },
        () => { interrupted.report.interrupted = "Judge/provider did not settle after cancellation; remaining grades are unscored"; },
        () => { interrupted.continuationInterrupted = "Continuation cleanup incomplete"; },
        () => { interrupted.budget.calls.at(-1)!.status = "reserved"; },
        () => { interrupted.budget.calls.at(-1)!.status = "blocked"; },
        () => { interrupted.budget.blockedReason = "Reported provider cost exceeded the conservative reservation or budget"; },
    ]) {
        const original = structuredClone(interrupted);
        mutate(); await save();
        await assert.rejects(readExplorationBudget(stoppedFile, limits, true));
        Object.assign(interrupted, original);
    }
});

test("explicit restart accepts a cleaned-up calibration stop before any report, preserving both reservations", async (t) => {
    const {directory, stoppedFile} = await fixtures(t);
    const carry = await readExplorationBudget(stoppedFile, limits, true);
    const stopped = {...receipt(0, 0, carry, .00410475), status: "stopped",
        report: undefined as ReturnType<typeof receipt>["report"] | undefined, cleanupComplete: true as boolean | undefined,
        calibration: {faithful: {status: "unscored", error: "Provider request failed"}} as Record<string, {status: string; error?: string}>,
        continuations: [] as unknown[]};
    stopped.budget.calls[0]!.phase = "judge";
    stopped.budget.calls[0]!.completion = true;
    stopped.options.restartFrom = stoppedFile;
    stopped.options.reserveUnknownUsage = true;
    stopped.previousHash = fingerprint(await readFile(stoppedFile, "utf8"));
    const calibrationFile = path.join(directory, "calibration-stop.json");
    const save = () => writeFile(calibrationFile, JSON.stringify(stopped));
    await save();
    const raw = await readFile(calibrationFile, "utf8");
    await assert.rejects(readExplorationBudget(calibrationFile, limits), /Pre-report/);
    const restarted = await readExplorationBudget(calibrationFile, limits, true);
    assert.equal(restarted.calls, 53);
    assert.ok(Math.abs(restarted.spentUsd - .023345) < 1e-12);
    assert.equal(restarted.unknownCalls, 2);
    assert.ok(Math.abs(restarted.reservedUnknownUsd - .00896025) < 1e-12);
    assert.deepEqual(restarted.reservations.slice(0, 1), carry.reservations);
    assert.equal(restarted.reservations[1]!.sourceHash, fingerprint(raw));
    assert.equal(restarted.reservations[1]!.reservedUsd, .00410475);
    assert.deepEqual(remainingExplorationBudget(restarted, limits), {maxCalls: 75,
        maxCostUsd: .25 - restarted.spentUsd - restarted.reservedUnknownUsd});
    const settled = receipt(4, .001, restarted);
    settled.options.restartFrom = calibrationFile;
    settled.options.reserveUnknownUsage = true;
    settled.previousHash = fingerprint(raw);
    const settledFile = path.join(directory, "settled-after-calibration-restart.json");
    await writeFile(settledFile, JSON.stringify(settled));
    const next = await readExplorationBudget(settledFile, limits);
    assert.equal(next.calls, 57);
    assert.deepEqual(next.reservations, restarted.reservations);
    assert.equal(next.unknownCalls, 2);
    for (const mutate of [
        () => { stopped.status = "calibrating"; },
        () => { stopped.status = "complete"; },
        () => { stopped.cleanupComplete = false; },
        () => { stopped.cleanupComplete = undefined; },
        () => { stopped.budget.calls[0]!.status = "reserved"; },
        () => { stopped.budget.calls[0]!.status = "settled"; },
        () => { stopped.budget.calls[0]!.phase = "summary"; },
        () => { stopped.budget.calls[0]!.completion = false; },
        () => { stopped.budget.blockedReason = "Maximum provider call count reached"; },
        () => { stopped.options.phase = "holdout"; },
        () => { stopped.calibration = {}; },
        () => { stopped.calibration.faithful = {status: "graded"}; },
        () => { stopped.calibration.faithful = {status: "unscored"}; },
        () => { stopped.continuations.push({}); },
        () => { stopped.continuationInterrupted = "Continuation cleanup incomplete"; },
        () => { stopped.status = "complete"; stopped.report = {mode: "live", trials: [{result: {cleanupComplete: false}}], interrupted: unknownReason}; },
    ]) {
        const original = structuredClone(stopped);
        mutate(); await save();
        await assert.rejects(readExplorationBudget(calibrationFile, limits, true));
        Object.assign(stopped, original);
    }
});

test("explicit budget extension validates old limits and retains cumulative estimates, reservations and provenance", async (t) => {
    const {directory, stoppedFile} = await fixtures(t);
    const inherited = await readExplorationBudget(stoppedFile, limits, true);
    const latest = receipt(73, .0676372, inherited, .00410475);
    latest.options.restartFrom = stoppedFile;
    latest.options.reserveUnknownUsage = true;
    latest.previousHash = fingerprint(await readFile(stoppedFile, "utf8"));
    const latestFile = path.join(directory, "latest-126.json");
    const latestRaw = JSON.stringify(latest);
    await writeFile(latestFile, latestRaw);
    const expanded = {maxCalls: 256, maxCostUsd: 5};
    await assert.rejects(readExplorationBudget(latestFile, expanded, true), /without explicit extension/);
    await assert.rejects(readExplorationBudget(latestFile, expanded, false, true), /explicit development restart/);
    const carry = await readExplorationBudget(latestFile, expanded, true, true);
    assert.equal(carry.calls, 126);
    assert.ok(Math.abs(carry.spentUsd - .0909822) < 1e-12);
    assert.equal(carry.unknownCalls, 2);
    assert.ok(Math.abs(carry.reservedUnknownUsd - .00896025) < 1e-12);
    assert.equal(carry.reservations.length, 2);
    assert.deepEqual(carry.reservations[0], inherited.reservations[0]);
    assert.deepEqual(remainingExplorationBudget(carry, expanded), {maxCalls: 130,
        maxCostUsd: 5 - carry.spentUsd - carry.reservedUnknownUsd});
    assert.equal(await readFile(latestFile, "utf8"), latestRaw);
    const development = receipt(4, .002, carry, 0, expanded);
    development.options.restartFrom = latestFile;
    development.options.reserveUnknownUsage = true;
    development.options.extendBudget = true;
    development.previousHash = fingerprint(latestRaw);
    development.budgetExtension = explorationBudgetExtension(latestFile, fingerprint(latestRaw), limits, expanded);
    assert.deepEqual(development.budgetExtension.from, limits);
    assert.deepEqual(development.budgetExtension.to, expanded);
    assert.match(development.budgetExtension.declaration, /not invoiced charges/);
    const developmentFile = path.join(directory, "expanded-development.json");
    const save = () => writeFile(developmentFile, JSON.stringify(development));
    await save();
    const next = await readExplorationBudget(developmentFile, expanded);
    assert.equal(next.calls, 130);
    assert.deepEqual(next.reservations, carry.reservations);
    const holdout = receipt(2, .001, next, 0, expanded);
    holdout.options.phase = "holdout";
    holdout.options.previous = developmentFile;
    holdout.previousHash = fingerprint(await readFile(developmentFile, "utf8"));
    const holdoutFile = path.join(directory, "expanded-holdout.json");
    await writeFile(holdoutFile, JSON.stringify(holdout));
    assert.equal((await readExplorationBudget(holdoutFile, expanded)).calls, 132);
    await assert.rejects(readExplorationBudget(holdoutFile, {maxCalls: 300, maxCostUsd: 5}), /without explicit extension/);
    for (const mutate of [
        () => { development.options.extendBudget = false; },
        () => { development.budgetExtension = undefined; },
        () => { development.budgetExtension!.from.maxCalls = 127; },
        () => { development.budgetExtension!.to.maxCostUsd = 6; },
        () => { development.budgetExtension!.sourceHash = "b".repeat(64); },
        () => { development.budgetExtension!.source = "/tmp/unrelated.json"; },
        () => { development.options.phase = "holdout"; },
        () => { development.options.previous = latestFile; development.options.restartFrom = ""; },
        () => { development.budget.limits.maxCalls = expanded.maxCalls; },
        () => { development.budget.limits.maxCostUsd = expanded.maxCostUsd - carry.spentUsd; },
        () => { development.carry.calls--; },
        () => { development.carry.reservedUnknownUsd = 0; },
        () => { development.budget.calls[0]!.status = "reserved"; },
        () => { development.report.trials[0]!.result.cleanupComplete = false; },
    ]) {
        const original = structuredClone(development);
        mutate(); await save();
        await assert.rejects(readExplorationBudget(developmentFile, expanded));
        Object.assign(development, original);
    }
    for (const destination of [{maxCalls: 128, maxCostUsd: 5}, {maxCalls: 127, maxCostUsd: 5},
        {maxCalls: 256, maxCostUsd: .24}, {maxCalls: 513, maxCostUsd: 5}, {maxCalls: 256, maxCostUsd: 10.01},
        {maxCalls: NaN, maxCostUsd: 5}, {maxCalls: 256, maxCostUsd: Infinity}]) {
        await assert.rejects(readExplorationBudget(latestFile, destination, true, true));
    }
    for (const destination of [{maxCalls: 256, maxCostUsd: .25}, {maxCalls: 512, maxCostUsd: 10}]) {
        assert.equal((await readExplorationBudget(latestFile, destination, true, true)).calls, 126);
    }
    // Destination limits must never be used to validate an old stage's local cap.
    latest.budget.limits.maxCalls += 128;
    await writeFile(latestFile, JSON.stringify(latest));
    await assert.rejects(readExplorationBudget(latestFile, expanded, true, true), /Stage limits/);
});

test("an exhausted old receipt requires explicit extension, and expanded roots cannot erase history", async (t) => {
    const {directory} = await fixtures(t);
    const file = path.join(directory, "exhausted.json");
    await writeFile(file, JSON.stringify(receipt(128, .01)));
    await assert.rejects(readExplorationBudget(file, limits), /exhausted/);
    const expanded = {maxCalls: 256, maxCostUsd: 5};
    assert.equal((await readExplorationBudget(file, expanded, true, true)).calls, 128);
    await writeFile(file, JSON.stringify(receipt(1, .01, undefined, 0, expanded)));
    await assert.rejects(readExplorationBudget(file, expanded), /Missing prior ledger/);
    const increasedCostOnly: ExplorationLimits = {maxCalls: 128, maxCostUsd: 5};
    assert.throws(() => explorationBudgetExtension(file, "a".repeat(64), limits, increasedCostOnly), /higher call cap/);
});

test("each receipt retains its own thinking level while legacy receipts remain low", () => {
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const base = receipt(2, .002);
        const value = {...base, options: {...base.options, thinking}, thinking, report: {...base.report, thinking}};
        value.budget.limits.thinkingLevel = thinking;
        assert.equal(explorationCarry(value, limits).calls, 2);
        const mismatchedBudget = structuredClone(value);
        mismatchedBudget.budget.limits.thinkingLevel = thinking === "low" ? "high" : "low";
        assert.throws(() => explorationCarry(mismatchedBudget, limits), /Stage limits/);
        assert.throws(() => explorationCarry({...value, thinking: "different"}, limits), /thinking level/);
        assert.throws(() => explorationCarry({...value, report: {...value.report, thinking: "different"}}, limits), /thinking level/);
    }
    const legacy = receipt(2, .002);
    assert.equal(explorationCarry(legacy, limits).calls, 2);
    for (const thinking of [null, 42, "unsupported"]) {
        assert.throws(() => explorationCarry({...legacy, options: {...legacy.options, thinking}}, limits), /thinking level/);
    }
});

test("finite, consistent settled/unknown totals and bounded experimental ceilings are mandatory", () => {
    const base = receipt(2, .002);
    const mutations = [
        (value: typeof base) => { value.budget.spentUsd = NaN; },
        (value: typeof base) => { value.budget.reservedUsd = Infinity; },
        (value: typeof base) => { value.cumulative.spentUsd = Infinity; },
        (value: typeof base) => { value.carry.calls = NaN; },
        (value: typeof base) => { value.carry.spentUsd = NaN; },
        (value: typeof base) => { value.cumulative.calls = 2.5; },
        (value: typeof base) => { value.budget.calls[0]!.costUsd = NaN; },
        (value: typeof base) => { value.budget.calls[0]!.costUsd = -1; },
        (value: typeof base) => { value.budget.calls[0]!.inputCostUsd = .0001; },
        (value: typeof base) => { value.budget.calls[0]!.durationMs = Infinity; },
        (value: typeof base) => { value.budget.reservedUsd = .001; },
        (value: typeof base) => { value.cumulative.unknownCalls = 1; },
        (value: typeof base) => { value.cumulative.reservedUnknownUsd = .001; },
    ];
    for (const mutate of mutations) {
        const value = structuredClone(base); mutate(value);
        assert.throws(() => explorationCarry(value, limits));
    }
    for (const bad of [null, {}, {budget: null}, {budget: {calls: {}}}]) assert.throws(() => explorationCarry(bad, limits));
    for (const caps of [{maxCalls: 513, maxCostUsd: .25}, {maxCalls: 128, maxCostUsd: 10.01},
        {maxCalls: NaN, maxCostUsd: .25}, {maxCalls: 128, maxCostUsd: Infinity}]) assert.throws(() => explorationCarry(base, caps));
    const unknown = receipt(1, .001, undefined, .002);
    const restart = {source: "/tmp/receipt.json", sourceHash: "a".repeat(64)};
    unknown.budget.reservedUsd = 0;
    assert.throws(() => explorationCarry(unknown, limits, emptyExplorationTotals(), restart));
    const exhausted = receipt(128, .001);
    assert.equal(explorationCarry(exhausted, limits).calls, 128, "an exhausted receipt is valid history");
    assert.throws(() => remainingExplorationBudget(explorationCarry(exhausted, limits), limits), /exhausted/);
});
