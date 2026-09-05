import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {
    PolicyAccessType,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
} from "../src/policy/types.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";
import {EditTool} from "../src/tools/builtin/EditTool.js";
import {ReadTool} from "../src/tools/builtin/ReadTool.js";
import {WriteTool} from "../src/tools/builtin/WriteTool.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

test("cached builtin file tools preserve invoking child paths and recheck authorization", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pilot-builtin-paths-"));
    const evaluations: Array<{agent: string; path: string; accessType: PolicyAccessType}> = [];
    let denied = false;
    const runtime = {
        policyRuntime: {
            async once(agent: string, evaluatedPath: string, accessType: PolicyAccessType) {
                evaluations.push({agent, path: evaluatedPath, accessType});
                return PolicyResult.of({
                    evaluatedUri: evaluatedPath,
                    evaluatedAccessType: accessType,
                    matchedPattern: evaluatedPath,
                    matchedLifetime: PolicyLifetime.ONCE,
                    matchedStatus: denied ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                    matchedReason: "test",
                    resolutionSource: PolicyResolutionSource.SYSTEM,
                });
            },
        },
    } as PilotSessionRuntimeInterface;
    const pi = {} as ExtensionAPI;
    const rows = new ToolDisplayRows();
    const definitions = [
        new ReadTool(pi, () => runtime, rows).toolDefinition(),
        new WriteTool(pi, () => runtime, rows).toolDefinition(),
        new EditTool(pi, () => runtime, rows).toolDefinition(),
    ];
    const contexts = [cwd, path.join(cwd, "second-child")].map((directory, index) => ({
        cwd: directory,
        sessionManager: {getSessionId: () => `child-session-${index}`},
    } as ExtensionContext));

    try {
        for (const ctx of contexts) {
            mkdirSync(ctx.cwd, {recursive: true});
            writeFileSync(path.join(ctx.cwd, "target.txt"), "old value", "utf8");
            const read = await invoke(definitions[0]!, {path: "@target.txt"}, ctx);
            assert.equal(textResult(read), "old value");

            await invoke(definitions[1]!, {path: "@created.txt", content: "created"}, ctx);
            assert.equal(readFileSync(path.join(ctx.cwd, "created.txt"), "utf8"), "created");

            await invoke(definitions[2]!, {
                path: "@target.txt",
                edits: [{oldText: "old value", newText: "new value"}],
            }, ctx);
            assert.equal(readFileSync(path.join(ctx.cwd, "target.txt"), "utf8"), "new value");
        }

        assert.deepEqual(evaluations, contexts.flatMap((ctx) => [
            {agent: ctx.sessionManager.getSessionId(), path: path.join(ctx.cwd, "target.txt"), accessType: PolicyAccessType.FS_READ},
            {agent: ctx.sessionManager.getSessionId(), path: path.join(ctx.cwd, "created.txt"), accessType: PolicyAccessType.FS_WRITE},
            {agent: ctx.sessionManager.getSessionId(), path: path.join(ctx.cwd, "target.txt"), accessType: PolicyAccessType.FS_WRITE},
        ]));

        denied = true;
        const ctx = contexts[1]!;
        await assert.rejects(invoke(definitions[0]!, {path: "@target.txt"}, ctx), /ACCESS DENIED/);
        await assert.rejects(invoke(definitions[1]!, {path: "@created.txt", content: "denied write"}, ctx), /ACCESS DENIED/);
        await assert.rejects(invoke(definitions[2]!, {
            path: "@target.txt",
            edits: [{oldText: "new value", newText: "denied edit"}],
        }, ctx), /ACCESS DENIED/);
        assert.deepEqual(evaluations.slice(6), [
            {agent: ctx.sessionManager.getSessionId(), path: path.join(ctx.cwd, "target.txt"), accessType: PolicyAccessType.FS_READ},
            {agent: ctx.sessionManager.getSessionId(), path: path.join(ctx.cwd, "created.txt"), accessType: PolicyAccessType.FS_WRITE},
            {agent: ctx.sessionManager.getSessionId(), path: path.join(ctx.cwd, "target.txt"), accessType: PolicyAccessType.FS_WRITE},
        ]);
        for (const context of contexts) {
            assert.equal(readFileSync(path.join(context.cwd, "created.txt"), "utf8"), "created");
            assert.equal(readFileSync(path.join(context.cwd, "target.txt"), "utf8"), "new value");
        }
    } finally {
        rmSync(cwd, {recursive: true, force: true});
    }
});

function invoke(
    definition: ToolDefinition<any, any>,
    params: unknown,
    ctx: ExtensionContext,
): Promise<unknown> {
    return definition.execute("test-call", params, undefined, undefined, ctx);
}

function textResult(result: unknown): string {
    if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
    return result.content
        .filter((part): part is {type: "text"; text: string} => (
            typeof part === "object"
            && part !== null
            && "type" in part
            && part.type === "text"
            && "text" in part
            && typeof part.text === "string"
        ))
        .map((part) => part.text)
        .join("\n");
}
