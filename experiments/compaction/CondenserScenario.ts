import type {CompactionPreparation} from "./CompactionEvaluation.js";
import {fingerprint} from "./CompactionEvaluation.js";
import {referenceInputs} from "./BenchmarkCorpus.js";
import {validateRubric} from "./ValueRetention.js";
import type {AssistantMessage} from "@earendil-works/pi-ai/compat";
import type {PreparedBenchmarkCase, ValueFact} from "./BenchmarkTypes.js";

export type CondenserScenario = {
    id: string;
    cluster: string;
    mode: "development" | "holdout";
    preparationMode: "whole" | "split" | "iterative";
    turns: Array<[string, string]>;
    facts: Array<Omit<ValueFact, "evidence"> & {quote: string}>;
    previousSummary?: string;
    files: {read: string[]; written: string[]; edited: string[]};
};

/** Native-visible preparation and draft rubric shared by independently authored scenario suites. */
export function buildCondenserScenario(scenario: CondenserScenario): PreparedBenchmarkCase {
    const allMessages = messagesFor(scenario);
    const isSplitTurn = scenario.preparationMode === "split";
    const messagesToSummarize = isSplitTurn ? allMessages.slice(0, -2) : allMessages;
    const turnPrefixMessages: CompactionPreparation["turnPrefixMessages"] = isSplitTurn
        ? allMessages.slice(-2) : [];
    const preparation = {
        previousSummary: scenario.preparationMode === "iterative" ? scenario.previousSummary : undefined,
        messagesToSummarize,
        turnPrefixMessages,
        firstKeptEntryId: `${scenario.id}:boundary:0001`,
        tokensBefore: 20_000,
        settings: {enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_000},
        fileOps: {read: new Set(scenario.files.read), written: new Set(scenario.files.written), edited: new Set(scenario.files.edited)},
        isSplitTurn
    } satisfies CompactionPreparation;
    const reference = referenceInputs(preparation);
    const estimatedSourceChars = reference.reduce((total, input) => total + input.text.length, 0);
    preparation.tokensBefore = 20_000 + Math.ceil(estimatedSourceChars / 3.5);
    const facts: ValueFact[] = scenario.facts.map(({quote, ...fact}) => {
        const input = reference.find(({id, text}) => (id === "history" || id === "turn-prefix") && text.includes(quote));
        if (!input) throw new Error(`Scenario ${scenario.id} rubric quote is absent from native source: ${fact.id}`);
        return {...fact, evidence: [{inputId: input.id, quote}]};
    });
    const rubric = validateRubric({version: 1, status: "draft", facts}, reference);
    const sourceHashInput = {
        previousSummary: preparation.previousSummary,
        history: reference.find(({id}) => id === "history")?.text,
        turnPrefix: reference.find(({id}) => id === "turn-prefix")?.text
    };
    const definition = {
        id: scenario.id,
        cluster: scenario.cluster,
        source: {
            file: `/tmp/synthetic-condenser/${scenario.id}.conversation.txt`,
            checkpoint: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
            sha256: fingerprint(sourceHashInput)
        },
        preparationHash: fingerprint(preparation), referenceHash: fingerprint(reference),
        tokensBefore: preparation.tokensBefore, historyMessages: preparation.messagesToSummarize.length,
        prefixMessages: preparation.turnPrefixMessages.length, rubric
    };
    return {definition, preparation, reference};
}

function messagesFor(scenario: CondenserScenario): CompactionPreparation["messagesToSummarize"] {
    return scenario.turns.flatMap(([user, assistant], index) => [
        {role: "user" as const, content: [{type: "text" as const, text: user}], timestamp: index * 2 + 1},
        assistantMessage(assistant, index * 2 + 2)
    ]);
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
    return {
        role: "assistant", content: [{type: "text", text}], timestamp,
        api: "openai-completions", provider: "synthetic", model: "conversation-record",
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason: "stop"
    };
}
