import {
    AgentToolResult,
    createEditToolDefinition,
    EditToolDetails,
    type EditToolInput,
    type ExtensionAPI,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentPlacement} from "../../tui/tool/ToolPresentation.js";
import {ToolDisplayMode} from "../../tui/tool/ToolDisplayController.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../../tui/Color.js";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import {PilotSessionRuntime} from "../../runtime/PilotSessionRuntime";

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
        private readonly runtimeProvider: () => PilotSessionRuntime,
    ) {
    }

    register(): void {
        const runtimeProvider = this.runtimeProvider
        if (this.registered) throw new Error("Edit tool is already registered");
        this.registered = true;

        const definition = createEditToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Edit tool renderers are unavailable");
        }
        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(EDIT_PRESENTATION, {
            currentMode: () => this.runtimeProvider().toolDisplay.currentMode(),
        });

        this.pi.registerTool({
            ...definition,

            async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<EditToolDetails | undefined>> {
                const result = await runtimeProvider().policyRuntime.once(params.path, PolicyAccessType.FS_READ, signal)
                if (result.matchedStatus === PolicyResponse.DENIED) {
                    throw new Error(result.toDenyMessage())
                }
                return await definition.execute(toolCallId, params, signal, onUpdate, ctx)
            },

            renderCall: (args, theme, context) => {
                const mode = this.synchronizeMode(context.expanded);
                const component = nativeRenderCall(args, theme, context);
                if (mode !== ToolDisplayMode.FULL) {
                    this.showSummary(component, presentation, args, theme);
                }
                return component;
            },

            renderResult: (result, options, theme, context) => {
                const mode = this.synchronizeMode(context.expanded);
                const component = nativeRenderResult(result, options, theme, context);
                if (mode !== ToolDisplayMode.FULL && context.state.callComponent) {
                    this.showSummary(context.state.callComponent, presentation, context.args, theme);
                }
                if (mode === ToolDisplayMode.MINIMAL) this.clear(component);
                return component;
            },
        });
    }

    private synchronizeMode(expanded: boolean): ToolDisplayMode {
        return this.runtimeProvider().toolDisplay.synchronizeExpanded(expanded);
    }

    private showSummary(
        component: unknown,
        presentation: ToolPresentationRenderer<EditToolInput>,
        args: Partial<EditToolInput>,
        theme: Theme,
    ): void {
        if (!this.hasMethod(component, "clear") || !this.hasMethod(component, "addChild")) {
            throw new Error("Pi's Edit call renderer did not return a mutable container");
        }
        const container = component as {
            clear(): void;
            addChild(child: unknown): void;
        };
        container.clear();
        container.addChild(presentation.renderCall(args, theme));
    }

    private clear(component: unknown): void {
        if (!this.hasMethod(component, "clear")) {
            throw new Error("Pi's Edit result renderer did not return a mutable container");
        }
        (component as { clear(): void }).clear();
    }

    private hasMethod(value: unknown, key: string): boolean {
        return Boolean(value && typeof (value as Record<string, unknown>)[key] === "function");
    }
}
