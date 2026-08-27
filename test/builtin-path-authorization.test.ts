import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
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

test("builtin file tools authorize the same child-CWD paths they operate on", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pilot-builtin-paths-"));
    const evaluations: Array<{agent: string; path: string; accessType: PolicyAccessType}> = [];
    const runtime = {
        policyRuntime: {
            async once(agent: string, evaluatedPath: string, accessType: PolicyAccessType) {
                evaluations.push({agent, path: evaluatedPath, accessType});
                return PolicyResult.of({
                    evaluatedUri: evaluatedPath,
                    evaluatedAccessType: accessType,
                    matchedPattern: evaluatedPath,
                    matchedLifetime: PolicyLifetime.ONCE,
                    matchedStatus: PolicyResponse.ALLOWED,
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
    const ctx = {
        cwd,
        sessionManager: {getSessionId: () => "child-session"},
    } as ExtensionContext;

    try {
        writeFileSync(path.join(cwd, "target.txt"), "old value", "utf8");
        const read = await invoke(definitions[0]!, {path: "@target.txt"}, ctx);
        assert.equal(textResult(read), "old value");

        await invoke(definitions[1]!, {path: "@created.txt", content: "created"}, ctx);
        assert.equal(readFileSync(path.join(cwd, "created.txt"), "utf8"), "created");

        await invoke(definitions[2]!, {
            path: "@target.txt",
            edits: [{oldText: "old value", newText: "new value"}],
        }, ctx);
        assert.equal(readFileSync(path.join(cwd, "target.txt"), "utf8"), "new value");

        assert.deepEqual(evaluations, [
            {agent: "child-session", path: path.join(cwd, "target.txt"), accessType: PolicyAccessType.FS_READ},
            {agent: "child-session", path: path.join(cwd, "created.txt"), accessType: PolicyAccessType.FS_WRITE},
            {agent: "child-session", path: path.join(cwd, "target.txt"), accessType: PolicyAccessType.FS_WRITE},
        ]);
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
