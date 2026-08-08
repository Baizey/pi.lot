import {
    AgentToolResult,
    createReadToolDefinition,
    type ExtensionAPI,
    ReadToolDetails,
    type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import type {PilotSessionRuntimeHandle} from "../../runtime/PilotSessionRuntime.js";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentPlacement} from "../../tui/tool/ToolPresentation.js";
import {ToolDisplayMode} from "../../tui/tool/ToolDisplayController.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../../tui/Color.js";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";

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
        private readonly runtimeProvider: () => PilotSessionRuntimeHandle,
    ) {}

    register(): void {
        const runtimeProvider = this.runtimeProvider
        if (this.registered) throw new Error("Read tool is already registered");
        this.registered = true;

        const definition = createReadToolDefinition(process.cwd());
        if (!definition.renderCall || !definition.renderResult) {
            throw new Error("Pi's Read tool renderers are unavailable");
        }
        const nativeRenderCall = definition.renderCall;
        const nativeRenderResult = definition.renderResult;
        const presentation = new ToolPresentationRenderer(READ_PRESENTATION, {
            currentMode: () => this.runtimeProvider().toolDisplay.currentMode(),
        });

        this.pi.registerTool({
            ...definition,
            async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ReadToolDetails | undefined>> {
                const result = await runtimeProvider().policyRuntime.once(params.path, PolicyAccessType.FS_READ, signal)
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
                const component = nativeRenderResult(result, options, theme, context);
                if (mode === ToolDisplayMode.MINIMAL) this.setText(component, "");
                return component;
            },
        });
    }

    private synchronizeMode(expanded: boolean): ToolDisplayMode {
        return this.runtimeProvider().toolDisplay.synchronizeExpanded(expanded);
    }

    private setText(component: unknown, text: string): void {
        if (!component || typeof (component as {setText?: unknown}).setText !== "function") {
            throw new Error("Pi's Read renderer did not return a mutable text component");
        }
        (component as {setText(value: string): void}).setText(text);
    }
}
