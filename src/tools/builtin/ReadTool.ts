import {
    createReadToolDefinition,
    formatReadLineRange,
    type ExtensionAPI,
    type ReadToolInput,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentPlacement} from "../../tui/tool/ToolPresentation";
import {ThemeColor} from "../../tui/Color";
import {PolicyAccessType, PolicyResponse} from "../../policy/types";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";
import {resolveBuiltinToolPath} from "./resolveBuiltinToolPath.js";

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
            format: (_, args) => formatReadLineRange(args.offset, args.limit),
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
        const renderers = this.displayRows.bind(READ_PRESENTATION);
        const execute: typeof definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
            const resolvedPath = resolveBuiltinToolPath(params.path, ctx.cwd);
            const result = await this.runtimeProvider().policyRuntime.once(
                ctx.sessionManager.getSessionId(),
                resolvedPath,
                PolicyAccessType.FS_READ,
                signal,
                {
                    toolCallId,
                    toolName: "read",
                    command: `read ${resolvedPath}`,
                    purpose: "Read file contents",
                },
            );
            if (result.matchedStatus === PolicyResponse.DENIED) {
                throw new Error(result.toDenyMessage());
            }
            return definition.execute(toolCallId, params, signal, onUpdate, ctx);
        };
        this.definition = {
            ...definition,
            ...renderers,
            execute,
        } as unknown as ToolDefinition<any, any>;
        return this.definition;
    }
}
