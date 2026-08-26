import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator";
import {
    type SubagentToolDetails,
    subagentToolResult,
} from "../../subagents/SubagentToolResult";
import {objectSchema, stringSchema} from "../types";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {
    ToolArgumentLayout,
    ToolArgumentPlacement,
    ToolTextDirection,
} from "../../tui/tool/ToolPresentation";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";
import {ThemeColor} from "../../tui/Color";

type MessageToolInput = {jobId: string; task: string};
type CoordinatorProvider = () => SubagentCoordinator;

const MESSAGE_PRESENTATION = {
    toolName: "subagent_message",
    arguments: [
        {
            key: "jobId",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "task",
            layout: ToolArgumentLayout.BLOCK,
            color: ThemeColor.text,
        },
    ],
    result: {direction: ToolTextDirection.TAIL, previewLines: 8},
} satisfies ToolPresentationSpec<MessageToolInput>;

export class SubagentMessageTool {
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
        if (this.registered) throw new Error("Subagent message tool is already registered");
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
    const presentation = new ToolPresentationRenderer(MESSAGE_PRESENTATION);
    return {
        name: "subagent_message",
        label: "Message subagent",
        description: "Message a subagent. A running job receives steering for its active turn; otherwise the message becomes an ordered follow-up turn.",
        renderShell: "self",
        parameters: objectSchema({
            jobId: stringSchema("Subagent job id"),
            task: stringSchema("Steering instruction or conversation follow-up"),
        }, ["jobId", "task"]),
        async execute(_id, params): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as MessageToolInput;
            return subagentToolResult([await coordinator().message(input.jobId, input.task)]);
        },
        renderCall: (args, theme, context) => {
            displayRows.observe("subagent_message", args, context);
            return presentation.renderCall(
                args as MessageToolInput,
                theme,
                resolveToolDisplayMode(context.expanded, context.state),
                {isPartial: context.isPartial, isError: context.isError},
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
