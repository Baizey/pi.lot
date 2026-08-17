import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {McpManager} from "../src/mcp/client.js";
import {McpConfigStore, sanitizeMcpConfig} from "../src/mcp/config.js";
import {McpExtension} from "../src/mcp/McpExtension.js";

test("MCP extension owns connection lifecycle and registers exposed discovered tools", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mcp-extension-"));
    const store = new McpConfigStore(path.join(directory, "mcp.json"));
    const config = sanitizeMcpConfig({
        servers: {
            demo: {
                transport: "stdio",
                command: "demo-server",
                tools: {expose: ["echo"]},
            },
        },
    });
    store.save(config);
    let closed = 0;
    const manager = new McpManager(config, () => ({
        async connect() {},
        async listTools() {
            return [{name: "echo", inputSchema: {type: "object"}}];
        },
        async callTool() {
            return {content: [{type: "text", text: "ok"}]};
        },
        async close() {
            closed++;
        },
    }));
    const commands: string[] = [];
    const tools: ToolDefinition[] = [];
    const pi = {
        registerCommand(name: string) {
            commands.push(name);
        },
        registerTool(tool: ToolDefinition) {
            tools.push(tool);
        },
    } as unknown as ExtensionAPI;
    const extension = new McpExtension(pi, {store, manager});

    try {
        extension.register();
        await extension.startSession({cwd: directory} as ExtensionContext);
        assert.deepEqual(commands, ["mcp"]);
        assert.deepEqual(tools.map((tool) => tool.name), ["mcp_demo_echo"]);
        await extension.stopSession();
        await extension.stopSession();
        assert.equal(closed, 1);
    } finally {
        await manager.disconnectAll();
        rmSync(directory, {recursive: true, force: true});
    }
});
