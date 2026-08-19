import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {SubagentToolkitRegistry} from "../src/subagents/SubagentToolkitRegistry.js";
import type {SubagentChildSessionFactory} from "../src/subagents/types.js";
import {SubagentMessageTool} from "../src/tools/subagent-message/SubagentMessageTool.js";
import {SubagentSpawnTool} from "../src/tools/subagent-spawn/SubagentSpawnTool.js";
import {SubagentStatusTool} from "../src/tools/subagent-status/SubagentStatusTool.js";
import {SubagentStopTool} from "../src/tools/subagent-stop/SubagentStopTool.js";

const expectedNames = ["subagent_spawn", "subagent_status", "subagent_message", "subagent_stop"];

test("each subagent tool registers independently and delegates only to the coordinator", async () => {
    const registered: ToolDefinition<any, any>[] = [];
    const pi = {
        registerTool(tool: ToolDefinition<any, any>) { registered.push(tool); },
    };
    let coordinator: SubagentCoordinator | undefined;
    const coordinatorProvider = () => {
        if (!coordinator) throw new Error("Subagent session is not available");
        return coordinator;
    };
    const tools = [
        new SubagentSpawnTool(pi, coordinatorProvider),
        new SubagentStatusTool(pi, coordinatorProvider),
        new SubagentMessageTool(pi, coordinatorProvider),
        new SubagentStopTool(pi, coordinatorProvider),
    ];
    for (const tool of tools) tool.register();

    assert.deepEqual(registered.map((tool) => tool.name), expectedNames);
    assert.deepEqual(tools.map((tool) => tool.toolDefinition().name), expectedNames);
    await assert.rejects(invoke(registered[0]!, {task: "before", role: "reviewer"}), /session is not available/);

    const factory: SubagentChildSessionFactory = {
        async create() {
            return {
                async prompt(task) { return `completed: ${task}`; },
                async abort() {},
                dispose() {},
            };
        },
    };
    coordinator = new SubagentCoordinator(factory, new SubagentToolkitRegistry());
    const result = await invoke(registered[0]!, {task: "work", role: "reviewer"});
    assert.match(textResult(result), /completed: work/);
    assert.match(textResult(result), /Status: completed/);

    await coordinator.close();
});

function invoke(tool: ToolDefinition<any, any>, params: unknown): Promise<unknown> {
    return tool.execute(
        "test-call",
        params,
        undefined,
        undefined,
        {cwd: process.cwd()} as ExtensionContext,
    );
}

function textResult(result: unknown): string {
    if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
    return result.content
        .filter((part): part is {type: "text"; text: string} => (
            typeof part === "object"
            && part !== null
            && "type" in part
            && part.type === "text"
            && "text" in part
            && typeof part.text === "string"
        ))
        .map((part) => part.text)
        .join("\n");
}
