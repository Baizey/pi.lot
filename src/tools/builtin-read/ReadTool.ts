import {
    AgentToolResult,
    createReadToolDefinition,
    type ExtensionAPI,
    ReadToolDetails,
    type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentPlacement} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../../tui/Color.js";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";

const READ_PRESENTATION = {
    toolName: "read",
    arguments: [
        {
            key: "path",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "offset",
            placement: ToolArgumentPlacement.TITLE_SECONDARY,
            color: ThemeColor.warning,
            format: (_, args) => {
                const from = args.offset ?? 1;
                if (args.limit === undefined) return `:${from}`;
                return `:${from}-${from + args.limit - 1}`;
            },
        },
        {
            key: "limit",
            placement: ToolArgumentPlacement.TITLE_SECONDARY,
            consumedBy: "offset",
        },
    ],
} satisfies ToolPresentationSpec<ReadToolInput>;

export class ReadTool {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
    ) {
    }

    register(): void {
        const runtimeProvider = this.runtimeProvider;
        if (this.registered) throw new Error("Read tool is already registered");
        this.registered = true;

        const definition = createReadToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Read tool renderers are unavailable");
        }

        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(READ_PRESENTATION);
        this.pi.registerTool({
            ...definition,
            async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ReadToolDetails | undefined>> {
                const result = await runtimeProvider().policyRuntime.once(params.path, PolicyAccessType.FS_READ, signal);
                if (result.matchedStatus === PolicyResponse.DENIED) {
                    throw new Error(result.toDenyMessage());
                }
                return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
            },

            renderCall: (args, theme, context) => {
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
