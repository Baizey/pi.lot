import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {McpConnectionState, McpManager} from "../src/mcp/client.js";
import type {
    McpClientRequestOptions,
    McpConfigSnapshot,
    McpServerClient,
    McpServerConfig,
} from "../src/mcp/types.js";
import {McpTransportKind} from "../src/mcp/types.js";

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
        transport: McpTransportKind.STDIO,
        command: "demo-server",
        args: [],
        cwd: "relative-server-cwd",
        env: {},
        enabled: true,
        autoConnect: true,
        tools: {},
        connectTimeoutMs: 1000,
        listToolsTimeoutMs: 1000,
        toolTimeoutMs: 2000,
        toolMaxTotalTimeoutMs: 5000,
        ...overrides,
    } as McpServerConfig;
}

test("MCP manager connects, discovers tools, calls them, and disconnects", async () => {
    const config: McpConfigSnapshot = {servers: {demo: server()}};
    let resolvedConfig: McpServerConfig | undefined;
    let closed = 0;
    let callOptions: McpClientRequestOptions | undefined;
    const client: McpServerClient = {
        async connect() {},
        async listTools() {
            return [{name: "echo", description: "Echo input", inputSchema: {type: "object"}}];
        },
        async callTool(_toolName, args, options) {
            callOptions = options;
            return {content: [{type: "text", text: String(args.value)}]};
        },
        async close() {
            closed++;
        },
    };
    const manager = new McpManager(config, (_name, candidate) => {
        resolvedConfig = candidate;
        return client;
    });
    manager.setBaseCwd("/tmp/pilot-mcp-base");

    const tools = await manager.connect("demo");
    assert.equal(tools[0]?.name, "echo");
    assert.equal(resolvedConfig?.transport, McpTransportKind.STDIO);
    assert.equal(resolvedConfig?.transport === McpTransportKind.STDIO ? resolvedConfig.cwd : undefined, "/tmp/pilot-mcp-base/relative-server-cwd");
    assert.equal(manager.snapshot().states[0]?.state, McpConnectionState.CONNECTED);

    const result = await manager.callTool("demo", "echo", {value: "hello"});
    assert.deepEqual(result.content, [{type: "text", text: "hello"}]);
    assert.equal(callOptions?.timeout, 2000);
    assert.equal(callOptions?.maxTotalTimeout, 5000);
    assert.equal(callOptions?.resetTimeoutOnProgress, true);

    manager.updateConfig({servers: {demo: {...server(), tools: {expose: ["echo"]}}}});
    assert.equal(manager.snapshot().states[0]?.state, McpConnectionState.CONNECTED);
    assert.equal(closed, 0);

    await manager.disconnectAll();
    assert.equal(closed, 1);
    assert.equal(manager.snapshot().states[0]?.state, McpConnectionState.DISCONNECTED);
});

test("MCP manager interoperates with a real stdio SDK server", async () => {
    const fixture = path.resolve("test/fixtures/mcp-stdio-server.mjs");
    const config: McpConfigSnapshot = {
        servers: {
            stdio: server({
                command: process.execPath,
                args: [fixture],
                cwd: undefined,
                connectTimeoutMs: 15_000,
                listToolsTimeoutMs: 15_000,
            }),
        },
    };
    const manager = new McpManager(config);
    try {
        const tools = await manager.connect("stdio");
        assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
        const result = await manager.callTool("stdio", "echo", {value: "from stdio"});
        assert.deepEqual(result.content, [{type: "text", text: "from stdio"}]);
    } finally {
        await manager.disconnectAll();
    }
});

test("MCP auto-connect records a server error without rejecting session startup", async () => {
    const manager = new McpManager({servers: {broken: server()}}, () => ({
        async connect() {
            throw new Error("connection failed");
        },
        async listTools() {
            return [];
        },
        async callTool() {
            return {};
        },
        async close() {},
    }));

    await manager.connectAuto();
    assert.deepEqual(manager.snapshot().states[0], {
        serverName: "broken",
        state: McpConnectionState.ERROR,
        toolCount: 0,
        error: "connection failed",
    });
});
