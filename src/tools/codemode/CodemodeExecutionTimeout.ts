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
                // includes initialization, and may fire after the VM has already finalized.
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
                    // Native appends its error after script output. Do not edit matching text
                    // printed by the script, or guess when a native postscript follows the error.
                    if (diagnostic?.type !== "text" || !diagnostic.text.startsWith(aborted)) return result;
                    return {
                        ...result,
                        content: [
                            ...result.content.slice(0, -1),
                            {...diagnostic, text: `Script error:\nScript timed out: ${timeout.message}\n\n${diagnostic.text.slice(aborted.length)}`},
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
