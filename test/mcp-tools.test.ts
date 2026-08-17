import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {McpManager} from "../src/mcp/client.js";
import {McpConfigStore, sanitizeMcpConfig} from "../src/mcp/config.js";
import {
    buildMcpPiToolNames,
    formatMcpResultText,
    McpToolRegistry,
    sanitizeToolNamePart,
} from "../src/mcp/tools.js";
import {McpCommandAction} from "../src/mcp/types.js";

test("MCP tool names are stable, sanitized, and collision-safe", () => {
    assert.equal(sanitizeToolNamePart("My Server!"), "my_server");
    const names = buildMcpPiToolNames("demo", ["read-file", "read_file"]);
    assert.equal(names.get("read-file"), "mcp_demo_read_file");
    assert.match(names.get("read_file") ?? "", /^mcp_demo_read_file_[0-9a-f]{8}$/);
});

test("MCP result conversion preserves supported content and bounds text", () => {
    const result = formatMcpResultText({
        content: [
            {type: "text", text: "hello"},
            {type: "image", data: "ZmFrZQ==", mimeType: "image/png"},
            {type: "resource", resource: {uri: "file:///note", text: "note"}},
        ],
    });
    assert.deepEqual(result.contentTypes, ["text", "image", "resource"]);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[1]?.type, "image");
    assert.match(result.content[2]?.type === "text" ? result.content[2].text : "", /file:\/\/\/note/);
});

test("exposed MCP tools register once and re-check exposure when called", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mcp-tools-"));
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
    const manager = new McpManager(config, () => ({
        async connect() {},
        async listTools() {
            return [{
                name: "echo",
                description: "Echo a value",
                inputSchema: {
                    type: "object",
                    properties: {value: {type: "string"}},
                    required: ["value"],
                },
            }];
        },
        async callTool(_name, args, options) {
            options.onprogress?.({progress: 1, total: 1, message: "done"});
            return {content: [{type: "text", text: String(args.value)}]};
        },
        async close() {},
    }));
    const registered: ToolDefinition[] = [];
    const pi = {
        registerTool(tool: ToolDefinition) {
            registered.push(tool);
        },
    } as Pick<ExtensionAPI, "registerTool">;
    const registry = new McpToolRegistry(pi, manager, store);

    try {
        await manager.connect("demo");
        const first = registry.registerAvailableTools();
        const second = registry.registerAvailableTools();
        assert.deepEqual(first.registered.map((item) => item.piToolName), ["mcp_demo_echo"]);
        assert.equal(second.registered.length, 0);
        assert.equal(registered.length, 1);

        const updates: unknown[] = [];
        const result = await registered[0]!.execute(
            "call-1",
            {value: "hello"},
            undefined,
            (update) => updates.push(update),
            {} as ExtensionContext,
        );
        assert.deepEqual(result.content, [{type: "text", text: "hello"}]);
        assert.equal(result.details && (result.details as {server?: string}).server, "demo");
        assert.equal(updates.length, 1);

        const hidden = store.setToolExposure("demo", McpCommandAction.HIDE, ["echo"]);
        manager.updateConfig(hidden);
        await assert.rejects(
            registered[0]!.execute("call-2", {value: "blocked"}, undefined, undefined, {} as ExtensionContext),
            /not exposed/,
        );
    } finally {
        await manager.disconnectAll();
        rmSync(directory, {recursive: true, force: true});
    }
});
