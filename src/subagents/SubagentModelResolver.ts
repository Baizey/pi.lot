import type {
    ExtensionContext,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "./SubagentReasoning.js";
import {
    AUTO_SUBAGENT_MODEL,
    type SubagentModelPreference,
} from "./SubagentDefaults.js";

const ESTIMATED_INPUT_TOKENS = 100_000;
const ESTIMATED_OUTPUT_TOKENS = 20_000;
const TOKENS_PER_MILLION = 1_000_000;
const NORMAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const SUBAGENT_THINKING_LEVELS = ["low", "medium", "high"] as const;
const EXTENDED_THINKING_LEVELS = ["xhigh", "max"] as const;

export type SubagentModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export type SubagentModelPerformance = {
    model: SubagentModel;
    score: number;
};

/**
 * Owns the replaceable definition of model performance. A future benchmark-backed
 * implementation can replace this ranker without changing capability resolution.
 */
export interface SubagentModelPerformanceRanker {
    readonly source: string;

    rank(
        models: readonly SubagentModel[],
        signal?: AbortSignal,
    ): Promise<readonly SubagentModelPerformance[]>;
}

export type ResolvedSubagentModel = {
    model: SubagentModel;
    thinkingLevel: ThinkingLevel;
    estimatedCost: number;
    performanceScore: number;
    performanceSource: string;
};

/**
 * Uses catalogue price as a deliberately weak market-tier proxy, then objective
 * model capacities to distinguish otherwise equally priced models.
 */
export class CatalogueSubagentModelPerformanceRanker implements SubagentModelPerformanceRanker {
    readonly source = "catalogue-cost-capability";

    async rank(models: readonly SubagentModel[]): Promise<readonly SubagentModelPerformance[]> {
        const ordered = [...models].sort(compareCataloguePerformance);
        const scores = new Map<SubagentModel, number>();
        let score = 0;
        let previous: SubagentModel | undefined;
        for (const model of ordered) {
            if (previous && compareCataloguePerformance(previous, model) !== 0) score++;
            scores.set(model, score);
            previous = model;
        }
        return models.map((model) => ({model, score: scores.get(model)!}));
    }
}

export class SubagentModelResolver {
    constructor(
        private readonly modelRuntime: Pick<ModelRuntime, "getAvailable">,
        private readonly performanceRanker: SubagentModelPerformanceRanker = (
            new CatalogueSubagentModelPerformanceRanker()
        ),
        private readonly preferredProvider?: string,
    ) {
    }

    async resolve(
        reasoningSkill: SubagentReasoningSkill,
        reasoningAmount: SubagentReasoningAmount,
        modelPreference: SubagentModelPreference = AUTO_SUBAGENT_MODEL,
        signal?: AbortSignal,
    ): Promise<ResolvedSubagentModel> {
        if (signal?.aborted) throw abortError();
        const requestedThinkingLevel = thinkingLevelFor(reasoningAmount);
        const available = await this.modelRuntime.getAvailable(undefined, {signal});
        if (signal?.aborted) throw abortError();
        const eligible = available.filter(supportsSubagentReasoning);
        if (modelPreference !== AUTO_SUBAGENT_MODEL) {
            const model = availableModel(modelPreference, available);
            if (!model) {
                throw new Error(`Configured subagent model is not authenticated or available: ${modelPreference}`);
            }
            if (!supportsSubagentReasoning(model)) {
                throw new Error(`Configured subagent model does not support normal reasoning amounts: ${modelPreference}`);
            }
            return {
                model,
                thinkingLevel: clampSubagentThinkingLevel(model, requestedThinkingLevel),
                estimatedCost: effectiveModelCost(model),
                performanceScore: 0,
                performanceSource: "configured-exact-model",
            };
        }
        if (eligible.length === 0) {
            throw new Error("No authenticated model supports normal subagent reasoning amounts");
        }

        const ranked = await this.performanceRanker.rank(eligible, signal);
        if (signal?.aborted) throw abortError();
        const candidates = this.candidates(eligible, ranked);
        const selected = this.select(candidates, reasoningSkill);
        return {
            model: selected.model,
            thinkingLevel: clampSubagentThinkingLevel(selected.model, requestedThinkingLevel),
            estimatedCost: selected.cost,
            performanceScore: selected.score,
            performanceSource: this.performanceRanker.source,
        };
    }

    private candidates(
        eligible: readonly SubagentModel[],
        ranked: readonly SubagentModelPerformance[],
    ): ModelCandidate[] {
        const eligibleModels = new Set(eligible);
        const scores = new Map<SubagentModel, number>();
        for (const entry of ranked) {
            if (!eligibleModels.has(entry.model)) {
                throw new Error("Subagent model ranker returned a model outside the candidate catalogue");
            }
            if (!Number.isFinite(entry.score)) {
                throw new Error("Subagent model ranker returned a non-finite performance score");
            }
            if (scores.has(entry.model)) {
                throw new Error("Subagent model ranker returned a model more than once");
            }
            scores.set(entry.model, entry.score);
        }
        if (scores.size !== eligible.length) {
            throw new Error("Subagent model ranker did not score every candidate model");
        }
        return eligible.map((model) => ({
            model,
            cost: effectiveModelCost(model),
            score: scores.get(model)!,
        }));
    }

    private select(
        candidates: readonly ModelCandidate[],
        reasoningSkill: SubagentReasoningSkill,
    ): ModelCandidate {
        if (reasoningSkill === SubagentReasoningSkill.MIN) {
            return [...candidates].sort((left, right) => (
                left.cost - right.cost
                || right.score - left.score
                || this.compareRoute(left, right)
            ))[0]!;
        }
        if (reasoningSkill === SubagentReasoningSkill.MAX) {
            return [...candidates].sort((left, right) => (
                right.score - left.score
                || left.cost - right.cost
                || this.compareRoute(left, right)
            ))[0]!;
        }

        const frontier = this.performanceCostFrontier(candidates);
        const percentile = reasoningSkill === SubagentReasoningSkill.LOW
            ? 0.25
            : reasoningSkill === SubagentReasoningSkill.MID
                ? 0.5
                : 0.75;
        return frontier[Math.round((frontier.length - 1) * percentile)]!;
    }

    private performanceCostFrontier(candidates: readonly ModelCandidate[]): ModelCandidate[] {
        const nonDominated = candidates.filter((candidate) => !candidates.some((other) => (
            other !== candidate
            && other.cost <= candidate.cost
            && other.score >= candidate.score
            && (other.cost < candidate.cost || other.score > candidate.score)
        )));
        const sorted = [...nonDominated].sort((left, right) => (
            left.cost - right.cost
            || left.score - right.score
            || this.compareRoute(left, right)
        ));
        const frontier: ModelCandidate[] = [];
        for (const candidate of sorted) {
            const previous = frontier.at(-1);
            if (previous && previous.cost === candidate.cost && previous.score === candidate.score) continue;
            frontier.push(candidate);
        }
        return frontier;
    }

    private compareRoute(left: ModelCandidate, right: ModelCandidate): number {
        const leftPreferred = left.model.provider === this.preferredProvider ? 0 : 1;
        const rightPreferred = right.model.provider === this.preferredProvider ? 0 : 1;
        return leftPreferred - rightPreferred
            || canonicalModel(left.model).localeCompare(canonicalModel(right.model));
    }
}

type ModelCandidate = {
    model: SubagentModel;
    cost: number;
    score: number;
};

function compareCataloguePerformance(left: SubagentModel, right: SubagentModel): number {
    return effectiveModelCost(left) - effectiveModelCost(right)
        || supportedThinkingLevelCount(left) - supportedThinkingLevelCount(right)
        || left.contextWindow - right.contextWindow
        || left.maxTokens - right.maxTokens;
}

function effectiveModelCost(model: SubagentModel): number {
    let rates = model.cost;
    let matchedThreshold = -1;
    for (const tier of model.cost.tiers ?? []) {
        if (ESTIMATED_INPUT_TOKENS > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
            rates = tier;
            matchedThreshold = tier.inputTokensAbove;
        }
    }
    return Math.max(0, rates.input) * ESTIMATED_INPUT_TOKENS / TOKENS_PER_MILLION
        + Math.max(0, rates.output) * ESTIMATED_OUTPUT_TOKENS / TOKENS_PER_MILLION;
}

function supportedThinkingLevelCount(model: SubagentModel): number {
    if (!model.reasoning) return 0;
    const normal = NORMAL_THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
    const extended = EXTENDED_THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        return mapped !== undefined && mapped !== null;
    });
    return normal.length + extended.length;
}

function supportsSubagentReasoning(model: SubagentModel): boolean {
    return model.reasoning && SUBAGENT_THINKING_LEVELS.some((level) => supportsThinkingLevel(model, level));
}

function supportsThinkingLevel(model: SubagentModel, level: ThinkingLevel): boolean {
    return model.reasoning && model.thinkingLevelMap?.[level] !== null;
}

function clampSubagentThinkingLevel(model: SubagentModel, requested: ThinkingLevel): ThinkingLevel {
    if (supportsThinkingLevel(model, requested)) return requested;
    const requestedIndex = SUBAGENT_THINKING_LEVELS.indexOf(requested as typeof SUBAGENT_THINKING_LEVELS[number]);
    for (let index = requestedIndex + 1; index < SUBAGENT_THINKING_LEVELS.length; index++) {
        const level = SUBAGENT_THINKING_LEVELS[index]!;
        if (supportsThinkingLevel(model, level)) return level;
    }
    for (let index = requestedIndex - 1; index >= 0; index--) {
        const level = SUBAGENT_THINKING_LEVELS[index]!;
        if (supportsThinkingLevel(model, level)) return level;
    }
    throw new Error(`Selected subagent model does not support normal reasoning amounts: ${canonicalModel(model)}`);
}

function thinkingLevelFor(amount: SubagentReasoningAmount): ThinkingLevel {
    switch (amount) {
        case SubagentReasoningAmount.LOW:
            return "low";
        case SubagentReasoningAmount.MID:
            return "medium";
        case SubagentReasoningAmount.HIGH:
            return "high";
    }
}

function availableModel(modelPreference: string, models: readonly SubagentModel[]): SubagentModel | undefined {
    return models.find((model) => canonicalModel(model) === modelPreference);
}

function canonicalModel(model: SubagentModel): string {
    return `${model.provider}/${model.id}`;
}

function abortError(): Error {
    const error = new Error("Subagent model resolution was aborted");
    error.name = "AbortError";
    return error;
}
