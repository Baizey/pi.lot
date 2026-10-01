import assert from "node:assert/strict";
import test from "node:test";
import {
    initTheme,
    ToolExecutionComponent,
    type ExtensionToolContext,
    type Theme,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {McpToolRegistry} from "../src/mcp/McpToolRegistry.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {displayWidth} from "../src/tui/terminalText.js";

function definition(name = "mcp__demo__echo", exposure: ToolDefinition["exposure"] = "direct"): ToolDefinition {
    return {
        name,
        label: "demo/echo",
        description: "Native echo description",
        parameters: {type: "object", properties: {value: {type: "string"}}} as ToolDefinition["parameters"],
        outputSchema: {type: "object"} as ToolDefinition["parameters"],
        exposure,
        namespace: {name: "mcp__demo", description: "Native server instructions"},
        annotations: {readOnlyHint: true},
        async execute(_id, params, _signal, _update, ctx) {
            return {
                content: [{type: "text", text: `${ctx.cwd}:${JSON.stringify(params)}`}],
                details: {server: "demo", tool: "echo"},
                structuredContent: {content: [{type: "text", text: "raw"}]},
            };
        },
    };
}

const context = {cwd: "/child", tools: [], executeTool: async () => { throw new Error("unexpected nested call"); }} as unknown as ExtensionToolContext;

test("native MCP registry preserves metadata and invokes the native definition with child context", async () => {
    const registered: ToolDefinition<any, any>[] = [];
    const registry = new McpToolRegistry({registerTool: (tool) => { registered.push(tool); }});
    registry.startSession();
    const native = definition();
    registry.register(native);
    const decorated = registered[0]!;
    assert.equal(decorated.parameters, native.parameters);
    assert.equal(decorated.outputSchema, native.outputSchema);
    assert.equal(decorated.annotations, native.annotations);
    assert.equal(decorated.namespace, native.namespace);
    assert.equal(decorated.description, native.description);
    assert.equal(decorated.exposure, "direct");
    assert.equal(decorated.renderShell, "self");
    const result = await decorated.execute("call", {value: "hello"}, undefined, undefined, context);
    assert.deepEqual(result.content, [{type: "text", text: '/child:{"value":"hello"}'}]);
    assert.deepEqual(result.structuredContent, {content: [{type: "text", text: "raw"}]});
});

test("retained MCP proxies honor withdrawal, new definitions, schema changes, and session shutdown", async () => {
    const registry = new McpToolRegistry({registerTool() {}});
    registry.startSession();
    registry.register(definition());
    const snapshot = registry.toolDefinitions();
    const proxy = snapshot[0]!;
    registry.register(definition("mcp__demo__echo", "hidden"));
    assert.deepEqual(registry.toolDefinitions(), []);
    await assert.rejects(async () => proxy.execute("call", {}, undefined, undefined, context), /no longer exposed/);

    registry.register({
        ...definition(),
        async execute() { return {content: [{type: "text", text: "new connection"}], details: undefined}; },
    });
    assert.deepEqual((await proxy.execute("call", {}, undefined, undefined, context)).content, [{type: "text", text: "new connection"}]);
    registry.register(definition("mcp__demo__new"));
    assert.deepEqual(snapshot.map((tool) => tool.name), ["mcp__demo__echo"]);
    registry.register({...definition(), parameters: {type: "object", properties: {count: {type: "number"}}} as ToolDefinition["parameters"]});
    await assert.rejects(async () => proxy.execute("call", {}, undefined, undefined, context), /schema changed/);

    registry.stopSession();
    registry.stopSession();
    await assert.rejects(async () => proxy.execute("call", {}, undefined, undefined, context), /no longer exposed/);
    registry.register(definition());
    assert.deepEqual(registry.toolDefinitions(), []);
    registry.startSession();
    registry.register(definition());
    await assert.rejects(async () => proxy.execute("call", {}, undefined, undefined, context), /no longer exposed/);
});

test("MCP child definitions include indirect exposures but never hidden or aggregate resource tools", () => {
    const registry = new McpToolRegistry({registerTool() {}});
    registry.startSession();
    registry.register(definition("mcp__demo__direct"));
    registry.register(definition("mcp__demo__code", "codemode"));
    registry.register(definition("mcp__demo__deferred", "deferred"));
    registry.register(definition("mcp__demo__hidden", "hidden"));
    registry.register(definition("list_mcp_resources"));
    registry.register(definition("list_mcp_resource_templates"));
    registry.register(definition("read_mcp_resource"));
    assert.deepEqual(registry.toolDefinitions().map((tool) => tool.name), [
        "mcp__demo__direct", "mcp__demo__code", "mcp__demo__deferred",
    ]);
});

test("native MCP calls keep Pilot's copy-safe shell, compact, expanded, and row-local full rendering", (t) => {
    initTheme("dark");
    const rows = new ToolDisplayRows();
    t.after(() => rows.clear());
    let decorated!: ToolDefinition<any, any>;
    const registry = new McpToolRegistry({registerTool: (tool) => { decorated = tool; }}, rows);
    registry.startSession();
    registry.register(definition());
    assert.equal(decorated.renderShell, "self");
    const output = Array.from({length: 12}, (_, index) => `result ${index + 1} 界🙂`);
    const args = {value: "symbol → 界🙂"};
    const component = new ToolExecutionComponent(
        decorated.name, "mcp-call", args, {}, decorated,
        {requestRender() {}} as any, process.cwd(),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({content: [{type: "text", text: output.join("\n")}], isError: false});
    component.setExpanded(false);
    const compact = component.render(100).map(stripAnsi);
    assert.deepEqual(compact.filter(Boolean), ["  mcp__demo__echo"]);
    assert.equal(rows.list().length, 1);

    component.setExpanded(true);
    const expanded = component.render(100).map(stripAnsi);
    assert.ok(expanded.includes("symbol → 界🙂"));
    assert.ok(expanded.includes(output.at(-1)!));
    assert.equal(expanded.includes(output[0]!), false);
    assert.ok(expanded.some((line) => line.includes("7 earlier lines")));
    assert.ok(expanded.every((line) => !/[ \t]+$/.test(line)));

    rows.toggle("mcp-call");
    component.setExpanded(false);
    const full = component.render(100).map(stripAnsi);
    for (const line of output) assert.ok(full.includes(line));
    for (const width of [1, 8, 20, 80]) {
        assert.ok(component.render(width).every((line) => displayWidth(line) <= width));
    }
    component.updateResult({content: [{type: "text", text: "native MCP error"}], isError: true});
    assert.ok(component.render(100).map(stripAnsi).some((line) => line === "  mcp__demo__echo"));

    const plainTheme = {fg: (_color: string, text: string) => text, bold: (text: string) => text} as unknown as Theme;
    const state = {};
    const partial = decorated.renderCall!(args, plainTheme, {
        toolCallId: "partial", state, invalidate() {}, expanded: false, isPartial: true,
    } as any).render(100);
    assert.deepEqual(partial, ["⠋ mcp__demo__echo"]);
});

test("MCP long-line previews are bounded by wrapped rows and keep a separate full-output hint", () => {
    const rows = new ToolDisplayRows();
    let decorated!: ToolDefinition;
    const registry = new McpToolRegistry({registerTool: (tool) => { decorated = tool as ToolDefinition; }}, rows);
    registry.startSession();
    registry.register(definition());
    const plainTheme = {fg: (_color: string, text: string) => text, bold: (text: string) => text} as unknown as Theme;
    const text = `START${"x".repeat(1000)}END`;
    const result = {content: [{type: "text" as const, text}], details: {fullOutputPath: "/tmp/full.json"}};
    const context = {
        args: {}, toolCallId: "long", state: {}, invalidate() {}, lastComponent: undefined,
        cwd: process.cwd(), executionStarted: true, argsComplete: true,
        isPartial: false, expanded: true, showImages: false, isError: false,
    };
    const preview = decorated.renderResult!(result, {expanded: true, isPartial: false}, plainTheme, context).render(40);
    assert.ok(preview.length <= 8, "five wrapped output rows, fold notice, spacer, and file hint");
    assert.ok(preview.includes("Full output: /tmp/full.json"));
    assert.ok(preview.some((line) => line.includes("END")));
    assert.ok(preview.some((line) => line.includes("earlier lines")));
    assert.ok(preview.every((line) => displayWidth(line) <= 40));
    const full = decorated.renderResult!(result, {expanded: false, isPartial: false}, plainTheme,
        {...context, state: {pilotFullDisplay: true}}).render(40);
    assert.equal(full.filter((line) => line && !line.startsWith("Full output:")).join(""), text);
    assert.ok(full.every((line) => !/[ \t]+$/.test(line)));
    assert.deepEqual(decorated.renderResult!(result, {expanded: false, isPartial: false}, plainTheme, context).render(40), []);
});

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
