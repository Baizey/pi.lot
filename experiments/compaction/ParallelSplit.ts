import {compact} from "@earendil-works/pi-coding-agent";
import {fingerprint} from "./CompactionEvaluation.js";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import type {CompactionExperiment, CompactionStream} from "./CompactionEvaluation.js";

/** Experimental adapter: parallelizes only the independent history and split-turn requests. */
const parallelSplit: CompactionExperiment = {
    id: "parallel-split",
    async run(input) {
        const {preparation, model, thinkingLevel, signal, stream} = input;
        if (!preparation.isSplitTurn || preparation.messagesToSummarize.length === 0 || preparation.turnPrefixMessages.length === 0) {
            return compact(preparation, model, undefined, undefined, undefined, signal, thinkingLevel, stream);
        }
        const planned: Array<{model: typeof model; context: Parameters<CompactionStream>[1]; options: Parameters<CompactionStream>[2]}> = [];
        const planning: CompactionStream = (requestedModel, context, options) => {
            planned.push({model: requestedModel, context, options});
            return completedStream(requestedModel);
        };
        await compact(preparation, model, undefined, undefined, undefined, signal, thinkingLevel, planning);
        if (planned.length !== 2) throw new Error(`Expected two split compaction requests, planned ${planned.length}`);
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        const replayed: typeof planned = [];
        const tasks = planned.map(async (request) => {
            const responseStream = await stream(request.model, request.context, {...request.options, signal: combined});
            const response = await responseStream.result();
            if (response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall") ||
                !response.content.some((block) => block.type === "text" && block.text.trim())) {
                throw new Error(response.errorMessage || `Invalid split summary response: ${response.stopReason}`);
            }
            return response;
        });
        const settled = Promise.allSettled(tasks);
        const results = await Promise.all(tasks).catch((error: unknown) => {
            controller.abort(error);
            throw error;
        }).finally(async () => { await settled; });
        if (results.length !== 2) throw new Error("Split compaction response count changed");
        let index = 0;
        const replay: CompactionStream = (requestedModel, context, options) => {
            const request = planned[index];
            const result = results[index++];
            if (!request || !result || fingerprint(requestedModel) !== fingerprint(request.model) ||
                fingerprint(stableRequest(context)) !== fingerprint(stableRequest(request.context)) ||
                fingerprint(stableRequest(options)) !== fingerprint(stableRequest(request.options))) {
                throw new Error("Split replay request differed from planned request");
            }
            replayed.push({model: requestedModel, context, options});
            return completedStream(requestedModel, result);
        };
        const output = await compact(preparation, model, undefined, undefined, undefined, signal, thinkingLevel, replay);
        if (index !== 2 || replayed.length !== 2) throw new Error(`Expected two replay requests, replayed ${index}`);
        return output;
    },
};

function stableRequest(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableRequest);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== "timestamp" && key !== "sessionId" && key !== "signal")
        .map(([key, item]) => [key, stableRequest(item)]));
    return value;
}

function completedStream(model: Parameters<CompactionStream>[0], response?: AssistantMessage): ReturnType<CompactionStream> {
    const stream = createAssistantMessageEventStream();
    const message = response ?? {role: "assistant" as const, content: [{type: "text" as const, text: "planning"}], api: model.api,
        provider: model.provider, model: model.id, usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: "stop" as const, timestamp: Date.now()};
    stream.push({type: "done", reason: "stop", message});
    return Promise.resolve(stream);
}

export default parallelSplit;
