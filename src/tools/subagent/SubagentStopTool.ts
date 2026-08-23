import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator";
import {
    type SubagentToolDetails,
    subagentToolResult,
} from "../../subagents/SubagentToolResult";
import {objectSchema, stringSchema} from "../types";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";
import {ThemeColor} from "../../tui/Color";

type StopToolInput = {jobId: string};
type CoordinatorProvider = () => SubagentCoordinator;

const STOP_PRESENTATION = {
    toolName: "subagent_stop",
    arguments: [{
        key: "jobId",
        placement: ToolArgumentPlacement.TITLE_PRIMARY,
        color: ThemeColor.text,
    }],
    result: {direction: ToolTextDirection.TAIL, previewLines: 8},
} satisfies ToolPresentationSpec<StopToolInput>;

export class SubagentStopTool {
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
        if (this.registered) throw new Error("Subagent stop tool is already registered");
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
    const presentation = new ToolPresentationRenderer(STOP_PRESENTATION);
    return {
        name: "subagent_stop",
        label: "Stop subagent",
        description: "Stop a queued, running, or idle subagent and all of its descendants.",
        parameters: objectSchema({jobId: stringSchema("Subagent job id")}, ["jobId"]),
        async execute(_id, params): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as StopToolInput;
            const result = await coordinator().stop(input.jobId);
            return subagentToolResult([result]);
        },
        renderCall: (args, theme, context) => {
            displayRows.observe("subagent_stop", args, context);
            return presentation.renderCall(
                args as StopToolInput,
                theme,
                resolveToolDisplayMode(context.expanded, context.state),
            );
        },
        renderResult: (result, options, theme, context) => presentation.renderResult(
            result,
            theme,
            {isError: context.isError},
            resolveToolDisplayMode(options.expanded, context.state),
        ),
    };
}
