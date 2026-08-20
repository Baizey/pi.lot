import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator.js";
import {
    type SubagentToolDetails,
    subagentToolResult,
} from "../../subagents/SubagentToolResult";
import {objectSchema, stringSchema} from "../types";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {
    ToolArgumentLayout,
    ToolArgumentPlacement,
    ToolTextDirection,
} from "../../tui/tool/ToolPresentation.js";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows.js";
import {ThemeColor} from "../../tui/Color.js";

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
        description: "Send the next task to an idle conversation subagent while preserving its real child session.",
        parameters: objectSchema({
            jobId: stringSchema("Conversation job id"),
            task: stringSchema("Next task or follow-up message"),
        }, ["jobId", "task"]),
        async execute(_id, params): Promise<AgentToolResult<SubagentToolDetails>> {
            const input = params as MessageToolInput;
            return subagentToolResult([coordinator().message(input.jobId, input.task)]);
        },
        renderCall: (args, theme, context) => {
            displayRows.observe("subagent_message", args, context);
            return presentation.renderCall(
                args as MessageToolInput,
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
