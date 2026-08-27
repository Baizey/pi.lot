import {
    createWriteToolDefinition,
    type ExtensionAPI,
    type ToolDefinition,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ThemeColor} from "../../tui/Color";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";
import {resolveBuiltinToolPath} from "./resolveBuiltinToolPath.js";

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
    private definition: ToolDefinition<any, any> | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
        private readonly displayRows: ToolDisplayRows,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Write tool is already registered");
        this.registered = true;
        this.pi.registerTool(this.toolDefinition());
    }

    toolDefinition(): ToolDefinition<any, any> {
        if (this.definition) return this.definition;
        const definition = createWriteToolDefinition(process.cwd());
        const presentation = new ToolPresentationRenderer(WRITE_PRESENTATION);
        const execute: typeof definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
            const result = await this.runtimeProvider().policyRuntime.once(
                ctx.sessionManager.getSessionId(),
                resolveBuiltinToolPath(params.path, ctx.cwd),
                PolicyAccessType.FS_WRITE,
                signal,
            );
            if (result.matchedStatus === PolicyResponse.DENIED) {
                throw new Error(result.toDenyMessage());
            }
            return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
        };
        const renderCall: NonNullable<typeof definition.renderCall> = (args, theme, context) => {
            this.displayRows.observe("write", args, context);
            const mode = resolveToolDisplayMode(context.expanded, context.state);
            return presentation.renderCall(
                args,
                theme,
                mode,
                {isPartial: context.isPartial, isError: context.isError},
            );
        };
        const renderResult: NonNullable<typeof definition.renderResult> = (result, options, theme, context) => {
            const mode = resolveToolDisplayMode(options.expanded, context.state);
            return presentation.renderResult(result, theme, {isError: context.isError}, mode);
        };
        this.definition = {
            ...definition,
            renderShell: "self",
            execute,
            renderCall,
            renderResult,
        } as unknown as ToolDefinition<any, any>;
        return this.definition;
    }
}
