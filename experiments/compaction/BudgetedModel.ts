import {performance} from "node:perf_hooks";
import {normalizeContext, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type ModelThinkingLevel, type ThinkingBudgets} from "@earendil-works/pi-ai";
import {adjustMaxTokensForThinking} from "@earendil-works/pi-ai/api/simple-options";
import type {ModelRuntime} from "@earendil-works/pi-coding-agent";
import type {BenchmarkComplete} from "./BenchmarkTypes.js";
import type {CompactionModel, CompactionStream, CompactionThinkingLevel} from "./CompactionEvaluation.js";

export type BudgetSnapshot = {
    calls: Array<{
        phase: "summary" | "judge" | "rubric";
        durationMs: number;
        model: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        costUsd?: number;
        inputCostUsd?: number;
        outputCostUsd?: number;
        cacheReadCostUsd?: number;
        cacheWriteCostUsd?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        completion: boolean;
        outputCap: number;
        reservedOutputTokens: number;
        status: "reserved" | "settled" | "unknown" | "blocked";
        error?: string;
    }>;
    spentUsd: number;
    reservedUsd: number;
    limits: {maxCalls: number; maxCostUsd: number; maxOutputTokens: number; thinkingLevel: CompactionThinkingLevel};
    modelRateCard: {
        provider: string;
        id: string;
        api: string;
        contextWindow: number;
        maxTokens: number;
        reasoning: boolean;
        cost: CompactionModel["cost"];
    };
    blockedReason?: string;
};

type Phase = "summary" | "judge" | "rubric";
type StreamOptions = Parameters<ModelRuntime["streamSimple"]>[2];
type StreamModel = Parameters<CompactionStream>[0];
type StreamContext = Parameters<CompactionStream>[1];

/** A conservative SDK estimate only; provider billing can differ and this is not an invoice guarantee. */
export class BudgetedModel {
    private readonly modelFingerprint: string;
    private readonly ledger: BudgetSnapshot;
    private readonly model: CompactionModel;
    private readonly limits: {maxCalls: number; maxCostUsd: number; maxOutputTokens: number; thinkingLevel: CompactionThinkingLevel};

    constructor(
        private readonly runtime: ModelRuntime,
        model: CompactionModel,
        limits: {maxCalls: number; maxCostUsd: number; maxOutputTokens: number; thinkingLevel: CompactionThinkingLevel},
    ) {
        for (const [name, value] of Object.entries({maxCalls: limits.maxCalls, maxOutputTokens: limits.maxOutputTokens})) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
        }
        if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0) throw new Error("maxCostUsd must be finite and positive");
        const rates = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite,
            ...(model.cost.tiers ?? []).flatMap((tier) => [tier.input, tier.output, tier.cacheRead, tier.cacheWrite])];
        if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) {
            throw new Error("Model catalogue rates must be finite and non-negative");
        }
        this.model = structuredClone(model);
        this.limits = {...limits};
        this.modelFingerprint = JSON.stringify(this.model);
        this.ledger = {calls: [], spentUsd: 0, reservedUsd: 0, limits: {...this.limits}, modelRateCard: {
            provider: this.model.provider, id: this.model.id, api: this.model.api,
            contextWindow: this.model.contextWindow, maxTokens: this.model.maxTokens,
            reasoning: this.model.reasoning, cost: structuredClone(this.model.cost),
        }};
    }

    get blockedReason(): string | undefined { return this.ledger.blockedReason; }

    snapshot(): BudgetSnapshot { return structuredClone(this.ledger); }

    stream(phase: "summary" | "judge" | "rubric"): CompactionStream {
        return (requestedModel, context, options) => this.startStream(phase, requestedModel, context, options);
    }

    complete(phase: "judge" | "rubric"): BenchmarkComplete {
        return async (system, prompt, signal) => {
            const context = normalizeContext({messages: [
                {role: "system", content: system, timestamp: Date.now()},
                {role: "user", content: prompt, timestamp: Date.now()},
            ]});
            const stream = this.startRequest(phase, this.model, context, {
                signal, maxTokens: this.limits.maxOutputTokens,
                ...(this.model.reasoning && this.limits.thinkingLevel !== "off"
                    ? {reasoning: this.limits.thinkingLevel as Exclude<ModelThinkingLevel, "off">} : {}),
            }, true);
            const response = await stream;
            return response.result();
        };
    }

    private startStream(phase: Phase, requestedModel: StreamModel, context: StreamContext, options?: Parameters<CompactionStream>[2]) {
        if (JSON.stringify(requestedModel) !== this.modelFingerprint) {
            throw new Error("BudgetedModel rejected a changed model configuration");
        }
        const expectedThinking = this.model.reasoning ? this.limits.thinkingLevel : "off";
        if ((options?.reasoning ?? "off") !== expectedThinking) {
            throw new Error("BudgetedModel rejected a changed thinking level");
        }
        return this.startRequest(phase, requestedModel, context, options, false);
    }

    private startRequest(
        phase: Phase, requestedModel: CompactionModel, context: Context, options: StreamOptions | undefined, completion: boolean,
    ) {
        const requestedOutput = options?.maxTokens ?? this.limits.maxOutputTokens;
        if (!Number.isSafeInteger(requestedOutput) || requestedOutput <= 0) {
            throw new Error("Requested maxTokens must be a positive safe integer");
        }
        const outputCap = Math.min(requestedOutput, this.limits.maxOutputTokens, requestedModel.maxTokens);
        const serialized = JSON.stringify(context);
        const inputBytes = Buffer.byteLength(serialized, "utf8") + 256; // Framing allowance for role/message boundaries.
        const tiers = requestedModel.cost.tiers ?? [];
        const inputRate = Math.max(requestedModel.cost.input, requestedModel.cost.cacheRead, requestedModel.cost.cacheWrite,
            ...tiers.flatMap((tier) => [tier.input, tier.cacheRead, tier.cacheWrite]));
        const outputRate = Math.max(requestedModel.cost.output, ...tiers.map((tier) => tier.output));
        const reservedOutputTokens = this.reservedOutputTokens(requestedModel, outputCap, options?.thinkingBudgets);
        const reservation = (inputBytes * inputRate + reservedOutputTokens * outputRate) / 1_000_000;
        if (this.ledger.blockedReason) throw new Error(this.ledger.blockedReason);
        if (this.ledger.calls.length >= this.limits.maxCalls) {
            this.block("Maximum provider call count reached");
            throw new Error(this.ledger.blockedReason);
        }
        if (!Number.isFinite(reservation) || this.ledger.spentUsd + this.ledger.reservedUsd + reservation > this.limits.maxCostUsd) {
            this.block("Insufficient remaining cost budget for conservative request reservation");
            throw new Error(this.ledger.blockedReason);
        }
        const call: BudgetSnapshot["calls"][number] = {
            phase, durationMs: 0, model: `${requestedModel.provider}/${requestedModel.id}`, completion, outputCap,
            reservedOutputTokens, status: "reserved",
        };
        this.ledger.calls.push(call);
        this.ledger.reservedUsd += reservation;
        const started = performance.now();
        const cappedOptions = {...options, maxTokens: outputCap, maxRetries: 0, cacheRetention: "none" as const,
            ...(requestedModel.reasoning && this.limits.thinkingLevel !== "off"
                ? {reasoning: this.limits.thinkingLevel as Exclude<ModelThinkingLevel, "off">} : {})};
        let providerStream: ReturnType<ModelRuntime["streamSimple"]>;
        try {
            providerStream = this.runtime.streamSimple(requestedModel, context, cappedOptions);
        } catch {
            this.markUnknown(call, reservation, started, "Provider request failed");
            throw new Error("Provider request failed");
        }
        // Gate every completion path on metering; the unmodified SDK stream would expose a failed result
        // before this asynchronous observer had blocked subsequent calls.
        const meteredResult = Promise.resolve().then(() => providerStream.result()).then((response) => {
            const usage = response.usage;
            const usageTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
            const costComponents = [usage.cost.input, usage.cost.output, usage.cost.cacheRead, usage.cost.cacheWrite];
            const costComponentTotal = costComponents.reduce((total, value) => total + value, 0);
            const costTolerance = Math.max(1e-12, Math.abs(usage.cost.total) * 1e-6);
            const costConsistent = costComponentTotal === 0
                ? usage.cost.total === 0
                : usage.cost.total > 0 && Math.abs(costComponentTotal - usage.cost.total) <= costTolerance;
            const usageValues = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens,
                ...costComponents, usage.cost.total];
            call.inputTokens = usage.input;
            call.outputTokens = usage.output;
            call.totalTokens = usage.totalTokens;
            call.cacheReadTokens = usage.cacheRead;
            call.cacheWriteTokens = usage.cacheWrite;
            call.inputCostUsd = usage.cost.input;
            call.outputCostUsd = usage.cost.output;
            call.cacheReadCostUsd = usage.cost.cacheRead;
            call.cacheWriteCostUsd = usage.cost.cacheWrite;
            call.costUsd = usage.cost.total;
            if (response.stopReason === "error" || response.stopReason === "aborted") {
                this.markUnknown(call, reservation, started, response.stopReason === "aborted"
                    ? "Provider request aborted" : "Provider returned an error response");
                return this.sanitizeFailureResponse(response);
            }
            if (usageValues.some((value) => !Number.isFinite(value) || value < 0) || usageTokens <= 0 || !costConsistent) {
                this.markUnknown(call, reservation, started, "Provider usage is invalid");
                throw new Error("Provider usage is invalid");
            }
            this.ledger.reservedUsd -= reservation;
            this.ledger.spentUsd += usage.cost.total;
            call.durationMs = performance.now() - started;
            call.status = "settled";
            if (usage.cost.total > reservation || this.ledger.spentUsd + this.ledger.reservedUsd > this.limits.maxCostUsd) {
                this.block("Reported provider cost exceeded the conservative reservation or budget");
            }
            return response;
        }).catch(() => {
            this.markUnknown(call, reservation, started, "Provider response or usage is invalid");
            throw new Error("Provider request failed");
        });
        // Retain a rejection observer if callers consume only events or abandon the stream.
        void meteredResult.catch(() => {});
        return Promise.resolve(this.wrapStream(providerStream, meteredResult));
    }

    private reservedOutputTokens(
        requestedModel: CompactionModel, outputCap: number, thinkingBudgets?: ThinkingBudgets,
    ): number {
        if (!requestedModel.reasoning || this.limits.thinkingLevel === "off") return outputCap;
        if (requestedModel.api !== "anthropic-messages" && requestedModel.api !== "bedrock-converse-stream") {
            // These adapters are the only ones that expand maxTokens by adding a reasoning budget.
            // Unknown/custom APIs stay fail-safe because their behavior is not known to this client.
            const knownCapAdapters = ["openai-responses", "openai-completions", "openai-codex-responses",
                "azure-openai-responses", "google-generative-ai", "google-vertex"];
            return knownCapAdapters.includes(requestedModel.api) ? outputCap : requestedModel.maxTokens;
        }
        for (const [level, value] of Object.entries(thinkingBudgets ?? {})) {
            if (!Number.isSafeInteger(value) || value! < 0) {
                throw new Error(`thinkingBudgets.${level} must be a non-negative safe integer`);
            }
        }
        return adjustMaxTokensForThinking(outputCap, requestedModel.maxTokens,
            this.limits.thinkingLevel as Exclude<ModelThinkingLevel, "off">, thinkingBudgets).maxTokens;
    }

    private wrapStream(
        stream: AssistantMessageEventStream, meteredResult: Promise<AssistantMessage>,
    ): AssistantMessageEventStream {
        const originalIterator = stream[Symbol.asyncIterator].bind(stream);
        const sanitizeFailureResponse = this.sanitizeFailureResponse.bind(this);
        return new Proxy(stream, {
            get(target, property) {
                if (property === "result") return () => meteredResult;
                if (property === Symbol.asyncIterator) return () => {
                    const iterator = originalIterator();
                    return (async function* () {
                        while (true) {
                            let item: IteratorResult<AssistantMessageEvent>;
                            try {
                                item = await iterator.next();
                            } catch {
                                try { await meteredResult; } catch { /* The public failure stays controlled below. */ }
                                throw new Error("Provider stream failed");
                            }
                            if (item.done) {
                                await meteredResult;
                                return;
                            }
                            if (item.value.type === "done" || item.value.type === "error") await meteredResult;
                            yield item.value.type === "error"
                                ? {...item.value, error: sanitizeFailureResponse(item.value.error)} : item.value;
                        }
                    })();
                };
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    }

    private sanitizeFailureResponse(response: AssistantMessage): AssistantMessage {
        const validUsageValue = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;
        return {
            role: "assistant",
            content: [],
            api: this.model.api,
            provider: this.model.provider,
            model: this.model.id,
            timestamp: Number.isFinite(response.timestamp) ? response.timestamp : Date.now(),
            stopReason: response.stopReason === "aborted" ? "aborted" : "error",
            errorMessage: response.stopReason === "aborted" ? "Provider request aborted" : "Provider request failed",
            usage: {
                input: validUsageValue(response.usage.input),
                output: validUsageValue(response.usage.output),
                cacheRead: validUsageValue(response.usage.cacheRead),
                cacheWrite: validUsageValue(response.usage.cacheWrite),
                totalTokens: validUsageValue(response.usage.totalTokens),
                cost: {
                    input: validUsageValue(response.usage.cost.input),
                    output: validUsageValue(response.usage.cost.output),
                    cacheRead: validUsageValue(response.usage.cost.cacheRead),
                    cacheWrite: validUsageValue(response.usage.cost.cacheWrite),
                    total: validUsageValue(response.usage.cost.total),
                },
            },
        };
    }

    private markUnknown(
        call: BudgetSnapshot["calls"][number], _reservation: number, started: number, controlledReason: string,
    ): void {
        // Reservation is deliberately retained: missing, failed, or synthetic usage is not evidence of zero cost.
        call.durationMs = performance.now() - started;
        call.status = "unknown";
        call.error = controlledReason;
        this.block("Provider usage is unknown; future calls are blocked");
    }

    private block(reason: string): void { this.ledger.blockedReason ??= reason; }
}
