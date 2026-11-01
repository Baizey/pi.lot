import assert from "node:assert/strict";
import test from "node:test";
import {scheduleBenchmark, summarizeBenchmark} from "../experiments/compaction/BenchmarkStatistics.js";
import type {BenchmarkReport, BenchmarkTrial, ValueGrade} from "../experiments/compaction/BenchmarkTypes.js";

function report(options: {cases?: string[]; strategies?: string[]; repetitions?: number; clusters?: Record<string, string>; times?: Record<string, number>; fail?: string; missing?: string; cache?: string; judges?: number; unscored?: string; seed?: number; mode?: "smoke" | "live"; unknownUsage?: string; invalidMetadata?: string; hashMismatch?: string; cacheWrite?: number; missingSummary?: string; blankSummary?: string} = {}): BenchmarkReport {
    const caseIds = options.cases ?? ["a", "b", "c"];
    const strategyIds = options.strategies ?? ["stock", "candidate"];
    const repetitions = options.repetitions ?? 1;
    const trials: BenchmarkTrial[] = [];
    for (const caseId of caseIds) for (const strategyId of strategyIds) for (let repetition = 0; repetition < repetitions; repetition++) {
        const key = `${caseId}/${strategyId}/${repetition}`;
        if (options.missing === key) continue;
        const durationMs = options.times?.[key] ?? (strategyId === "stock" ? 100 : 50);
        const broken = options.fail === key;
        const unknownUsage = options.unknownUsage === key;
        trials.push({id: key, cluster: options.clusters?.[caseId] ?? caseId, result: {
            fixture: caseId, experiment: strategyId, repetition, inputHash: options.hashMismatch === key ? "different" : "same", durationMs, tokensBefore: 100,
            messagesToSummarize: 2, turnPrefixMessages: 1, settings: {} as never,
            usage: {input: 8, output: 3, cacheRead: options.cache === key ? 4 : 0, cacheWrite: options.cacheWrite ?? 0, cost: 0.2},
            usageComplete: !unknownUsage, cleanupComplete: !broken,
            summary: options.missingSummary === key ? undefined : options.blankSummary === key ? " \n " : "hello", calls: [{durationMs: 1, inputHash: "same", model: "m", reasoning: "off", usageComplete: !unknownUsage}],
            checks: [], metadataPassed: !broken && options.invalidMetadata !== key, error: broken ? "failed" : undefined,
        }});
    }
    const judgeRepetitions = options.judges ?? 1;
    const judgments: BenchmarkReport["judgments"] = [];
    for (const trial of trials) for (let repetition = 0; repetition < judgeRepetitions; repetition++) {
        const grade: ValueGrade = options.unscored === trial.id ? {status: "unscored", error: "unscored"} : {
            status: "graded", judgments: [], unsupportedClaims: [], gate: "pass",
            value: {score: trial.result.experiment === "stock" ? 0.8 : 0.9, rawScore: 1, totalWeight: 1, categories: {}, criticalFailures: [], contradictions: []},
        };
        judgments.push({trialId: trial.id, judgeRepetition: repetition, grade});
    }
    return {version: 1, mode: options.mode ?? "live", corpusHash: "hash", model: "m", thinking: "off", seed: options.seed ?? 10, repetitions,
        judgeRepetitions, caseIds, strategyIds, scoringMode: "curated", timingScope: "summary-strategy-including-worker-cleanup", trials, judgments};
}

test("schedule is reproducible, seed-sensitive and rotates balanced positions", () => {
    const judgeSchedule = scheduleBenchmark(["a"], ["judge"], 2, 1);
    assert.deepEqual(judgeSchedule.map((row) => row.strategyId), ["judge", "judge"]);
    const first = scheduleBenchmark(["a", "b", "c"], ["stock", "x", "y"], 3, 44);
    assert.deepEqual(scheduleBenchmark(["a", "b", "c"], ["stock", "x", "y"], 3, 44), first);
    assert.notDeepEqual(scheduleBenchmark(["a", "b", "c"], ["stock", "x", "y"], 3, 45), first);
    for (const caseId of ["a", "b", "c"]) {
        const rows = first.filter((row) => row.caseId === caseId);
        for (let repetition = 0; repetition < 3; repetition++) {
            assert.equal(rows.filter((row) => row.repetition === repetition).length, 3);
            assert.deepEqual(rows.filter((row) => row.repetition === repetition).map((row) => row.strategyId).sort(), ["stock", "x", "y"]);
        }
        for (let position = 0; position < 3; position++) assert.equal(new Set(rows.filter((row) => row.repetition === position).map((row) => row.strategyId)).size, 3);
    }
});

test("paired medians use arithmetic trial ratios and cluster-weight cases equally", () => {
    const input = report({cases: ["large-1", "large-2", "small"], repetitions: 2,
        clusters: {"large-1": "large", "large-2": "large", small: "small"},
        times: {"large-1/stock/0": 100, "large-1/candidate/0": 50, "large-1/stock/1": 100, "large-1/candidate/1": 50,
            "large-2/stock/0": 100, "large-2/candidate/0": 50, "large-2/stock/1": 100, "large-2/candidate/1": 50,
            "small/stock/0": 100, "small/candidate/0": 100, "small/stock/1": 100, "small/candidate/1": 100}});
    const stats = summarizeBenchmark(input);
    assert.equal(stats.cases[0]!.comparisons[0]!.pairedMedianSpeedup, 2);
    assert.ok(Math.abs(stats.comparisons[0]!.speedup! - Math.sqrt(2)) < 1e-10);
    assert.equal(stats.comparisons[0]!.clusterCount, 2);
    assert.equal(stats.comparisons[0]!.confidenceInterval95, null);
    assert.match(stats.comparisons[0]!.confidenceIntervalReason!, /three/);
});

test("three independent clusters receive a deterministic bootstrap interval", () => {
    const input = report({cases: ["a", "b", "c"]});
    const result = summarizeBenchmark(input).comparisons[0]!;
    assert.ok(result.confidenceInterval95);
    assert.ok(result.confidenceInterval95[0] <= result.speedup!);
    assert.ok(result.confidenceInterval95[1] >= result.speedup!);
});

test("incomplete or failed pair coverage cannot produce a global speedup", () => {
    const missing = summarizeBenchmark(report({missing: "a/candidate/0"})).comparisons[0]!;
    assert.equal(missing.speedup, null);
    assert.equal(missing.validPairs, 2);
    const failed = summarizeBenchmark(report({fail: "a/candidate/0"})).comparisons[0]!;
    assert.equal(failed.speedup, null);
    assert.equal(failed.validPairs, 2);
});

test("a missing baseline is incomplete, never a vacuous comparison pass", () => {
    const input = report();
    const removed = input.trials.filter((trial) => trial.result.fixture === "a" && trial.result.experiment === "stock");
    input.trials = input.trials.filter((trial) => !removed.includes(trial));
    input.judgments = input.judgments.filter((judgment) => !removed.some((trial) => trial.id === judgment.trialId));
    const stats = summarizeBenchmark(input);
    assert.equal(stats.comparisons[0]!.speedup, null);
    assert.equal(stats.quality.complete, false);
    assert.equal(stats.quality.delta, null);
});

test("unscored repeated judgments invalidate quality rather than becoming zero", () => {
    const stats = summarizeBenchmark(report({judges: 3, unscored: "a/candidate/0"}));
    assert.equal(stats.quality.complete, false);
    assert.equal(stats.quality.unscoredJudgments, 3);
    assert.equal(stats.quality.delta, null);
});

test("judge repetitions are averaged within trials, not counted as independent cases", () => {
    const stats = summarizeBenchmark(report({judges: 4}));
    assert.equal(stats.quality.expectedJudgments, 24);
    assert.ok(Math.abs(stats.quality.delta! - 0.1) < 1e-12);
    assert.ok(Math.abs(stats.quality.means[0]!.value! - 0.8) < 1e-12);
    assert.ok(Math.abs(stats.quality.means[1]!.value! - 0.9) < 1e-12);
});

test("cache sensitivity uses complete valid uncached subsets only when every case contributes", () => {
    const stats = summarizeBenchmark(report({repetitions: 2, cache: "a/candidate/0"})).comparisons[0]!;
    assert.equal(stats.noReportedCachePairs, 5);
    assert.equal(stats.noReportedCacheSpeedup, 2);
    const missingCaseSubset = summarizeBenchmark(report({cache: "a/candidate/0"})).comparisons[0]!;
    assert.equal(missingCaseSubset.noReportedCacheSpeedup, null);
});

test("non-finite durations and blank or missing summaries invalidate pairs, quality and success", () => {
    for (const options of [
        {times: {"a/candidate/0": Infinity}},
        {times: {"a/candidate/0": Number.NaN}},
        {blankSummary: "a/candidate/0"},
        {missingSummary: "a/candidate/0"},
    ]) {
        const stats = summarizeBenchmark(report(options));
        assert.equal(stats.comparisons[0]!.validPairs, 2);
        assert.equal(stats.comparisons[0]!.speedup, null);
        assert.equal(stats.quality.complete, false);
        assert.equal(stats.quality.delta, null);
        assert.equal(stats.strategies[1]!.completedTrials, 2);
        assert.equal(stats.strategies[1]!.successRate, 2 / 3);
    }
});

test("usage uncertainty nulls totals and invalid trials do not count as successful or timed", () => {
    const stats = summarizeBenchmark(report({unknownUsage: "a/candidate/0", invalidMetadata: "b/candidate/0", cacheWrite: 5}));
    const candidate = stats.strategies.find((strategy) => strategy.strategyId === "candidate")!;
    assert.equal(candidate.usageComplete, false);
    assert.equal(candidate.unknownUsageCalls, 1);
    assert.equal(candidate.inputTokens, null);
    assert.equal(candidate.cost, null);
    assert.equal(candidate.completedTrials, 2);
    assert.equal(candidate.failedTrials, 1);
    assert.equal(candidate.successRate, 2 / 3);
    assert.equal(stats.cases[1]!.strategies[1]!.medianDurationMs, null);
});

test("cache-write tokens are included in complete input-token totals", () => {
    const candidate = summarizeBenchmark(report({cacheWrite: 5})).strategies.find((strategy) => strategy.strategyId === "candidate")!;
    assert.equal(candidate.inputTokens, 39);
    assert.equal(candidate.cacheWriteTokens, 15);
});

test("multi-candidate quality deltas and judgment IDs are validated", () => {
    const stats = summarizeBenchmark(report({strategies: ["stock", "candidate", "candidate2"]}));
    assert.equal(stats.quality.deltas.length, 2);
    assert.ok(stats.quality.deltas.every((entry) => Math.abs(entry.value! - 0.1) < 1e-12));
    const invalid = report();
    invalid.judgments[0]!.judgeRepetition = invalid.judgeRepetitions;
    assert.throws(() => summarizeBenchmark(invalid), /judge repetition/);
    const unknown = report();
    unknown.judgments[0]!.trialId = "not-a-trial";
    assert.throws(() => summarizeBenchmark(unknown), /Unknown judgment trial ID/);
});

test("out-of-range trial IDs, cluster inconsistencies and input mismatch invalidate comparisons and quality", () => {
    const unexpected = report();
    unexpected.trials[0]!.result.fixture = "unknown";
    assert.throws(() => summarizeBenchmark(unexpected), /Unexpected case ID/);
    const clusterMismatch = report();
    clusterMismatch.trials.find((trial) => trial.result.fixture === "a" && trial.result.experiment === "candidate")!.cluster = "other";
    assert.throws(() => summarizeBenchmark(clusterMismatch), /Inconsistent cluster/);
    const mismatch = summarizeBenchmark(report({hashMismatch: "a/candidate/0"}));
    assert.equal(mismatch.comparisons[0]!.speedup, null);
    assert.equal(mismatch.quality.complete, false);
    assert.equal(mismatch.quality.delta, null);
});

test("smoke mode preserves debug metrics but never reports live speedup, intervals, or quality", () => {
    const stats = summarizeBenchmark(report({mode: "smoke"}));
    assert.equal(stats.conclusion, "smoke-only");
    assert.equal(stats.strategies[0]!.calls, 3);
    assert.equal(stats.strategies[0]!.medianSummaryCharacters, 5);
    assert.equal(stats.cases[0]!.comparisons[0]!.pairedMedianSpeedup, null);
    assert.equal(stats.cases[0]!.comparisons[0]!.noReportedCachePairedSpeedup, null);
    assert.equal(stats.comparisons[0]!.speedup, null);
    assert.equal(stats.comparisons[0]!.confidenceInterval95, null);
    assert.equal(stats.comparisons[0]!.conclusion, "smoke-only");
    assert.equal(stats.quality.complete, false);
    assert.equal(stats.quality.delta, null);
    assert.ok(stats.quality.means.every((entry) => entry.value === null));
});

test("duplicate IDs, empty identifiers, and duplicate fixture/strategy/repetition are rejected", () => {
    assert.throws(() => scheduleBenchmark(["a", "a"], ["stock"], 1, 1));
    assert.throws(() => scheduleBenchmark([""], ["stock"], 1, 1));
    const duplicate = report();
    duplicate.trials.push(duplicate.trials[0]!);
    assert.throws(() => summarizeBenchmark(duplicate), /Duplicate trial/);
    const duplicateKey = report();
    duplicateKey.trials[1]!.id = duplicateKey.trials[0]!.id;
    assert.throws(() => summarizeBenchmark(duplicateKey), /Duplicate trial ID/);
});
