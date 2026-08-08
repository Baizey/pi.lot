import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {registerExperiments} from "../src/experiment/registerExperiments.js";

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

test("the bash-network experiment applies flow and HTTP approval before an outbound connection", async () => {
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
    const prompts: Array<{title: string; message: string}> = [];
    const ctx = {
        cwd: workspace,
        hasUI: true,
        ui: {
            async confirm(title: string, message: string): Promise<boolean> {
                prompts.push({title, message});
                if (title === "Allow HTTP GET?") assert.equal(acceptedConnections, 0);
                return true;
            },
        },
    } as unknown as ExtensionContext;

    try {
        const result = await bashTool.execute(
            "network-test-call",
            {
                command: [
                    `curl --noproxy '*' --silent http://10.0.2.2:${address.port}`,
                    `curl --noproxy '*' --silent http://10.0.2.2:${address.port}`,
                ].join("; "),
                timeout: 10,
            },
            undefined,
            undefined,
            ctx,
        );

        const output = (result as {content: Array<{text?: string}>}).content[0]?.text ?? "";
        assert.equal(acceptedConnections, 2);
        assert.equal(output.match(/operation=HTTP_REQUEST/g)?.length, 2);
        assert.match(output, /decision=ALLOW/);
        assert.match(output, new RegExp(`url="http://10\\.0\\.2\\.2:${address.port}/"`));
        assert.match(output, /operation=HTTP_REQUEST[^\n]+reused=true/);
        assert.equal(prompts.length, 2);
        assert.match(prompts[0]?.message ?? "", /Transport: tcp/);
        assert.match(prompts[0]?.message ?? "", new RegExp(`Target: 10\\.0\\.2\\.2:${address.port}`));
        assert.match(prompts[0]?.message ?? "", /initial SYN is held/);
        assert.equal(prompts[1]?.title, "Allow HTTP GET?");
        assert.match(
            prompts[1]?.message ?? "",
            new RegExp(`Canonical URL: "http://10\\.0\\.2\\.2:${address.port}/"`),
        );
        assert.match(prompts[1]?.message ?? "", /denying creates no target-side connection/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("the registered HTTP decision denies before the target-side connection", async () => {
    const bashTool = registeredBashTools().get("bash-network");
    assert.ok(bashTool);

    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-network-extension-deny-"));
    const server = createServer();
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
    const titles: string[] = [];
    const ctx = {
        cwd: workspace,
        hasUI: true,
        ui: {
            async confirm(title: string): Promise<boolean> {
                titles.push(title);
                return title !== "Allow HTTP GET?";
            },
        },
    } as unknown as ExtensionContext;

    try {
        await assert.rejects(
            bashTool.execute(
                "network-deny-test-call",
                {
                    command: `curl --noproxy '*' --silent --show-error --fail http://10.0.2.2:${address.port}`,
                    timeout: 10,
                },
                undefined,
                undefined,
                ctx,
            ),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /decision=DENY operation=HTTP_REQUEST/);
                assert.match(error.message, /Command exited with code 22/);
                return true;
            },
        );
        assert.deepEqual(titles, ["Allow network tcp_connect?", "Allow HTTP GET?"]);
        assert.equal(acceptedConnections, 0);
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
    registerExperiments(pi, () => {});
    return bashTools;
}
