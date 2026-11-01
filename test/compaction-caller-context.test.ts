import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import {stockCompaction, type CompactionExperiment, type CompactionModel, type CompactionPreparation, type CompactionThinkingLevel} from "../experiments/compaction/CompactionEvaluation.js";
import parallelSplit from "../experiments/compaction/ParallelSplit.js";
import {createChunkedCompaction} from "../experiments/compaction/ChunkedCompaction.js";
import {createSemanticCompaction} from "../experiments/compaction/SemanticCompaction.js";
import {smokeModel} from "../scripts/evaluate-compaction.js";

const recipes: Array<{experiment: CompactionExperiment; calls: number}> = [
    {experiment: stockCompaction, calls: 2},
    {experiment: parallelSplit, calls: 2},
    {experiment: createChunkedCompaction({id: "chunked-sequential", concurrency: 1, chunkTokens: 1, maxChunks: 8}), calls: 4},
    {experiment: createChunkedCompaction({id: "chunked-parallel", concurrency: 2, chunkTokens: 1, maxChunks: 8}), calls: 4},
    ...(["v3", "v4", "v5"] as const).map((revision) => ({
        experiment: createSemanticCompaction({id: `unified-${revision}`, mode: "unified", revision}), calls: 1,
    })),
    {experiment: createSemanticCompaction({id: "dual-v3", mode: "dual"}), calls: 2},
];

for (const {experiment, calls} of recipes) test(`${experiment.id}: inherits each caller's model, thinking and stream without caching a selection`, async () => {
    // Deliberately unknown IDs: the strategy must not look up, require, or substitute a named model.
    const models: CompactionModel[] = [
        {...smokeModel(), provider: "agent-provider-a", id: "agent-model-a", reasoning: true},
        {...smokeModel(), provider: "agent-provider-b", id: "agent-model-b", reasoning: false},
    ];
    const thinkingLevels: CompactionThinkingLevel[] = ["off", "low", "high"];
    for (const model of models) {
        for (const thinkingLevel of thinkingLevels) {
            const originalModel = structuredClone(model);
            let requests = 0;
            const result = await experiment.run({
                preparation: preparation(), model, thinkingLevel, signal: new AbortController().signal,
                stream: (requestedModel, _context, options) => {
                    requests++;
                    assert.deepEqual(requestedModel, originalModel, "every lane, chunk and merge must use the caller's model");
                    assert.equal(options?.reasoning, model.reasoning && thinkingLevel !== "off" ? thinkingLevel : undefined,
                        "reasoning must follow native caller/capability semantics, not a preferred level");
                    return reply(requestedModel);
                },
            });
            assert.equal(requests, calls, "all provider requests must go through this run's supplied stream");
            assert.deepEqual(model, originalModel, "the strategy must not mutate the host's selection");
            assert.equal(result.firstKeptEntryId, "kept-boundary");
            assert.ok(result.summary.includes("Caller-selected model handoff."));
        }
    }
});

function preparation(): CompactionPreparation {
    return {
        firstKeptEntryId: "kept-boundary", tokensBefore: 900,
        messagesToSummarize: [
            {role: "user", content: "Prepare the migration handoff.", timestamp: 1},
            {role: "user", content: "The canary result is still unknown.", timestamp: 2},
        ],
        turnPrefixMessages: [{role: "user", content: "Keep release approval separate from preparing the report.", timestamp: 3}],
        previousSummary: "The migration is in progress.", isSplitTurn: true,
        fileOps: {read: new Set(), written: new Set(), edited: new Set()},
        settings: {enabled: true, reserveTokens: 100, keepRecentTokens: 50},
    };
}

function reply(model: CompactionModel) {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{type: "text", text: "Caller-selected model handoff."}],
        usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: "stop", timestamp: 0,
    };
    stream.push({type: "done", reason: "stop", message});
    return stream;
}
