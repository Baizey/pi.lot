import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator.js";
import {
    type SubagentToolDetails,
    subagentToolResult,
} from "../../subagents/SubagentToolResult";
import {
    arraySchema,
    numberSchema,
    objectSchema,
    stringSchema,
} from "../types";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation.js";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows.js";
import {ToolStatusRail} from "../../tui/tool/ToolStatusRail.js";
import {ThemeColor} from "../../tui/Color.js";

type StatusToolInput = { jobIds?: string[]; waitSeconds?: number };
type CoordinatorProvider = () => SubagentCoordinator;

const STATUS_PRESENTATION = {
    toolName: "subagent_status",
    arguments: [
        {
            key: "jobIds",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
            format: (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "all jobs",
        },
        {
            key: "waitSeconds",
            placement: ToolArgumentPlacement.TITLE_SECONDARY,
            format: (value) => ` (wait ${String(value)}s)`,
        },
    ],
    result: {direction: ToolTextDirection.TAIL, previewLines: 8},
} satisfies ToolPresentationSpec<StatusToolInput>;

export class SubagentStatusTool {
    private readonly definition: ToolDefinition<any, any>;
    private registered = false;

    constructor(
        private readonly pi: Pick<ExtensionAPI, "registerTool">,
        coordinator: CoordinatorProvider,
        displayRows: ToolDisplayRows,
    ) {
        this.definition = createDefinition(coordinator, displayRows) as unknown as ToolDefinition<any, any>;
    }

    register(): void {
        if (this.registered) throw new Error("Subagent status tool is already registered");
        this.registered = true;
        this.pi.registerTool(this.definition);
    }

    toolDefinition(): ToolDefinition<any, any> {
        return this.definition;
    }
}

function createDefinition(
    coordinator: CoordinatorProvider,
    displayRows: ToolDisplayRows,
): ToolDefinition<any, SubagentToolDetails> {
    const presentation = new ToolPresentationRenderer(STATUS_PRESENTATION);
    return {
        name: "subagent_status",
        label: "Subagent status",
        description: "Inspect subagent jobs and optionally wait for selected running jobs to settle.",
        renderShell: "self",
        parameters: objectSchema({
            jobIds: arraySchema(stringSchema("Subagent job id"), "Jobs to inspect; omit to list all jobs"),
            waitSeconds: numberSchema("Maximum time to wait for selected jobs", 0, 3_600, 0),
        }),
        async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as StatusToolInput;
            const jobs = await coordinator().status(
                input.jobIds,
                input.waitSeconds ?? 0,
                signal,
                onUpdate ? (updates) => onUpdate(subagentToolResult(updates)) : undefined,
            );
            return subagentToolResult(jobs);
        },
        renderCall: (args, theme, context) => {
            displayRows.observe("subagent_status", args, context);
            return new ToolStatusRail(
                presentation.renderCall(
                    args as StatusToolInput,
                    theme,
                    resolveToolDisplayMode(context.expanded, context.state),
                ),
                theme,
                context,
            );
        },
        renderResult: (result, options, theme, context) => new ToolStatusRail(
            presentation.renderResult(
                result,
                theme,
                {isError: context.isError},
                resolveToolDisplayMode(options.expanded, context.state),
            ),
            theme,
            context,
        ),
    };
}
