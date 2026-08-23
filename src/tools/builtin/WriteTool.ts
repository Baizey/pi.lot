import {
    AgentToolResult,
    createWriteToolDefinition,
    type ExtensionAPI,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ThemeColor} from "../../tui/Color";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";

const WRITE_PRESENTATION = {
    toolName: "write",
    arguments: [
        {
            key: "path",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "content",
            layout: ToolArgumentLayout.BLOCK,
            direction: ToolTextDirection.HEAD,
        },
    ],
} satisfies ToolPresentationSpec<WriteToolInput>;

export class WriteTool {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
        private readonly displayRows: ToolDisplayRows,
    ) {
    }

    register(): void {
        const runtimeProvider = this.runtimeProvider;
        if (this.registered) throw new Error("Write tool is already registered");
        this.registered = true;

        const definition = createWriteToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Write tool renderers are unavailable");
        }
        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(WRITE_PRESENTATION);
        this.pi.registerTool({
            ...definition,
            async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
                const result = await runtimeProvider().policyRuntime.once(
                    ctx.sessionManager.getSessionId(),
                    params.path,
                    PolicyAccessType.FS_WRITE,
                    signal,
                );
                if (result.matchedStatus === PolicyResponse.DENIED) {
                    throw new Error(result.toDenyMessage());
                }
                return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
            },

            renderCall: (args, theme, context) => {
                this.displayRows.observe("write", args, context);
                const mode = resolveToolDisplayMode(context.expanded, context.state);
                return mode === ToolDisplayMode.FULL
                    ? nativeRenderCall(args, theme, {...context, expanded: true, lastComponent: undefined})
                    : presentation.renderCall(args, theme, mode);
            },

            renderResult: (result, options, theme, context) => {
                const mode = resolveToolDisplayMode(options.expanded, context.state);
                return mode === ToolDisplayMode.FULL
                    ? nativeRenderResult(
                        result,
                        {...options, expanded: true},
                        theme,
                        {...context, expanded: true, lastComponent: undefined},
                    )
                    : presentation.renderResult(result, theme, {isError: context.isError}, mode);
            },
        });
    }
}
