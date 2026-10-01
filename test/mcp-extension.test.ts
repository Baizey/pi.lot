import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
    createCodemodeExtension,
    createToolSearchExtension,
    type ExtensionContext,
    type ExtensionToolContext,
    type LoadedMcpConfig,
} from "@earendil-works/pi-coding-agent";
import {McpExtension} from "../src/mcp/McpExtension.js";
import {CodemodeExtension} from "../src/tools/codemode/CodemodeExtension.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {NativeMcpFixture} from "./fixtures/NativeMcpFixture.js";

function config(): LoadedMcpConfig {
    return {
        errors: [],
        servers: [
            {name: "demo", source: "fixture", scope: "extension", config: {command: "fake", exposure: "hidden", toolExposure: {echo: "direct"}}},
            {name: "offline", source: "fixture", scope: "extension", config: {command: "fake", exposure: "hidden"}},
        ],
    };
}

function createExtension(fixture: NativeMcpFixture, loaded = config()): McpExtension {
    return new McpExtension(fixture.pi, {nativeOptions: {loadConfig: () => loaded, createTransport: fixture.createTransport}});
}

test("Pilot hosts native MCP core, quietly connects, and leaves explicit native /mcp diagnostics visible", async () => {
    const fixture = new NativeMcpFixture();
    const extension = createExtension(fixture);
    await assert.rejects(extension.startSession(fixture.ctx), /not registered/);
    extension.register();
    assert.throws(() => extension.register(), /already registered/);
    assert.deepEqual([...fixture.commands.keys()], ["mcp"]);
    // Pilot, not a separately registered native shutdown event, owns this lifecycle ordering.
    assert.equal(fixture.handlers.has("session_start"), false);
    assert.equal(fixture.handlers.has("session_shutdown"), false);
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        await assert.rejects(extension.startSession(fixture.ctx), /already started/);
        assert.equal(fixture.notifications.length, 0);
        assert.deepEqual(extension.toolDefinitions().map((tool) => tool.name), ["mcp__demo__echo"]);
        assert.equal(fixture.tools.get("mcp__demo__blocked")?.exposure, "hidden");
        const tool = fixture.tools.get("mcp__demo__echo")!;
        assert.equal(tool.renderShell, "self");
        assert.equal(tool.namespace?.instructions, "Fixture namespace instructions");
        assert.equal(tool.namespace?.description, undefined);
        assert.equal(tool.annotations?.readOnlyHint, true);
        const result = await tool.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext);
        assert.deepEqual(result.content, [{type: "text", text: "fixture result"}]);
        assert.deepEqual(result.structuredContent, {content: [{type: "text", text: "fixture result"}], structuredContent: {ok: true}});
        await fixture.commands.get("mcp")!.handler("", fixture.ctx as any);
        assert.match(fixture.notifications.at(-1)!.message, /offline: failed/);
        assert.match(fixture.notifications.at(-1)!.message, /fixture offline/);
        await fixture.commands.get("mcp")!.handler("reconnect offline", fixture.ctx as any);
        assert.equal(fixture.notifications.at(-1)!.type, "error");
        assert.match(fixture.notifications.at(-1)!.message, /fixture offline/);
        await extension.stopSession();
        await extension.stopSession();
        assert.ok(fixture.closes >= 2);
        assert.deepEqual(extension.toolDefinitions(), []);
        await assert.rejects(async () => tool.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext), /no longer exposed/);
    } finally {
        await extension.stopSession();
        await fixture.close();
    }
});

test("native MCP keeps config errors visible without reporting optional connection failures", async () => {
    const fixture = new NativeMcpFixture();
    const extension = createExtension(fixture, {...config(), errors: ["bad server allowlist"]});
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        assert.equal(fixture.notifications.length, 1);
        assert.match(fixture.notifications[0]!.message, /bad server allowlist/);
        assert.doesNotMatch(fixture.notifications[0]!.message, /offline/);
    } finally {
        await extension.stopSession();
        await fixture.close();
    }
});

test("slow native startup stays quiet and its tools become available once connected", async () => {
    const fixture = new NativeMcpFixture();
    let finishStartup!: () => void;
    fixture.startWait = new Promise<void>((resolve) => { finishStartup = resolve; });
    const extension = new McpExtension(fixture.pi, {nativeOptions: {
        loadConfig: () => config(), createTransport: fixture.createTransport, startupWaitMs: 1,
    }});
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        assert.equal(fixture.notifications.length, 0);
        assert.deepEqual(extension.toolDefinitions(), []);
        finishStartup();
        for (let attempt = 0; attempt < 20 && extension.toolDefinitions().length === 0; attempt++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.deepEqual(extension.toolDefinitions().map((tool) => tool.name), ["mcp__demo__echo"]);
        assert.equal(fixture.notifications.length, 0);
    } finally {
        finishStartup();
        await extension.stopSession();
        await fixture.close();
    }
});

test("shutdown during native startup cannot register tools into the stopped session", async () => {
    const fixture = new NativeMcpFixture();
    let finishStartup!: () => void;
    fixture.startWait = new Promise<void>((resolve) => { finishStartup = resolve; });
    const extension = new McpExtension(fixture.pi, {nativeOptions: {
        loadConfig: () => ({servers: [config().servers[0]!], errors: []}),
        createTransport: fixture.createTransport,
    }});
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await extension.stopSession();
        finishStartup();
        for (let attempt = 0; attempt < 20 && fixture.closes === 0; attempt++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.ok(fixture.closes > 0);
        assert.deepEqual(extension.toolDefinitions(), []);
        assert.equal(fixture.tools.size, 0);
        assert.equal(fixture.notifications.length, 0);
    } finally {
        finishStartup();
        await extension.stopSession();
        await fixture.close();
    }
});

test("native error results stay errors and preserve structured content", async () => {
    const fixture = new NativeMcpFixture();
    fixture.callResult = {content: [{type: "text", text: "operation denied by server"}], isError: true, structuredContent: {reason: "denied"}};
    const extension = createExtension(fixture);
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        const result = await extension.toolDefinitions()[0]!.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext);
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{type: "text", text: "operation denied by server"}]);
        assert.deepEqual(result.structuredContent, fixture.callResult);
    } finally {
        await extension.stopSession();
        await fixture.close();
    }
});

test("native list-changed withdrawal and registered-server disable revoke existing child proxies", async () => {
    const fixture = new NativeMcpFixture();
    fixture.registeredServers.set("demo", {command: "fake", exposure: "direct"});
    const extension = createExtension(fixture, {servers: [], errors: []});
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        const snapshot = extension.toolDefinitions();
        const proxy = snapshot.find((tool) => tool.name === "mcp__demo__blocked")!;
        assert.ok(proxy);
        assert.equal(fixture.tools.get("read_mcp_resource")?.renderShell, "self");
        assert.equal(snapshot.some((tool) => tool.name === "read_mcp_resource"), false);
        await fixture.changeTools(["echo"]);
        assert.equal(fixture.tools.get(proxy.name)?.exposure, "hidden");
        await assert.rejects(async () => proxy.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext), /no longer exposed/);
        const echo = extension.toolDefinitions()[0]!;
        fixture.registeredServers.set("demo", {command: "fake", exposure: "direct", enabled: false});
        await fixture.emit("mcp_servers_change");
        assert.deepEqual(extension.toolDefinitions(), []);
        await assert.rejects(async () => echo.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext), /no longer exposed/);
        assert.equal(fixture.tools.get("read_mcp_resource")?.exposure, "hidden");
    } finally {
        await extension.stopSession();
        await fixture.close();
    }
});

test("native hidden exposure is unreachable even when deferred and codemode discovery exist", async () => {
    const fixture = new NativeMcpFixture();
    const extension = createExtension(fixture, {
        servers: [{name: "demo", source: "fixture", scope: "extension", config: {
            command: "fake", exposure: "hidden", toolExposure: {echo: "deferred"},
        }}],
        errors: [],
    });
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        await fixture.emit("tool_call", {toolCallId: "discover", toolName: "list_mcp_resources", input: {}});
        // Wait for background discovery without depending on a prompt-start barrier.
        for (let attempt = 0; attempt < 20 && extension.toolDefinitions().length === 0; attempt++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(extension.toolDefinitions()[0]!.exposure, "deferred");
        assert.equal(fixture.tools.get("mcp__demo__blocked")?.exposure, "hidden");
        assert.equal(fixture.tools.has("read_mcp_resource"), false);
        // Misconfigured discovery stays visible, unlike a failed optional connection.
        assert.match(fixture.notifications[0]!.message, /neither is active/);
        const hidden = fixture.tools.get("mcp__demo__blocked")!;
        await assert.rejects(async () => hidden.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext), /no longer exposed/);
        assert.equal(fixture.calls.some((call) => call.method === "tools/call"), false);
    } finally {
        await extension.stopSession();
        await fixture.close();
    }
});

test("purpose-aware codemode activates before MCP discovery and waits when a script needs servers", async () => {
    const fixture = new NativeMcpFixture();
    new CodemodeExtension(fixture.pi, new ToolDisplayRows()).register();
    let finishStartup!: () => void;
    fixture.startWait = new Promise<void>((resolve) => { finishStartup = resolve; });
    const extension = createExtension(fixture, {
        errors: [], servers: [{name: "demo", source: "fixture", scope: "extension",
            config: {command: "fake", description: "Search the fixture service"}}],
    });
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        assert.ok(fixture.active.includes("codemode"), "activation must precede discovery");
        const sections: Record<string, string> = {};
        await fixture.emit("before_agent_start", {systemPromptOptions: {sections}});
        assert.deepEqual(extension.toolDefinitions(), []);
        assert.match(sections.mcp_servers!, /mcp__demo \(codemode\): Search the fixture service/);
        assert.equal(fixture.notifications.length, 0);

        let completed = false;
        const waiting = fixture.emit("tool_call", {
            toolCallId: "script", toolName: "codemode",
            input: {purpose: "Read the fixture service", code: "await tools.mcp__demo__echo({});"},
        }).then(() => { completed = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(completed, false, "script execution waits for its named server");
        finishStartup();
        await waiting;
        assert.equal(extension.toolDefinitions().length, 2);
        assert.ok(extension.toolDefinitions().every((tool) => tool.exposure === "deferred"));
        await fixture.emit("before_agent_start", {systemPromptOptions: {sections}});
        assert.match(sections.mcp_servers!, /Search the fixture service/);
        assert.equal(fixture.notifications.length, 0);
    } finally {
        finishStartup();
        await extension.stopSession();
        await fixture.close();
    }
});

test("purpose-aware scripts preserve namespace-scoped waits, discovery waits, and cancellation", async () => {
    const fixture = new NativeMcpFixture();
    new CodemodeExtension(fixture.pi, new ToolDisplayRows()).register();
    createToolSearchExtension()(fixture.pi);
    let finishDemo!: () => void;
    let finishOther!: () => void;
    fixture.serverStartWaits.set("demo", new Promise<void>((resolve) => { finishDemo = resolve; }));
    fixture.serverStartWaits.set("other", new Promise<void>((resolve) => { finishOther = resolve; }));
    const extension = createExtension(fixture, {
        errors: [], servers: ["demo", "other"].map((name) => ({
            name, source: "fixture", scope: "extension" as const, config: {command: "fake"},
        })),
    });
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        const named = fixture.emit("tool_call", {
            toolCallId: "named", toolName: "codemode",
            input: {purpose: "Read only the demo service", code: "await tools.mcp__demo__echo({});"},
        });
        finishDemo();
        await named;
        assert.ok(extension.toolDefinitions().some((tool) => tool.name.startsWith("mcp__demo__")));
        assert.equal(extension.toolDefinitions().some((tool) => tool.name.startsWith("mcp__other__")), false);

        for (const [toolName, input] of [
            ["codemode", {purpose: "Inspect the other service", code: 'await describeNamespace("other");'}],
            ["codemode", {purpose: "Discover fixture tools", code: 'await searchTools("fixture");'}],
            ["tool_search", {query: "fixture"}],
            ["list_mcp_resources", {}],
        ] as const) {
            const controller = new AbortController();
            let completed = false;
            const waiting = fixture.emit("tool_call", {toolCallId: "wait", toolName, input},
                {...fixture.ctx, signal: controller.signal} as ExtensionContext).then(() => { completed = true; });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(completed, false, `${toolName} waits for the remaining server`);
            controller.abort();
            await waiting;
        }
        assert.equal(extension.toolDefinitions().some((tool) => tool.name.startsWith("mcp__other__")), false);
    } finally {
        finishDemo();
        finishOther();
        await extension.stopSession();
        await fixture.close();
    }
});

test("native normalized names preserve distinct colliding tools and separate namespace summary from instructions", async () => {
    const fixture = new NativeMcpFixture();
    fixture.toolNames = ["read-file", "read_file"];
    const extension = createExtension(fixture, {
        errors: [], servers: [{name: "prod-api", source: "fixture", scope: "extension",
            config: {command: "fake", exposure: "direct", description: "Production search service"}}],
    });
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        const tools = extension.toolDefinitions();
        assert.equal(tools.length, 2);
        assert.notEqual(tools[0]!.name, tools[1]!.name);
        for (const tool of tools) {
            assert.match(tool.name, /^mcp__prod_api__read_file_[a-f0-9]{8}$/);
            assert.deepEqual(tool.namespace, {
                name: "mcp__prod_api", description: "Production search service", instructions: "Fixture namespace instructions",
            });
            await tool.execute("call", {}, undefined, undefined, fixture.ctx as ExtensionToolContext);
        }
        const calls = fixture.calls.filter((call) => call.method === "tools/call").map(({params}) => {
            assert.ok(params && typeof params === "object" && "name" in params && "arguments" in params);
            return {name: params.name, arguments: params.arguments};
        });
        assert.deepEqual(calls, [{name: "read-file", arguments: {}}, {name: "read_file", arguments: {}}]);
    } finally {
        await extension.stopSession();
        await fixture.close();
    }
});

test("native MCP core interoperates with a real stdio server without the legacy SDK", async () => {
    const fixture = new NativeMcpFixture();
    const extension = new McpExtension(fixture.pi, {nativeOptions: {loadConfig: () => ({
        errors: [],
        servers: [{name: "stdio", source: "fixture", scope: "extension", config: {
            command: process.execPath,
            args: [path.resolve("test/fixtures/mcp-stdio-server.mjs")],
            exposure: "hidden", toolExposure: {echo: "direct"}, timeout: 5,
        }}],
    })}});
    extension.register();
    try {
        await extension.startSession(fixture.ctx);
        await fixture.emit("before_agent_start");
        const tool = extension.toolDefinitions()[0]!;
        assert.equal(tool.name, "mcp__stdio__echo");
        const result = await tool.execute("stdio-call", {value: "native round-trip"}, undefined, undefined, fixture.ctx as ExtensionToolContext);
        assert.deepEqual(result.content, [{type: "text", text: "native round-trip"}]);
        assert.deepEqual(fixture.notifications, []);
    } finally {
        await extension.stopSession();
    }
});
