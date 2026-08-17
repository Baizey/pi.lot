import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {McpManager} from "../src/mcp/client.js";
import {handleMcpCommand, mcpCommandCompletions} from "../src/mcp/commands.js";
import {McpConfigStore, sanitizeMcpConfig} from "../src/mcp/config.js";
import {McpToolRegistry} from "../src/mcp/tools.js";

test("MCP commands connect, expose, show, hide, and disconnect", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mcp-command-"));
    const store = new McpConfigStore(path.join(directory, "mcp.json"));
    const config = sanitizeMcpConfig({
        servers: {
            demo: {
                transport: "stdio",
                command: "demo-server",
                autoConnect: false,
                tools: {},
            },
        },
    });
    store.save(config);
    const manager = new McpManager(config, () => ({
        async connect() {},
        async listTools() {
            return [{name: "echo", inputSchema: {type: "object"}}];
        },
        async callTool() {
            return {content: [{type: "text", text: "ok"}]};
        },
        async close() {},
    }));
    const registered: ToolDefinition[] = [];
    const registry = new McpToolRegistry({
        registerTool(tool: ToolDefinition) {
            registered.push(tool);
        },
    } as Pick<ExtensionAPI, "registerTool">, manager, store);
    const services = {store, manager, registry};

    try {
        const connected = await handleMcpCommand(services, "connect demo");
        assert.match(connected.message, /Connected demo \(1 tools, 0 newly registered\)/);
        assert.equal(registered.length, 0);

        const exposed = await handleMcpCommand(services, "expose demo echo");
        assert.match(exposed.message, /Registered tools: mcp_demo_echo/);
        assert.equal(registered.length, 1);

        const shown = await handleMcpCommand(services, "show demo");
        assert.match(shown.message, /state connected \(1 tools\)/);
        assert.match(shown.message, /expose echo/);

        const hidden = await handleMcpCommand(services, "hide demo echo");
        assert.match(hidden.message, /remain visible until \/reload/);
        assert.deepEqual(store.load().servers.demo?.tools, {hide: ["echo"]});

        const disconnected = await handleMcpCommand(services, "disconnect demo");
        assert.match(disconnected.message, /Disconnected MCP server: demo/);
    } finally {
        await manager.disconnectAll();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("MCP command completion uses configured servers and discovered tools", () => {
    const config = sanitizeMcpConfig({
        servers: {
            demo: {transport: "stdio", command: "demo-server", tools: {}},
        },
    });
    assert.equal(mcpCommandCompletions("con", config)[0]?.value, "connect");
    assert.deepEqual(
        mcpCommandCompletions("connect ", config).map((item) => item.value),
        ["connect all", "connect demo"],
    );
    assert.deepEqual(
        mcpCommandCompletions("expose demo ", config, () => ["echo"]).map((item) => item.value),
        ["expose demo *", "expose demo echo"],
    );
});
