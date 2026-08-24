import {
    createReadToolDefinition,
    type ExtensionAPI,
    type ReadToolInput,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentPlacement} from "../../tui/tool/ToolPresentation";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ThemeColor} from "../../tui/Color";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";

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
    private definition: ToolDefinition<any, any> | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
        private readonly displayRows: ToolDisplayRows,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Read tool is already registered");
        this.registered = true;
        this.pi.registerTool(this.toolDefinition());
    }

    toolDefinition(): ToolDefinition<any, any> {
        if (this.definition) return this.definition;
        const definition = createReadToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Read tool renderers are unavailable");
        }

        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(READ_PRESENTATION);
        const execute: typeof definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
            const result = await this.runtimeProvider().policyRuntime.once(
                ctx.sessionManager.getSessionId(),
                params.path,
                PolicyAccessType.FS_READ,
                signal,
            );
            if (result.matchedStatus === PolicyResponse.DENIED) {
                throw new Error(result.toDenyMessage());
            }
            return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
        };
        const renderCall: typeof nativeRenderCall = (args, theme, context) => {
            this.displayRows.observe("read", args, context);
            const mode = resolveToolDisplayMode(context.expanded, context.state);
            return mode === ToolDisplayMode.FULL
                ? nativeRenderCall(args, theme, {...context, expanded: true, lastComponent: undefined})
                : presentation.renderCall(args, theme, mode);
        };
        const renderResult: typeof nativeRenderResult = (result, options, theme, context) => {
            const mode = resolveToolDisplayMode(options.expanded, context.state);
            return mode === ToolDisplayMode.FULL
                ? nativeRenderResult(
                    result,
                    {...options, expanded: true},
                    theme,
                    {...context, expanded: true, lastComponent: undefined},
                )
                : presentation.renderResult(result, theme, {isError: context.isError}, mode);
        };
        this.definition = {
            ...definition,
            execute,
            renderCall,
            renderResult,
        } as unknown as ToolDefinition<any, any>;
        return this.definition;
    }
}
