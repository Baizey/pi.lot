import {
    AgentToolResult,
    createWriteToolDefinition,
    type ExtensionAPI,
    type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection,} from "../../tui/tool/ToolPresentation.js";
import {ToolDisplayMode} from "../../tui/tool/ToolDisplayController.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../../tui/Color.js";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import {PilotSessionRuntime, PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";

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
    ) {
    }

    register(): void {
        const runtimeProvider = this.runtimeProvider
        if (this.registered) throw new Error("Write tool is already registered");
        this.registered = true;

        const definition = createWriteToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Write tool renderers are unavailable");
        }
        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(WRITE_PRESENTATION, {
            currentMode: () => this.runtimeProvider().toolDisplay.currentMode(),
        });

        this.pi.registerTool({
            ...definition,
            async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
                const result = await runtimeProvider().policyRuntime.once(params.path, PolicyAccessType.FS_WRITE, signal)
                if (result.matchedStatus === PolicyResponse.DENIED) {
                    throw new Error(result.toDenyMessage())
                }
                return await definition.execute(toolCallId, params, signal, onUpdate, ctx)
            },
            renderCall: (args, theme, context) => {
                const mode = this.synchronizeMode(context.expanded);
                const component = nativeRenderCall(args, theme, context);
                if (mode === ToolDisplayMode.MINIMAL) {
                    this.setText(
                        component,
                        presentation.renderCall(args, theme).render(Number.POSITIVE_INFINITY).join("\n"),
                    );
                }
                return component;
            },
            renderResult: (result, options, theme, context) => {
                const mode = this.synchronizeMode(context.expanded);
                const lastComponent = context.isError
                    ? this.hasMethod(context.lastComponent, "setText") ? context.lastComponent : undefined
                    : this.hasMethod(context.lastComponent, "clear") ? context.lastComponent : undefined;
                const component = nativeRenderResult(result, options, theme, {
                    ...context,
                    lastComponent,
                });
                if (mode === ToolDisplayMode.MINIMAL) this.clearResult(component);
                return component;
            },
        });
    }

    private synchronizeMode(expanded: boolean): ToolDisplayMode {
        return this.runtimeProvider().toolDisplay.synchronizeExpanded(expanded);
    }

    private clearResult(component: unknown): void {
        if (this.hasMethod(component, "setText")) {
            (component as { setText(value: string): void }).setText("");
            return;
        }
        if (this.hasMethod(component, "clear")) {
            (component as { clear(): void }).clear();
            return;
        }
        throw new Error("Pi's Write result renderer returned an unsupported component");
    }

    private setText(component: unknown, text: string): void {
        if (!this.hasMethod(component, "setText")) {
            throw new Error("Pi's Write call renderer did not return a mutable text component");
        }
        (component as { setText(value: string): void }).setText(text);
    }

    private hasMethod(value: unknown, key: string): boolean {
        return Boolean(value && typeof (value as Record<string, unknown>)[key] === "function");
    }
}
