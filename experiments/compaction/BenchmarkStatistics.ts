import type {BenchmarkReport, BenchmarkTrial, ValueGrade} from "./BenchmarkTypes.js";

export type BenchmarkStatistics = {
    mode: BenchmarkReport["mode"];
    conclusion: "smoke-only" | "live-statistics";
    scoringMode: BenchmarkReport["scoringMode"];
    repetitions: number;
    baselineStrategyId: "stock";
    cases: Array<{
        caseId: string;
        strategies: Array<{strategyId: string; medianDurationMs: number | null}>;
        comparisons: Array<{
            strategyId: string;
            pairedMedianSpeedup: number | null;
            validPairs: number;
            expectedPairs: number;
            noReportedCachePairedSpeedup: number | null;
            noReportedCachePairs: number;
            conclusion: "smoke-only" | "live-statistics";
        }>;
    }>;
    strategies: Array<{
        strategyId: string;
        calls: number;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
        usageComplete: boolean;
        unknownUsageCalls: number;
        expectedTrials: number;
        completedTrials: number;
        failedTrials: number;
        missingTrials: number;
        inputTokens: number | null;
        outputTokens: number | null;
        cost: number | null;
        successRate: number;
        medianSummaryCharacters: number | null;
    }>;
    comparisons: Array<{
        strategyId: string;
        speedup: number | null;
        validPairs: number;
        expectedPairs: number;
        noReportedCacheSpeedup: number | null;
        noReportedCachePairs: number;
        clusterCount: number;
        confidenceInterval95: [number, number] | null;
        confidenceIntervalReason?: string;
        conclusion: "smoke-only" | "live-statistics";
    }>;
    quality: {
        complete: boolean;
        conclusion: "smoke-only" | "live-statistics";
        expectedJudgments: number;
        receivedJudgments: number;
        unscoredJudgments: number;
        criticalFailures: number;
        contradictions: number;
        unsupportedReviewFlags: number;
        means: Array<{strategyId: string; value: number | null}>;
        deltas: Array<{strategyId: string; value: number | null}>;
        strategies: Array<{strategyId: string; pass: number; fail: number; review: number; unscored: number; criticalFailures: number; contradictions: number}>;
        delta: number | null;
    };
};

/** Produce a deterministic, serial order; strategies are never scheduled concurrently. */
export function scheduleBenchmark(
    caseIds: string[], strategyIds: string[], repetitions: number, seed: number,
): Array<{caseId: string; strategyId: string; repetition: number}> {
    validateIds(caseIds, "caseIds");
    validateIds(strategyIds, "strategyIds");
    if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive safe integer");
    if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
    const random = seededRandom(seed);
    const cases = shuffled(caseIds, random);
    const output: Array<{caseId: string; strategyId: string; repetition: number}> = [];
    for (const caseId of cases) {
        const base = shuffled(strategyIds, random);
        for (let repetition = 0; repetition < repetitions; repetition++) {
            const offset = repetition % base.length;
            for (let index = 0; index < base.length; index++) {
                output.push({caseId, strategyId: base[(index + offset) % base.length]!, repetition});
            }
        }
    }
    return output;
}

export function summarizeBenchmark(report: BenchmarkReport): BenchmarkStatistics {
    validateIds(report.caseIds, "caseIds");
    validateIds(report.strategyIds, "strategyIds");
    if (report.strategyIds[0] !== "stock") throw new Error("The first strategy must be stock");
    if (!Number.isSafeInteger(report.repetitions) || report.repetitions < 1) throw new Error("Invalid repetitions");
    if (!Number.isSafeInteger(report.judgeRepetitions) || report.judgeRepetitions < 0) throw new Error("Invalid judgeRepetitions");
    if (!Number.isSafeInteger(report.seed)) throw new Error("Invalid seed");

    const trials = report.trials;
    const expectedCases = new Set(report.caseIds), expectedStrategies = new Set(report.strategyIds);
    if (!expectedStrategies.has("stock")) throw new Error("The expected strategies must include stock");
    const trialIds = new Set<string>();
    const trialKeys = new Set<string>();
    const caseClusters = new Map<string, string>();
    for (const trial of trials) {
        if (typeof trial.id !== "string" || trial.id.trim() === "") throw new Error("Trial IDs must be non-empty");
        if (typeof trial.cluster !== "string" || trial.cluster.trim() === "") throw new Error("Trial clusters must be non-empty");
        if (trialIds.has(trial.id)) throw new Error(`Duplicate trial ID: ${trial.id}`);
        trialIds.add(trial.id);
        const result = trial.result;
        if (!expectedCases.has(result.fixture)) throw new Error(`Unexpected case ID: ${result.fixture}`);
        if (!expectedStrategies.has(result.experiment)) throw new Error(`Unexpected strategy ID: ${result.experiment}`);
        if (!Number.isSafeInteger(result.repetition) || result.repetition < 0 || result.repetition >= report.repetitions) {
            throw new Error(`Invalid repetition: ${result.repetition}`);
        }
        const knownCluster = caseClusters.get(result.fixture);
        if (knownCluster !== undefined && knownCluster !== trial.cluster) throw new Error(`Inconsistent cluster for case ${result.fixture}`);
        caseClusters.set(result.fixture, trial.cluster);
        const key = `${result.fixture}\0${result.experiment}\0${result.repetition}`;
        if (trialKeys.has(key)) throw new Error(`Duplicate fixture/strategy/repetition: ${result.fixture}/${result.experiment}/${result.repetition}`);
        trialKeys.add(key);
    }
    const byKey = new Map(trials.map((trial) => [keyOf(trial.result.fixture, trial.result.experiment, trial.result.repetition), trial]));
    const expectedPairs = report.caseIds.length * report.repetitions;
    const caseStats = report.caseIds.map((caseId) => ({
        caseId,
        strategies: report.strategyIds.map((strategyId) => ({strategyId, medianDurationMs: median(trials.filter((t) =>
            t.result.fixture === caseId && t.result.experiment === strategyId && validTrial(t)).map((t) => t.result.durationMs))})),
        comparisons: report.strategyIds.slice(1).map((strategyId) => {
            const pairs = pairedTrials(report, byKey, caseId, strategyId);
            const valid = pairs.filter(validPair);
            const uncached = valid.filter(({baseline, candidate}) => knownUsage(baseline) && knownUsage(candidate) &&
                baseline.result.usage.cacheRead === 0 && candidate.result.usage.cacheRead === 0);
            return {strategyId, pairedMedianSpeedup: report.mode === "live" && valid.length === report.repetitions ? median(valid.map(ratio)) : null,
                validPairs: valid.length, expectedPairs: report.repetitions,
                noReportedCachePairedSpeedup: report.mode === "live" && valid.length === report.repetitions && uncached.length > 0 ? median(uncached.map(ratio)) : null,
                noReportedCachePairs: uncached.length, conclusion: report.mode === "smoke" ? "smoke-only" as const : "live-statistics" as const};
        }),
    }));
    const comparisonStats = report.strategyIds.slice(1).map((strategyId) => {
        const allPairs = report.caseIds.flatMap((caseId) => pairedTrials(report, byKey, caseId, strategyId));
        const valid = allPairs.filter(validPair);
        const complete = valid.length === expectedPairs;
        const noCache = valid.filter(({baseline, candidate}) => knownUsage(baseline) && knownUsage(candidate) &&
            baseline.result.usage.cacheRead === 0 && candidate.result.usage.cacheRead === 0);
        const caseLogs = report.caseIds.flatMap((caseId) => {
            const pairs = pairedTrials(report, byKey, caseId, strategyId);
            return pairs.length === report.repetitions && pairs.every(validPair)
                ? [{caseId, cluster: pairs[0]!.candidate.cluster, log: mean(pairs.map((pair) => Math.log(ratio(pair))))}] : [];
        });
        const clusters = new Map<string, number[]>();
        for (const row of caseLogs) clusters.set(row.cluster, [...(clusters.get(row.cluster) ?? []), row.log]);
        const clusterLogs = [...clusters.values()].map(mean);
        const speedup = report.mode === "live" && complete && caseLogs.length === report.caseIds.length ? Math.exp(mean(clusterLogs)) : null;
        const noCacheCaseLogs = report.caseIds.map((caseId) => {
            const pairs = pairedTrials(report, byKey, caseId, strategyId);
            const uncached = pairs.filter((pair) => validPair(pair) && knownUsage(pair.baseline) && knownUsage(pair.candidate) &&
                pair.baseline.result.usage.cacheRead === 0 && pair.candidate.result.usage.cacheRead === 0);
            return pairs.length === report.repetitions && pairs.every(validPair) && uncached.length > 0
                ? {cluster: pairs[0]!.candidate.cluster, log: mean(uncached.map((pair) => Math.log(ratio(pair))))} : undefined;
        });
        const noCacheClusters = new Map<string, number[]>();
        for (const row of noCacheCaseLogs) if (row) noCacheClusters.set(row.cluster, [...(noCacheClusters.get(row.cluster) ?? []), row.log]);
        const noCacheSpeedup = report.mode === "live" && complete && noCacheCaseLogs.every(Boolean)
            ? Math.exp(mean([...noCacheClusters.values()].map(mean))) : null;
        const seed = report.seed + hashString(strategyId);
        const interval = report.mode === "live" && speedup !== null && clusterLogs.length >= 3 ? bootstrap(clusterLogs, seed) : null;
        return {strategyId, speedup, validPairs: valid.length, expectedPairs, noReportedCacheSpeedup: noCacheSpeedup,
            noReportedCachePairs: noCache.length, clusterCount: clusterLogs.length, confidenceInterval95: interval,
            confidenceIntervalReason: report.mode === "smoke" ? "Smoke-mode data are not reported as live latency statistics"
                : clusterLogs.length < 3 ? "At least three independent clusters are required for a bootstrap interval" : undefined,
            conclusion: report.mode === "smoke" ? "smoke-only" as const : "live-statistics" as const};
    });
    const quality = summarizeQuality(report, trials);
    return {
        mode: report.mode, conclusion: report.mode === "smoke" ? "smoke-only" : "live-statistics",
        scoringMode: report.scoringMode, repetitions: report.repetitions, baselineStrategyId: "stock", cases: caseStats,
        strategies: report.strategyIds.map((strategyId) => strategyMetrics(strategyId, trials, report.caseIds, report.repetitions)),
        comparisons: comparisonStats, quality,
    };
}

function pairedTrials(report: BenchmarkReport, byKey: Map<string, BenchmarkTrial>, caseId: string, strategyId: string) {
    return Array.from({length: report.repetitions}, (_, repetition) => {
        const baseline = byKey.get(keyOf(caseId, "stock", repetition));
        const candidate = byKey.get(keyOf(caseId, strategyId, repetition));
        return baseline && candidate ? {baseline, candidate} : undefined;
    }).filter((pair): pair is {baseline: BenchmarkTrial; candidate: BenchmarkTrial} => pair !== undefined);
}
function validTrial(trial: BenchmarkTrial): boolean {
    const result = trial.result;
    return result.metadataPassed && !result.error && result.cleanupComplete && Number.isFinite(result.durationMs) &&
        result.durationMs > 0 && typeof result.summary === "string" && result.summary.trim().length > 0;
}
function knownUsage(trial: BenchmarkTrial): boolean {
    return trial.result.usageComplete && trial.result.calls.every((call) => call.usageComplete);
}
function validPair({baseline, candidate}: {baseline: BenchmarkTrial; candidate: BenchmarkTrial}): boolean {
    return validTrial(baseline) && validTrial(candidate) && baseline.result.inputHash === candidate.result.inputHash;
}
function ratio(pair: {baseline: BenchmarkTrial; candidate: BenchmarkTrial}): number {
    return pair.baseline.result.durationMs / pair.candidate.result.durationMs;
}
function summarizeQuality(report: BenchmarkReport, trials: BenchmarkTrial[]): BenchmarkStatistics["quality"] {
    const expectedJudgments = report.caseIds.length * report.strategyIds.length * report.repetitions * report.judgeRepetitions;
    const trialById = new Map(trials.map((trial) => [trial.id, trial]));
    const knownTrialIds = new Set(trialById.keys());
    const judgmentsByTrial = new Map<string, typeof report.judgments>();
    const seen = new Set<string>();
    for (const judgment of report.judgments) {
        if (!knownTrialIds.has(judgment.trialId)) throw new Error(`Unknown judgment trial ID: ${judgment.trialId}`);
        if (!Number.isSafeInteger(judgment.judgeRepetition) || judgment.judgeRepetition < 0 || judgment.judgeRepetition >= report.judgeRepetitions) {
            throw new Error(`Invalid judge repetition: ${judgment.judgeRepetition}`);
        }
        const key = `${judgment.trialId}\0${judgment.judgeRepetition}`;
        if (seen.has(key)) throw new Error(`Duplicate judgment: ${key}`);
        seen.add(key);
        judgmentsByTrial.set(judgment.trialId, [...(judgmentsByTrial.get(judgment.trialId) ?? []), judgment]);
    }
    let unscoredJudgments = 0, criticalFailures = 0, contradictions = 0, unsupportedReviewFlags = 0;
    const scores = new Map<string, Array<{cluster: string; caseId: string; score: number}>>();
    const strategyQuality: BenchmarkStatistics["quality"]["strategies"] = [];
    let complete = report.judgeRepetitions > 0 && report.judgments.length === expectedJudgments;
    for (const strategyId of report.strategyIds) {
        const rows: Array<{cluster: string; caseId: string; score: number}> = [];
        let pass = 0, fail = 0, review = 0, unscored = 0, strategyCritical = 0, strategyContradictions = 0;
        for (const caseId of report.caseIds) for (let repetition = 0; repetition < report.repetitions; repetition++) {
            const trial = trialById.get(byTrialKey(trials, caseId, strategyId, repetition));
            const baseline = trialById.get(byTrialKey(trials, caseId, "stock", repetition));
            const judgments = trial ? judgmentsByTrial.get(trial.id) ?? [] : [];
            if (!trial || judgments.length !== report.judgeRepetitions || !validTrial(trial) || !baseline || !validTrial(baseline) || trial.result.inputHash !== baseline.result.inputHash) complete = false;
            if (!trial || judgments.length !== report.judgeRepetitions) continue;
            const grades = judgments.map((judgment) => judgment.grade);
            const graded = grades.filter((grade): grade is Extract<ValueGrade, {status: "graded"}> => grade.status === "graded");
            unscored += grades.length - graded.length;
            unscoredJudgments += grades.length - graded.length;
            if (graded.length !== grades.length) { complete = false; continue; }
            for (const grade of graded) {
                if (grade.gate === "pass") pass++;
                else if (grade.gate === "fail") fail++;
                else review++;
                strategyCritical += grade.value.criticalFailures.length;
                strategyContradictions += grade.value.contradictions.length;
                criticalFailures += grade.value.criticalFailures.length;
                contradictions += grade.value.contradictions.length;
                unsupportedReviewFlags += grade.unsupportedClaims.length + (grade.gate === "review" ? 1 : 0);
            }
            rows.push({cluster: trial.cluster, caseId, score: mean(graded.map((grade) => grade.value.score))});
        }
        strategyQuality.push({strategyId, pass, fail, review, unscored, criticalFailures: strategyCritical, contradictions: strategyContradictions});
        scores.set(strategyId, rows);
    }
    const means = report.strategyIds.map((strategyId) => ({strategyId, value: report.mode === "live" && complete ? qualityMean(scores.get(strategyId) ?? []) : null}));
    const baselineMean = means[0]?.value;
    const deltas = means.slice(1).map((entry) => ({strategyId: entry.strategyId,
        value: report.mode === "live" && complete && baselineMean !== null && entry.value !== null ? entry.value - baselineMean : null}));
    const delta = deltas.length === 1 ? deltas[0]!.value : null;
    return {complete: report.mode === "live" && complete, conclusion: report.mode === "smoke" ? "smoke-only" : "live-statistics",
        expectedJudgments, receivedJudgments: report.judgments.length, unscoredJudgments, criticalFailures, contradictions, unsupportedReviewFlags, means, deltas,
        strategies: strategyQuality, delta: report.mode === "live" ? delta : null};
}
function byTrialKey(trials: BenchmarkTrial[], caseId: string, strategyId: string, repetition: number): string {
    return trials.find((trial) => trial.result.fixture === caseId && trial.result.experiment === strategyId && trial.result.repetition === repetition)?.id ?? "";
}
function qualityMean(rows: Array<{cluster: string; caseId: string; score: number}>): number | null {
    if (!rows.length) return null;
    const caseScores = new Map<string, {cluster: string; scores: number[]}>();
    for (const row of rows) {
        const current = caseScores.get(row.caseId) ?? {cluster: row.cluster, scores: []};
        current.scores.push(row.score); caseScores.set(row.caseId, current);
    }
    const clusters = new Map<string, number[]>();
    for (const row of caseScores.values()) clusters.set(row.cluster, [...(clusters.get(row.cluster) ?? []), mean(row.scores)]);
    return mean([...clusters.values()].map(mean));
}
function strategyMetrics(strategyId: string, trials: BenchmarkTrial[], caseIds: string[], repetitions: number): BenchmarkStatistics["strategies"][number] {
    const matching = trials.filter((trial) => trial.result.experiment === strategyId);
    const expectedTrials = caseIds.length * repetitions;
    const completed = matching.filter(validTrial).length;
    const failedTrials = matching.length - completed;
    const unknownUsageCalls = matching.reduce((sum, trial) => sum + trial.result.calls.filter((call) => !call.usageComplete).length, 0);
    const usageComplete = matching.length === expectedTrials && matching.every(knownUsage);
    const summaries = matching.filter(validTrial).flatMap((trial) => trial.result.summary === undefined ? [] : [trial.result.summary.length]);
    const sum = (pick: (trial: BenchmarkTrial) => number) => matching.reduce((total, trial) => total + pick(trial), 0);
    return {strategyId, calls: sum((trial) => trial.result.calls.length),
        inputTokens: usageComplete ? sum((trial) => trial.result.usage.input + trial.result.usage.cacheRead + trial.result.usage.cacheWrite) : null,
        outputTokens: usageComplete ? sum((trial) => trial.result.usage.output) : null,
        cost: usageComplete ? sum((trial) => trial.result.usage.cost) : null,
        cacheReadTokens: usageComplete ? sum((trial) => trial.result.usage.cacheRead) : null,
        cacheWriteTokens: usageComplete ? sum((trial) => trial.result.usage.cacheWrite) : null,
        usageComplete, unknownUsageCalls, expectedTrials, completedTrials: completed, failedTrials, missingTrials: expectedTrials - matching.length,
        successRate: expectedTrials ? completed / expectedTrials : 0, medianSummaryCharacters: median(summaries)};
}
function validateIds(ids: string[], name: string): void {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || id.trim() === "") || new Set(ids).size !== ids.length) {
        throw new Error(`${name} must contain unique, non-empty IDs`);
    }
}
function keyOf(caseId: string, strategyId: string, repetition: number): string { return `${caseId}\0${strategyId}\0${repetition}`; }
function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function shuffled<T>(values: T[], random: () => number): T[] {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j]!, result[i]!]; }
    return result;
}
function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => { state = (state + 0x6D2B79F5) | 0; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
function bootstrap(logs: number[], seed: number): [number, number] {
    const random = seededRandom(seed), estimates: number[] = [];
    for (let sample = 0; sample < 1000; sample++) {
        const selected = Array.from({length: logs.length}, () => logs[Math.floor(random() * logs.length)]!);
        estimates.push(Math.exp(mean(selected)));
    }
    estimates.sort((a, b) => a - b);
    return [estimates[24]!, estimates[974]!];
}
function hashString(value: string): number { let hash = 0; for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); return hash; }
