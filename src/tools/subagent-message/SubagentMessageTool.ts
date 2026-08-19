import type {AgentToolResult, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../../subagents/SubagentCoordinator.js";
import {
    type SubagentToolDetails,
    subagentToolResult,
} from "../../subagents/SubagentToolResult";
import {objectSchema, stringSchema} from "../types";

type MessageToolInput = {jobId: string; task: string};
type CoordinatorProvider = () => SubagentCoordinator;

export class SubagentMessageTool {
    private readonly definition: ToolDefinition<any, any>;
    private registered = false;

    constructor(
        private readonly pi: Pick<ExtensionAPI, "registerTool">,
        coordinator: CoordinatorProvider,
    ) {
        this.definition = createDefinition(coordinator) as unknown as ToolDefinition<any, any>;
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

function createDefinition(coordinator: CoordinatorProvider): ToolDefinition<any, SubagentToolDetails> {
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
    };
}
