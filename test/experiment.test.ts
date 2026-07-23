import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {registerExperiments} from "../src/experiment/registerExperiments.js";
import {PilotRuntimeConfig} from "../src/runtime/PilotRuntimeConfig.js";

type RegisteredBashTool = {
    name: string;
    execute: (
        id: string,
        params: {command: string; timeout?: number},
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<unknown>;
};

test("the bash-network experiment applies Pi approval before an outbound TCP connection", async () => {
    const bashTools = registeredBashTools();
    assert.deepEqual([...bashTools.keys()], ["bash-network"]);
    const bashTool = bashTools.get("bash-network");
    assert.ok(bashTool);

    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-extension-"));
    const server = createServer((socket) => {
        socket.once("data", () => {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    let acceptedConnections = 0;
    server.on("connection", () => {
        acceptedConnections++;
    });
    const prompts: string[] = [];
    const ctx = {
        cwd: workspace,
        hasUI: true,
        ui: {
            async confirm(_title: string, message: string): Promise<boolean> {
                prompts.push(message);
                return true;
            },
        },
    } as unknown as ExtensionContext;

    try {
        await bashTool.execute(
            "network-test-call",
            {
                command: `curl --noproxy '*' --silent http://10.0.2.2:${address.port}`,
                timeout: 10,
            },
            undefined,
            undefined,
            ctx,
        );

        assert.equal(acceptedConnections, 1);
        assert.equal(prompts.length, 1);
        assert.match(prompts[0] ?? "", /Transport: tcp/);
        assert.match(prompts[0] ?? "", new RegExp(`Target: 10\\.0\\.2\\.2:${address.port}`));
        assert.match(prompts[0] ?? "", /initial SYN is held/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(workspace, {recursive: true, force: true});
    }
});

function registeredBashTools(): Map<string, RegisteredBashTool> {
    const bashTools = new Map<string, RegisteredBashTool>();
    const pi = {
        registerTool(tool: RegisteredBashTool) {
            bashTools.set(tool.name, tool);
        },
    } as unknown as ExtensionAPI;
    const config = new PilotRuntimeConfig();
    registerExperiments(pi, () => config.networkPolicyGranularity);
    return bashTools;
}
