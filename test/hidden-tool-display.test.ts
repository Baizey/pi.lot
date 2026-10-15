import assert from "node:assert/strict";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";
import {
    initTheme,
    ToolExecutionComponent,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type ToolDefinition,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {BashTool} from "../src/tools/builtin/BashTool.js";
import {ReadTool} from "../src/tools/builtin/ReadTool.js";
import {EditTool} from "../src/tools/builtin/EditTool.js";
import {WriteTool} from "../src/tools/builtin/WriteTool.js";
import {WebSearchTool} from "../src/tools/web-search/WebSearchTool.js";
import {SubagentSpawnTool} from "../src/tools/subagent/SubagentSpawnTool.js";
import {SubagentStatusTool} from "../src/tools/subagent/SubagentStatusTool.js";
import {SubagentMessageTool} from "../src/tools/subagent/SubagentMessageTool.js";
import {SubagentStopTool} from "../src/tools/subagent/SubagentStopTool.js";
import {CodemodeExtension} from "../src/tools/codemode/CodemodeExtension.js";
import {McpToolRegistry} from "../src/mcp/McpToolRegistry.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {ToolDisplayMode} from "../src/tui/tool/ToolDisplayMode.js";
import {displayWidth} from "../src/tui/terminalText.js";

initTheme("dark");

test("hidden tool views retain compact active headers but no partial output or completed rows", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    t.after(() => rows.clear());
    const pi = {} as ExtensionAPI;
    const unavailable = () => assert.fail("rendering must not execute tools");
    const fixtures: Array<[string, Record<string, unknown>, ToolRenderers]> = [
        ["bash", {purpose: "Build the project", command: "private command"}, new BashTool(pi, unavailable, rows).toolDefinition()],
        ["read", {path: "current.ts"}, new ReadTool(pi, unavailable, rows).toolDefinition()],
        ["edit", {path: "current.ts", edits: [{oldText: "before", newText: "private replacement"}]}, new EditTool(pi, unavailable, rows).toolDefinition()],
        ["write", {path: "current.ts", content: "private contents"}, new WriteTool(pi, unavailable, rows).toolDefinition()],
        ["web_search", {query: "active query"}, new WebSearchTool(pi, unavailable, rows).toolDefinition()],
        ["subagent_spawn", {role: "Review", task: "private task"}, new SubagentSpawnTool(pi, unavailable, unavailable, rows).toolDefinition()],
        ["subagent_status", {jobIds: ["active-job"]}, new SubagentStatusTool(pi, unavailable, rows).toolDefinition()],
        ["subagent_message", {jobId: "active-job", task: "private task"}, new SubagentMessageTool(pi, unavailable, rows).toolDefinition()],
        ["subagent_stop", {jobId: "active-job"}, new SubagentStopTool(pi, unavailable, rows).toolDefinition()],
        ["mcp__demo__work", {content: "private arguments"}, new McpToolRegistry(pi, rows).renderers("mcp__demo__work")],
    ];
    let redraws = 0;
    for (const [name, args, renderers] of fixtures) {
        for (const isError of [false, true]) {
            const component = nativeTool(name, name + isError, args, renderers, () => redraws++);
            const view = () => component.render(80).map(stripVTControlCharacters).filter(Boolean);
            assert.equal(view().length, 1, `${name} only shows its active header`);
            assert.ok(view()[0]!.includes(name));
            component.setArgsComplete();
            component.markExecutionStarted();
            component.updateResult({
                content: [{type: "text", text: "private partial output"}],
                details: {fullOutputPath: "/tmp/private-output"},
                isError: false,
            }, true);
            assert.equal(view().length, 1);
            assert.doesNotMatch(view().join("\n"), /private|Full output/);
            for (const width of [1, 8, 30]) {
                assert.ok(component.render(width).every((line) => displayWidth(line) <= width));
            }
            component.updateResult({content: [{type: "text", text: "completed or cancelled"}], isError});
            assert.deepEqual(component.render(80), [], `${name} leaves no completed rows or spacers`);
        }
    }
    const afterCompletion = redraws;
    t.mock.timers.tick(800);
    assert.equal(redraws, afterCompletion, "hidden completion must stop active animation timers");
});

test("hidden headers follow streamed arguments and disappear independently as concurrent calls finish", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    t.after(() => rows.clear());
    const read = new ReadTool({} as ExtensionAPI, () => assert.fail(), rows).toolDefinition();
    const first = nativeTool("read", "first", {path: "initial"}, read);
    const second = nativeTool("read", "second", {path: "second.ts"}, read);
    first.updateArgs({path: "first.ts", offset: 5, limit: 3});
    assert.match(first.render(80).map(stripVTControlCharacters).join("\n"), /first\.ts:5-7/);
    first.updateResult({content: [], isError: false});
    assert.deepEqual(first.render(80), []);
    assert.match(second.render(80).map(stripVTControlCharacters).join("\n"), /second\.ts/);
    second.updateResult({content: [], isError: true});
    assert.deepEqual(second.render(80), []);
});

test("changing the view pair redraws existing rows and hiding does not discard full output", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    t.after(() => rows.clear());
    const read = new ReadTool({} as ExtensionAPI, () => assert.fail(), rows).toolDefinition();
    const component = nativeTool("read", "restored", {path: "history.ts"}, read);
    const output = Array.from({length: 20}, (_, index) => `line ${index + 1}`).join("\n");
    component.updateResult({content: [{type: "text", text: output}], isError: false});
    rows.toggle("restored");
    assert.match(component.render(80).map(stripVTControlCharacters).join("\n"), /line 1\nline 2/);
    rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    assert.deepEqual(component.render(80), [], "hidden also suppresses previous row-local full overrides");
    component.setExpanded(true);
    assert.match(component.render(80).map(stripVTControlCharacters).join("\n"), /line 20/);
    component.setExpanded(false);
    assert.deepEqual(component.render(80), []);
    rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.TRUNCATED);
    assert.match(component.render(80).map(stripVTControlCharacters).join("\n"), /line 1\nline 2/);
});

test("hidden codemode shows only currently running nested calls and removes finished script content", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    t.after(() => rows.clear());
    let definition!: ToolDefinition;
    const pi = {
        registerTool(tool: ToolDefinition) { definition = tool; },
        getSettings: () => ({codemode: {mode: "on", inlineBudget: 3000}}),
        getAllTools: () => [],
        appendEntry() {},
    } as unknown as ExtensionAPI;
    new ReadTool(pi, () => assert.fail(), rows).toolDefinition();
    new CodemodeExtension(pi, rows).register();
    const component = nativeTool("codemode", "script", {purpose: "Inspect active work", code: "private script"}, definition);
    component.markExecutionStarted();
    const calls: CodemodeToolDetails["calls"] = [
        {id: "script/1", name: "read", args: '{"path":"finished.ts"}', status: "ok", durationMs: 25},
        {id: "script/2", name: "read", args: '{"path":"active.ts"}', status: "running"},
    ];
    const original = structuredClone(calls);
    component.updateResult({
        content: [{type: "text", text: "private output"}],
        details: {calls, fullOutputPath: "/tmp/private-output"},
        isError: false,
    }, true);
    const view = () => component.render(80).map(stripVTControlCharacters).join("\n");
    assert.match(view(), /codemode \| Inspect active work/);
    assert.match(view(), /read \| active\.ts/);
    assert.doesNotMatch(view(), /finished\.ts|private|Elapsed|Model calls/);
    component.updateResult({content: [], details: {calls: calls.map((call) => ({...call, status: "ok"}))}, isError: false}, true);
    assert.doesNotMatch(view(), /active\.ts|finished\.ts/);
    component.updateResult({content: [{type: "text", text: "failed or cancelled script"}], details: {calls}, isError: true});
    assert.deepEqual(component.render(80), []);
    assert.deepEqual(calls, original, "display filtering must not mutate nested-call history");
});

function nativeTool(
    name: string,
    id: string,
    args: Record<string, unknown>,
    renderers: ToolRenderers,
    requestRender = () => {},
): ToolExecutionComponent {
    return new ToolExecutionComponent(name, id, args, {outputPad: 0}, renderers,
        {requestRender} as ConstructorParameters<typeof ToolExecutionComponent>[5], process.cwd());
}
