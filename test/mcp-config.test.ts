import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    defaultMcpConfigFile,
    exposedMcpTools,
    McpConfigStore,
    sanitizeMcpConfig,
} from "../src/mcp/config.js";
import {McpCommandAction, McpTransportKind} from "../src/mcp/types.js";

test("MCP configuration defaults to ~/.pilot/mcp.json", () => {
    assert.equal(defaultMcpConfigFile(), path.join(os.homedir(), ".pilot", "mcp.json"));
});

test("MCP configuration sanitizes transports, timeouts, and exposure", () => {
    const config = sanitizeMcpConfig({
        servers: {
            files: {
                transport: "stdio",
                command: "node",
                args: ["server.js", 4],
                env: {TOKEN: "$TOKEN", ignored: false},
                tools: {expose: ["read", "*"], hide: ["delete"]},
            },
            remote: {
                url: "https://mcp.example.test/rpc",
                headers: {Authorization: "Bearer $TOKEN"},
                autoConnect: false,
                toolTimeoutMs: 1234,
            },
            invalid: {transport: "stdio"},
            "bad name": {transport: "stdio", command: "ignored"},
        },
    });

    assert.deepEqual(Object.keys(config.servers), ["files", "remote"]);
    assert.equal(config.servers.files?.transport, McpTransportKind.STDIO);
    assert.deepEqual(config.servers.files?.tools, {expose: ["*"], hide: ["delete"]});
    assert.equal(config.servers.remote?.transport, McpTransportKind.HTTP);
    assert.equal(config.servers.remote?.autoConnect, false);
    assert.equal(config.servers.remote?.toolTimeoutMs, 1234);
    assert.deepEqual(exposedMcpTools(config.servers.files!, ["read", "delete", "stat"]), ["read", "stat"]);
});

test("MCP exposure updates persist with private file permissions", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mcp-config-"));
    const file = path.join(directory, "mcp.json");
    const store = new McpConfigStore(file);
    try {
        writeFileSync(file, "{}", {mode: 0o644});
        store.save(sanitizeMcpConfig({
            servers: {
                demo: {transport: "stdio", command: "demo-server", tools: {}},
            },
        }));
        store.setToolExposure("demo", McpCommandAction.EXPOSE, ["read"]);
        store.setToolExposure("demo", McpCommandAction.HIDE, ["write"]);

        assert.deepEqual(store.load().servers.demo?.tools, {expose: ["read"], hide: ["write"]});
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).servers.demo.command, "demo-server");

        store.resetToolExposure("demo", ["write"]);
        assert.deepEqual(store.load().servers.demo?.tools, {expose: ["read"]});
        store.resetToolExposure("demo");
        assert.deepEqual(store.load().servers.demo?.tools, {});
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
