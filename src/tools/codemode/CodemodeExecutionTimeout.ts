import type {CodemodeToolDetails, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {CODEMODE_OPTIONS_PREFIX, parseCodemodeSource} from "@earendil-works/pi-codemode/source";
import type {Type} from "typebox";
import {ApprovalWaitScope} from "../../runtime/ApprovalWaitScope.js";

type NativeCodemodeSchema = Type.TObject<{code: Type.TString}>;
export type NativeCodemodeDefinition = ToolDefinition<NativeCodemodeSchema, CodemodeToolDetails | undefined>;
export type NativeCodemodeExecute = NativeCodemodeDefinition["execute"];

/** Keep native execution/discovery while excluding actual policy approval waits from its budget. */
export function withApprovalAwareCodemodeTimeout(execute: NativeCodemodeExecute): NativeCodemodeExecute {
    return async (toolCallId, params, signal, onUpdate, ctx) => {
        const scope = new ApprovalWaitScope(ApprovalWaitScope.current());
        try {
            return await scope.run(async () => {
                // Validate the original with Pi's public parser before changing any options.
                const {code, options} = parseCodemodeSource(params.code);
                if (options.timeoutMs === undefined) {
                    return execute(toolCallId, params, signal, onUpdate, ctx);
                }

                // Pi defaults to Infinity when timeout_ms is absent. Keep the options line and
                // its output budget; parsed code starts with a newline, preserving stack lines.
                const executionOptions = options.maxOutputTokens === undefined
                    ? {} : {max_output_tokens: options.maxOutputTokens};
                const executionParams = {...params, code: `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(executionOptions)}${code}`};
                const timeout = new Error(`Execution timed out after ${options.timeoutMs} ms (excluding policy approval waits)`);
                timeout.name = "TimeoutError";
                const controller = new AbortController();
                const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
                // The public native execute API has no VM-start/finalization hooks: this budget
                // includes worker admission/initialization, and may fire after the VM finalized.
                const timer = scope.setTimeout(() => {
                    if (!executionSignal.aborted) controller.abort(timeout);
                }, options.timeoutMs);
                try {
                    const result = await execute(toolCallId, executionParams, executionSignal, onUpdate, ctx);
                    // Abort is the public cancellation mechanism. Relabel only native's exact
                    // unspilled abort diagnostic when our timeout won. In particular, never turn
                    // a finalized success into failure or relabel a parent cancellation. Spilled
                    // output remains native-owned and may still say "Script aborted" with the
                    // timeout reason, rather than changing its file or guessing at truncated text.
                    if (executionSignal.reason !== timeout || result.isError !== true || result.details?.fullOutputPath) {
                        return result;
                    }
                    const aborted = `Script error:\nScript aborted: ${timeout.message}\n\n`;
                    const diagnostic = result.content.at(-1);
                    // Pi 1.2 joins adjacent text items: partial output and the native diagnostic
                    // can share a block. Match only the exact trailing diagnostic and call summary,
                    // never text printed by the script or an error followed by a native postscript.
                    if (diagnostic?.type !== "text") return result;
                    const calls = result.details?.calls ?? [];
                    // Pi 1.4 can also abort while queued, before any worker or script starts.
                    const summaries = calls.length === 0
                        ? ["No tool calls were made.", "The script did not start."]
                        : [`Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`];
                    const summary = summaries.find((text) => diagnostic.text.endsWith(`${aborted}${text}`));
                    if (summary === undefined) return result;
                    const suffix = `${aborted}${summary}`;
                    const offset = diagnostic.text.length - suffix.length;
                    if (offset > 0 && diagnostic.text[offset - 1] !== "\n") return result;
                    return {
                        ...result,
                        content: [
                            ...result.content.slice(0, -1),
                            {...diagnostic, text: `${diagnostic.text.slice(0, offset)}Script error:\nScript timed out: ${timeout.message}\n\n${summary}`},
                        ],
                    };
                } finally {
                    timer.dispose();
                }
            });
        } finally {
            scope.close();
        }
    };
}
