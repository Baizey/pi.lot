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

test("hidden tool views use truncated active previews and partial output but leave no completed rows", (t) => {
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
            const preview = () => {
                rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
                const lines = view();
                rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
                return lines;
            };
            assert.deepEqual(view(), preview(), `${name} uses its truncated call layout while active`);
            assert.ok(view()[0]!.includes(name));
            component.setArgsComplete();
            component.markExecutionStarted();
            component.updateResult({
                content: [{type: "text", text: "private partial output"}],
                details: {fullOutputPath: "/tmp/private-output"},
                isError: false,
            }, true);
            assert.deepEqual(view(), preview().filter((line) => !line.startsWith("Full output:")),
                `${name} uses its truncated partial-result layout without extra metadata`);
            assert.ok(view().includes("private partial output"));
            assert.doesNotMatch(view().join("\n"), /Full output/);
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

test("hidden previews bound streamed arguments and output on either slot despite row-local full overrides", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    for (const expanded of [false, true]) {
        const rows = new ToolDisplayRows();
        rows.modes.setViews(
            expanded ? ToolDisplayMode.FULL : ToolDisplayMode.HIDDEN,
            expanded ? ToolDisplayMode.HIDDEN : ToolDisplayMode.FULL,
        );
        t.after(() => rows.clear());
        const write = new WriteTool({} as ExtensionAPI, () => assert.fail(), rows).toolDefinition();
        const content = (count: number) => Array.from({length: count}, (_, index) => `content ${index + 1}`).join("\n");
        const component = nativeTool("write", "streamed", {path: "active.ts", content: content(20)}, write);
        component.setExpanded(expanded);
        const view = () => component.render(80).map(stripVTControlCharacters).filter(Boolean);
        assert.deepEqual(view().slice(1, 9), content(8).split("\n"));
        assert.equal(view().at(-1), "... (12 more lines)");
        component.updateArgs({path: "updated.ts", content: content(25)});
        assert.match(view()[0]!, /updated\.ts/);
        assert.equal(view().at(-1), "... (17 more lines)");
        rows.toggle("streamed");
        assert.equal(view().includes("content 9"), false, "full overrides must not bypass hidden preview limits");
        component.setArgsComplete();
        component.markExecutionStarted();
        const output = Array.from({length: 20}, (_, index) => `output ${index + 1}`).join("\n");
        const result = {content: [{type: "text", text: output}], isError: false};
        component.updateResult(result, true);
        assert.deepEqual(view().slice(-6), ["... (15 earlier lines)", ...output.split("\n").slice(-5)]);
        component.setExpanded(!expanded);
        assert.ok(view().includes("content 25"));
        assert.ok(view().includes("output 1"));
        component.setExpanded(expanded);
        assert.equal(view().includes("content 9"), false);
        assert.equal(view().includes("output 1"), false);
        component.updateResult(result);
        assert.deepEqual(component.render(80), []);
        component.setExpanded(!expanded);
        assert.ok(view().includes("output 1"), "completion preserves output outside the hidden view");
    }
});

test("hidden edit previews retain truncated replacement and partial-result tails until completion", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    t.after(() => rows.clear());
    const edit = new EditTool({} as ExtensionAPI, () => assert.fail(), rows).toolDefinition();
    const component = nativeTool("edit", "replacement", {path: "active.ts"}, edit);
    const view = () => component.render(80).map(stripVTControlCharacters).filter(Boolean);
    for (const count of [30, 45]) {
        const lines = Array.from({length: count}, (_, index) => `replacement ${index + 1}`);
        component.updateArgs({path: "active.ts", edits: [{oldText: "before", newText: lines.join("\n")}]});
        assert.deepEqual(view().slice(-12), lines.slice(-12).map((line) => `+${line}`));
        assert.equal(view().includes("+replacement 1"), false);
        assert.ok(view().includes(`... (${count - 11} earlier lines)`));
    }
    component.setArgsComplete();
    component.markExecutionStarted();
    const lines = Array.from({length: 30}, (_, index) => `+applied ${index + 1}`);
    component.updateResult({content: [], details: {diff: lines.join("\n")}, isError: false}, true);
    assert.deepEqual(view().slice(-12), lines.slice(-12));
    assert.ok(view().includes("... (18 earlier lines)"));
    component.updateResult({content: [], details: {diff: lines.join("\n")}, isError: false});
    assert.deepEqual(component.render(80), []);
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
    new BashTool(pi, () => assert.fail(), rows).toolDefinition();
    new CodemodeExtension(pi, rows).register();
    const numberedLines = (prefix: string) => Array.from({length: 12}, (_, index) => `${prefix} ${index + 1}`).join("\n");
    const component = nativeTool("codemode", "script", {purpose: "Inspect active work", code: numberedLines("script")}, definition);
    component.markExecutionStarted();
    const calls: CodemodeToolDetails["calls"] = [
        {id: "script/1", name: "read", args: '{"path":"finished.ts"}', status: "ok", durationMs: 25},
        {id: "script/2", name: "read", args: '{"path":"active.ts"}', status: "running"},
        {id: "script/3", name: "bash", args: JSON.stringify({purpose: "Nested work", command: numberedLines("command")}), status: "running"},
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
    assert.match(view(), /script 1\nscript 2/);
    assert.match(view(), /bash \| Nested work/);
    assert.match(view(), /command 1\n\s+command 2/);
    assert.equal((view().match(/4 more lines/g) ?? []).length, 2, "script and nested arguments both use preview limits");
    assert.doesNotMatch(view(), /script 9|command 9|finished\.ts|private|Elapsed|Model calls/);
    component.updateResult({content: [], details: {calls: calls.map((call) => ({...call, status: "ok"}))}, isError: false}, true);
    assert.doesNotMatch(view(), /active\.ts|finished\.ts|Nested work|command 1/);
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
