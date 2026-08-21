import {
    AgentToolResult,
    createEditToolDefinition,
    EditToolDetails,
    type EditToolInput,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {Box, type Component} from "@earendil-works/pi-tui";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentPlacement} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../../tui/Color.js";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows.js";
import {ToolStatusRail} from "../../tui/tool/ToolStatusRail.js";

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
} satisfies ToolPresentationSpec<EditToolInput>;

export class EditTool {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
        private readonly displayRows: ToolDisplayRows,
    ) {
    }

    register(): void {
        const runtimeProvider = this.runtimeProvider;
        if (this.registered) throw new Error("Edit tool is already registered");
        this.registered = true;

        const definition = createEditToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Edit tool renderers are unavailable");
        }
        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(EDIT_PRESENTATION);

        this.pi.registerTool({
            ...definition,
            renderShell: "self",

            async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<EditToolDetails | undefined>> {
                const result = await runtimeProvider().policyRuntime.once(params.path, PolicyAccessType.FS_WRITE, signal);
                if (result.matchedStatus === PolicyResponse.DENIED) {
                    throw new Error(result.toDenyMessage());
                }
                return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
            },

            renderCall: (args, theme, context) => {
                this.displayRows.observe("edit", args, context);
                const mode = resolveToolDisplayMode(context.expanded, context.state);
                const component = mode === ToolDisplayMode.FULL
                    ? nativeRenderCall(args, theme, {...context, expanded: true, lastComponent: undefined})
                    : presentation.renderCall(args, theme, mode);
                return new ToolStatusRail(withoutNativeEditBox(component), theme, context);
            },

            renderResult: (result, options, theme, context) => {
                const mode = resolveToolDisplayMode(options.expanded, context.state);
                const component = mode === ToolDisplayMode.FULL
                    ? nativeRenderResult(
                        result,
                        {...options, expanded: true},
                        theme,
                        {...context, expanded: true, lastComponent: undefined},
                    )
                    : presentation.renderResult(result, theme, {isError: context.isError}, mode);
                return new ToolStatusRail(withoutNativeEditBox(component), theme, context);
            },
        });
    }
}

function withoutNativeEditBox(component: Component): Component {
    if (!(component instanceof Box)) return component;
    return {
        render: (width) => component.children.flatMap((child) => child.render(width)),
        invalidate: () => component.invalidate(),
    };
}
