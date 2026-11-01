import {isDeepStrictEqual} from "node:util";
import {compact} from "@earendil-works/pi-coding-agent";
import {contentText, createAssistantMessageEventStream, retryAssistantCall, type AssistantMessage} from "@earendil-works/pi-ai";
import {completeSimple} from "@earendil-works/pi-ai/compat";

type CompactInput = Parameters<typeof compact>;
type CompactionStream = NonNullable<CompactInput[7]>;
type Request = Parameters<CompactionStream>;

/** Keeps native prompts and assembly; only the two independent split summaries overlap. */
export class ParallelCompaction {
    run(...input: CompactInput): ReturnType<typeof compact> {
        const [preparation] = input;
        if (!preparation.isSplitTurn || preparation.messagesToSummarize.length === 0 || preparation.turnPrefixMessages.length === 0) {
            return compact(...input);
        }
        return this.runSplit(input);
    }

    private async runSplit(input: CompactInput): ReturnType<typeof compact> {
        const signal = input[5];
        signal?.throwIfAborted();
        const requests: Request[] = [];
        const expected: unknown[] = [];
        const planning: CompactionStream = (...request) => {
            requests.push(request);
            expected.push(this.comparableRequest(request));
            if (requests.length > 2) throw new Error("Native split compaction planned more than two requests");
            return this.completedStream(this.planningResponse(request[0]));
        };
        // Native compact is the only owner of prompt construction and result assembly.
        // These two local passes never invoke the caller's stream or a provider.
        await this.withStream(input, planning);
        if (requests.length !== 2) throw new Error(`Native split compaction planned ${requests.length} requests, expected two`);
        signal?.throwIfAborted();

        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const tasks = requests.map((request, index) => this.completeRequest(input, request, combined, index).catch((error: unknown) => {
            controller.abort(error);
            throw error;
        }));
        // Cancellation must not leave an in-flight request (or retry callback) behind.
        // Do not race abort against the requests: signal them, then physically join both.
        const settled = Promise.allSettled(tasks);
        const responses = await Promise.all(tasks).finally(async () => { await settled; });
        signal?.throwIfAborted();

        let index = 0;
        const replay: CompactionStream = (...request) => {
            const response = responses[index];
            if (!response || !isDeepStrictEqual(this.comparableRequest(request), expected[index])) {
                throw new Error(`Native split compaction replay request ${index + 1} differed from its plan`);
            }
            index++;
            return this.completedStream(response);
        };
        const result = await this.withStream(input, replay);
        if (index !== 2) throw new Error(`Native split compaction replayed ${index} requests, expected two`);
        signal?.throwIfAborted();
        return result;
    }

    private async completeRequest(input: CompactInput, request: Request, signal: AbortSignal, index: number): Promise<AssistantMessage> {
        const [model, context, options] = request;
        const requestOptions = {...options, signal};
        const produce = async () => {
            signal.throwIfAborted();
            return input[7]
                ? (await input[7](model, context, requestOptions)).result()
                : completeSimple(model, context, requestOptions);
        };
        // This is the same public choke point used by native completeSummarization.
        // Pass the configured policy/callbacks intact; do not retry validation failures.
        const response = await retryAssistantCall(produce, input[9], signal, input[10]);
        signal.throwIfAborted();
        const label = index === 0 ? "Summarization" : "Turn prefix summarization";
        if (response.stopReason === "error") throw new Error(`${label} failed: ${response.errorMessage || "Unknown error"}`);
        if (response.stopReason === "length") throw new Error(`${label} failed: generation hit the token cap and the summary is incomplete`);
        if (response.content.some((block) => block.type === "toolCall")) throw new Error(`${label} attempted to call a tool`);
        if (response.stopReason !== "stop") throw new Error(`${label} failed: invalid stop reason ${response.stopReason}`);
        if (!contentText(response.content).trim()) throw new Error(`${label} failed: summary was empty`);
        return response;
    }

    private withStream(input: CompactInput, stream: CompactionStream): ReturnType<typeof compact> {
        const replayInput: CompactInput = [...input];
        replayInput[7] = stream;
        return compact(...replayInput);
    }

    private comparableRequest([model, context, options]: Request): unknown {
        return [this.stableRequest(model), this.stableRequest(context), this.stableRequest(options)];
    }

    private stableRequest(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((item) => this.stableRequest(item));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => key !== "timestamp" && key !== "sessionId" && key !== "signal")
                .map(([key, item]) => [key, this.stableRequest(item)]));
        }
        return value;
    }

    private completedStream(message: AssistantMessage): ReturnType<CompactionStream> {
        const stream = createAssistantMessageEventStream();
        stream.push({type: "done", reason: "stop", message});
        return stream;
    }

    private planningResponse(model: Request[0]): AssistantMessage {
        return {
            role: "assistant", content: [{type: "text", text: "planning"}], api: model.api,
            provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
            usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        };
    }
}
