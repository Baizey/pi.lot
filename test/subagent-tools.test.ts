import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext, Theme, ToolDefinition} from "@earendil-works/pi-coding-agent";
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
    assert.equal(registered.every((tool) => tool.renderCall && tool.renderResult), true);

    const theme = plainTheme();
    const minimalCalls = [
        [{task: "Delegate work", role: "reviewer", mode: "sync"}, "subagent_spawn | reviewer (sync)"],
        [{jobIds: ["job-1", "job-2"], waitSeconds: 2}, "subagent_status | job-1, job-2 (wait 2s)"],
        [{jobId: "job-1", task: "Continue"}, "subagent_message | job-1"],
        [{jobId: "job-1"}, "subagent_stop | job-1"],
    ] as const;
    for (let index = 0; index < registered.length; index++) {
        const tool = registered[index]!;
        const [args, expected] = minimalCalls[index]!;
        assert.deepEqual(
            tool.renderCall!(args, theme, renderContext(args)).render(120),
            [expected],
        );
    }

    const spawnArgs = {
        task: numberedLines(10),
        role: "reviewer",
        mode: "sync",
    };
    const truncatedCall = registered[0]!.renderCall!(
        spawnArgs,
        theme,
        renderContext(spawnArgs, {}, true),
    ).render(120);
    assert.equal(truncatedCall.at(-1), "    ... (2 more lines)");
    const fullCall = registered[0]!.renderCall!(
        spawnArgs,
        theme,
        renderContext(spawnArgs, {pilotFullDisplay: true}),
    ).render(120);
    assert.equal(fullCall.at(-1), "    line 10");

    const output = {content: [{type: "text" as const, text: numberedLines(10)}], details: {jobs: []}};
    assert.deepEqual(
        registered[0]!.renderResult!(
            output,
            {expanded: true, isPartial: false},
            theme,
            renderContext(spawnArgs, {}, true),
        ).render(120),
        ["", "... (2 earlier lines)", ...numberedLineArray(8, 3)],
    );

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

function plainTheme(): Theme {
    return {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;
}

function renderContext(
    args: unknown,
    state: Record<string, unknown> = {},
    expanded = false,
): any {
    return {
        args,
        state,
        toolCallId: "test-call",
        cwd: process.cwd(),
        invalidate() {},
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: false,
    };
}

function numberedLines(count: number): string {
    return numberedLineArray(count, 1).join("\n");
}

function numberedLineArray(count: number, start: number): string[] {
    return Array.from({length: count}, (_, index) => `line ${index + start}`);
}

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
