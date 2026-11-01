import type {AssistantMessage} from "@earendil-works/pi-ai/compat";
import type {CompactionPreparation, EvaluationTrial} from "./CompactionEvaluation.js";

export type ValueCategory = "goal" | "constraint" | "decision" | "state" | "next-action" | "identifier";
export const VALUE_CATEGORIES: readonly ValueCategory[] = ["goal", "constraint", "decision", "state", "next-action", "identifier"];

/** Native source and separately labelled grade-only assembly provenance; never candidate output or grading answers. */
export type ReferenceInput = {id: "previous-summary" | "history" | "turn-prefix" | "file-operations"; text: string};
export type ValueFact = {
    id: string;
    statement: string;
    category: ValueCategory;
    weight: number;
    critical: boolean;
    evidence: Array<{inputId: ReferenceInput["id"]; quote: string}>;
};
export type ValueRubric = {version: 1; status: "draft" | "curated"; facts: ValueFact[]};

export type BenchmarkCase = {
    id: string;
    cluster: string;
    source: {file: string; checkpoint: number; sha256: string};
    preparationHash: string;
    referenceHash: string;
    tokensBefore: number;
    historyMessages: number;
    prefixMessages: number;
    rubric?: ValueRubric;
};
export type BenchmarkCorpus = {
    version: 1;
    piVersion: string;
    cases: BenchmarkCase[];
    rejected: Array<{file: string; checkpoint?: number; reason: string}>;
};
export type PreparedBenchmarkCase = {definition: BenchmarkCase; preparation: CompactionPreparation; reference: ReferenceInput[]};

export type FactJudgment = {
    factId: string;
    status: "retained" | "partial" | "missing" | "contradicted";
    /** Exact contiguous candidate-summary quote; empty for missing facts. */
    evidence: string;
    reason: string;
};
export type UnsupportedClaim = {quote: string; reason: string};
export type ValueScore = {
    score: number;
    rawScore: number;
    totalWeight: number;
    categories: Partial<Record<ValueCategory, number>>;
    criticalFailures: string[];
    contradictions: string[];
};
export type ValueGrade = {
    status: "graded";
    judgments: FactJudgment[];
    unsupportedClaims: UnsupportedClaim[];
    value: ValueScore;
    gate: "pass" | "fail" | "review";
} | {status: "unscored"; error: string};

/** A provider capability, supplied by the budget owner; graders never load credentials themselves. */
export type BenchmarkComplete = (system: string, prompt: string, signal: AbortSignal) => Promise<AssistantMessage>;
export type BenchmarkJudgment = {trialId: string; judgeRepetition: number; grade: ValueGrade};
export type BenchmarkTrial = {id: string; cluster: string; result: EvaluationTrial};

export type BenchmarkReport = {
    version: 1;
    mode: "smoke" | "live";
    corpusHash: string;
    model: string;
    thinking: string;
    seed: number;
    repetitions: number;
    judgeRepetitions: number;
    caseIds: string[];
    strategyIds: string[];
    scoringMode: "curated" | "exploratory" | "speed-only";
    timingScope: "summary-strategy-including-worker-cleanup";
    trials: BenchmarkTrial[];
    judgments: BenchmarkJudgment[];
    interrupted?: string;
};
