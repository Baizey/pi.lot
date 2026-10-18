import {
    createEditToolDefinition,
    type EditToolDetails,
    type EditToolInput,
    type ExtensionAPI,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {Container} from "@earendil-works/pi-tui";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ThemeColor} from "../../tui/Color";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {ToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolDisplayRows, type ToolDisplayState} from "../../tui/tool/ToolDisplayRows";
import {resolveBuiltinToolPath} from "./resolveBuiltinToolPath.js";

type EditPresentationDefinition = ToolDefinition<
    ReturnType<typeof createEditToolDefinition>["parameters"],
    EditToolDetails | undefined,
    ToolDisplayState
>;

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
        direction: ToolTextDirection.TAIL,
        previewLines: 12,
        color: (line) => {
            if (line.startsWith("+")) return ThemeColor.toolDiffAdded;
            if (line.startsWith("-")) return ThemeColor.toolDiffRemoved;
            return ThemeColor.toolDiffContext;
        },
    },
} satisfies ToolPresentationSpec<EditToolInput>;

export class EditTool {
    private definition: EditPresentationDefinition | undefined;
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
        this.displayRows.registerCallPresentation("edit", (args, theme, mode, width, indicator) => (
            presentation.renderCallLines(args, theme, mode, width, indicator)
        ));
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
            return definition.execute(toolCallId, params, signal, onUpdate, ctx);
        };
        const renderCall: NonNullable<EditPresentationDefinition["renderCall"]> = (args, theme, context) => {
            this.displayRows.observe("edit", args, context);
            const selected = this.displayRows.resolveMode(context.expanded, context.state);
            const mode = context.isPartial && selected === ToolDisplayMode.MINIMAL
                ? ToolDisplayMode.TRUNCATED : selected;
            const call = presentation.renderCall(args, theme, mode, {
                isPartial: context.isPartial,
                outputPad: context.outputPad,
                indicator: () => context.state.pilotCallSpinner?.frame(),
            });
            if (!context.isPartial || mode === ToolDisplayMode.HIDDEN) return call;

            // Preview only supplied replacement text: reading the target here would
            // precede the execution path's policy approval.
            const preview = requestedEditPreview(args?.edits);
            if (!preview) return call;
            const component = new Container();
            component.addChild(call);
            component.addChild(presentation.renderResult(
                {content: [{type: "text", text: preview}]}, theme, {outputPad: context.outputPad}, mode,
            ));
            return component;
        };
        const renderResult: NonNullable<EditPresentationDefinition["renderResult"]> = (result, options, theme, context) => {
            if (!options.isPartial) this.displayRows.complete(context.state);
            const selected = this.displayRows.resolveMode(options.expanded, context.state);
            const mode = options.isPartial && selected === ToolDisplayMode.MINIMAL
                ? ToolDisplayMode.TRUNCATED : selected;
            const diff = !context.isError && typeof result.details?.diff === "string"
                ? result.details.diff
                : undefined;
            const displayedResult = diff
                ? {...result, content: [{type: "text" as const, text: diff}]}
                : result;
            return presentation.renderResult(displayedResult, theme, {isError: context.isError, outputPad: context.outputPad}, mode);
        };
        this.definition = {
            ...definition,
            renderShell: "self",
            execute,
            renderCall,
            renderResult,
        };
        return this.definition;
    }
}

function requestedEditPreview(value: unknown): string {
    if (!Array.isArray(value)) return "";
    const edits: unknown[] = value;
    return edits.flatMap((edit, index) => {
        if (!edit || typeof edit !== "object" || !("newText" in edit) || typeof edit.newText !== "string") {
            return [];
        }
        const heading = `Requested replacement ${index + 1} (preview):`;
        if (edit.newText === "") return [`${heading} delete matched text`];
        return [heading, ...edit.newText.replace(/\r\n|\r/g, "\n").split("\n").map((line) => `+${line}`)];
    }).join("\n");
}
