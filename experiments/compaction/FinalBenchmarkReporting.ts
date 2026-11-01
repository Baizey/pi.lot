import {summarizeBenchmark} from "./BenchmarkStatistics.js";
import type {BenchmarkReport} from "./BenchmarkTypes.js";

export type FinalReportBlock = {group: string; report: BenchmarkReport};
export type RepetitionCorrection = {trialId: string; from: number; to: 0};

/** The measured receipt is immutable. Group identity already distinguishes the separately scheduled timing repeat. */
export function normalizeFinalBlock(block: FinalReportBlock): {report: BenchmarkReport; corrections: RepetitionCorrection[]} {
    const report = structuredClone(block.report);
    const corrections: RepetitionCorrection[] = [];
    if (block.group === "heldout-split-repeat" && report.repetitions === 1) {
        for (const trial of report.trials) {
            if (trial.result.repetition === 2) {
                corrections.push({trialId: trial.id, from: 2, to: 0});
                trial.result.repetition = 0;
            }
        }
    }
    // Other malformed indices remain errors rather than being silently repaired.
    summarizeBenchmark(report);
    return {report, corrections};
}

export function summarizeFinalCondition(condition: {id: string; reports: FinalReportBlock[]}) {
    const blocks = condition.reports.map((block) => {
        const normalized = normalizeFinalBlock(block);
        return {group: block.group, ...normalized, statistics: summarizeBenchmark(normalized.report)};
    });
    const pairs = blocks.filter((block) => block.group === "heldout-split" || block.group === "historical-split")
        .flatMap((block) => block.statistics.cases.flatMap((item) => item.comparisons.map((comparison) => ({
            group: block.group, caseId: item.caseId, strategyId: comparison.strategyId,
            speedup: comparison.pairedMedianSpeedup, validPairs: comparison.validPairs,
            noReportedCacheSpeedup: comparison.noReportedCachePairedSpeedup,
            noReportedCachePairs: comparison.noReportedCachePairs,
        }))));
    const primarySplitComparisons = ["parallel-split", "semantic-unified-v6"].map((strategyId) => {
        const matching = pairs.filter((pair) => pair.strategyId === strategyId);
        const valid = matching.flatMap((pair) => pair.speedup === null ? [] : [pair.speedup]);
        const uncached = matching.flatMap((pair) => pair.noReportedCacheSpeedup === null ? [] : [pair.noReportedCacheSpeedup]);
        return {strategyId, expectedCases: 3, completedCases: valid.length,
            geometricMeanSpeedup: valid.length === 3 ? geometricMean(valid) : null,
            noReportedCacheSubset: {cases: uncached.length, geometricMeanSpeedup: geometricMean(uncached),
                excludedCaseIds: matching.filter((pair) => pair.noReportedCachePairs === 0).map((pair) => pair.caseId)},
            perCase: matching};
    });
    return {condition: condition.id, primarySplitComparisons,
        groups: blocks.map(({group, corrections, statistics}) => ({group, corrections, statistics})),
        methodology: "Speedup = stock elapsed / candidate elapsed; PRIMARY split geometric means weight each of the three cases equally. Timing-only repeats are separate. The no-reported-cache subset excludes any pair with reported cache reads in either strategy, not a claim of verified provider cache absence. One primary observation per strategy/case/condition; no general latency guarantee."};
}

function geometricMean(values: number[]): number | null {
    return values.length ? Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length) : null;
}
