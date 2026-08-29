import {
    createEditToolDefinition,
    type EditToolInput,
    type ExtensionAPI,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ThemeColor} from "../../tui/Color";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";
import {resolveBuiltinToolPath} from "./resolveBuiltinToolPath.js";

const EDIT_PRESENTATION = {
    toolName: "edit",
    arguments: [
        {
            key: "path",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "edits",
            placement: ToolArgumentPlacement.TITLE_SECONDARY,
            format: (value) => {
                const count = Array.isArray(value) ? value.length : 0;
                return ` (${count} ${count === 1 ? "replacement" : "replacements"})`;
            },
        },
    ],
    result: {
        direction: ToolTextDirection.HEAD,
        previewLines: 12,
        color: (line) => {
            if (line.startsWith("+")) return ThemeColor.toolDiffAdded;
            if (line.startsWith("-")) return ThemeColor.toolDiffRemoved;
            return ThemeColor.toolDiffContext;
        },
    },
} satisfies ToolPresentationSpec<EditToolInput>;

export class EditTool {
    private definition: ToolDefinition<any, any> | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
        private readonly displayRows: ToolDisplayRows,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("Edit tool is already registered");
        this.registered = true;
        this.pi.registerTool(this.toolDefinition());
    }

    toolDefinition(): ToolDefinition<any, any> {
        if (this.definition) return this.definition;
        const definition = createEditToolDefinition(process.cwd());
        const presentation = new ToolPresentationRenderer(EDIT_PRESENTATION);
        const execute: typeof definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
            const resolvedPath = resolveBuiltinToolPath(params.path, ctx.cwd);
            const result = await this.runtimeProvider().policyRuntime.once(
                ctx.sessionManager.getSessionId(),
                resolvedPath,
                PolicyAccessType.FS_WRITE,
                signal,
                {
                    toolCallId,
                    toolName: "edit",
                    command: `edit ${resolvedPath} (${params.edits.length} replacements)`,
                    purpose: "Apply exact text replacements",
                },
            );
            if (result.matchedStatus === PolicyResponse.DENIED) {
                throw new Error(result.toDenyMessage());
            }
            return createEditToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
        };
        const renderCall: NonNullable<typeof definition.renderCall> = (args, theme, context) => {
            this.displayRows.observe("edit", args, context as any);
            const mode = resolveToolDisplayMode(context.expanded, context.state as any);
            return presentation.renderCall(
                args,
                theme,
                mode,
                {isPartial: context.isPartial, isError: context.isError},
            );
        };
        const renderResult: NonNullable<typeof definition.renderResult> = (result, options, theme, context) => {
            const mode = resolveToolDisplayMode(options.expanded, context.state as any);
            const diff = !context.isError && typeof result.details?.diff === "string"
                ? result.details.diff
                : undefined;
            const displayedResult = diff
                ? {...result, content: [{type: "text" as const, text: diff}]}
                : result;
            return presentation.renderResult(displayedResult, theme, {isError: context.isError}, mode);
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
