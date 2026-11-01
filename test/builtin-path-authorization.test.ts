import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {pathToFileURL} from "node:url";
import {createReadToolDefinition, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition} from "@earendil-works/pi-coding-agent";
import {
    PolicyAccessType,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
} from "../src/policy/types.js";
import type {PolicyToolCallContext} from "../src/policy/AgentPolicyDecisionFlow.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";
import {EditTool} from "../src/tools/builtin/EditTool.js";
import {ReadTool} from "../src/tools/builtin/ReadTool.js";
import {WriteTool} from "../src/tools/builtin/WriteTool.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";

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
    const contexts = [cwd, path.join(cwd, "second-child")].map((directory, index) => {
        const context = {
            cwd: directory,
            sessionManager: {getSessionId: () => `child-session-${index}`},
        } as ExtensionContext;
        return {
            ...context,
            tools: [],
            async executeTool() { throw new Error("Unexpected nested tool execution"); },
        } satisfies ExtensionToolContext;
    });

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

const READ_FALLBACK_VARIANTS = [
    {name: "AM/PM whitespace", requested: "Screenshot 10.00 PM.txt", actual: "Screenshot 10.00\u202FPM.txt"},
    {name: "NFD", requested: "Caf\u00e9.txt", actual: "Cafe\u0301.txt"},
    {name: "curly apostrophe", requested: "person's.txt", actual: "person\u2019s.txt"},
    {name: "NFD and curly apostrophe", requested: "Caf\u00e9 d'\u00e9cran.txt", actual: "Cafe\u0301 d\u2019e\u0301cran.txt"},
];

test("read authorizes the exact native fallback target, including explicit denials", async (t) => {
    for (const variant of READ_FALLBACK_VARIANTS) {
        await t.test(variant.name, async (t) => {
            const fixture = new ReadAuthorizationFixture(t);
            const actual = path.join(fixture.cwd, variant.actual);
            writeFileSync(actual, "fixture fallback contents");
            const params = {path: `@${variant.requested}`};
            const native = await createReadToolDefinition(fixture.cwd).execute("native", params, undefined, undefined, fixture.context());
            assert.equal(textResult(native), "fixture fallback contents", "the native fallback must exist");

            // The requested spelling is allowed; only the actual fallback target is denied.
            fixture.deniedPaths.add(actual);
            await assert.rejects(invoke(fixture.read, params, fixture.context()), /ACCESS DENIED/);
            assert.deepEqual(fixture.evaluations.map((call) => call.path), [actual]);

            fixture.deniedPaths.clear();
            const allowed = await invoke(fixture.read, params, fixture.context());
            assert.deepEqual(allowed, native, "authorization must not disable fallback or change the native output");
            assert.deepEqual(fixture.evaluations.map((call) => call.path), [actual, actual]);
        });
    }
});

test("cached read fallback operations retain each concurrent invoking cwd, principal and call context", async (t) => {
    const fixture = new ReadAuthorizationFixture(t);
    const variant = READ_FALLBACK_VARIANTS[0]!;
    const controller = new AbortController();
    const contexts = ["first", "second"].map((name) => {
        const cwd = path.join(fixture.cwd, name);
        mkdirSync(cwd);
        writeFileSync(path.join(cwd, variant.actual), name);
        return fixture.context(cwd, `session-${name}`);
    });
    const results = await Promise.all(contexts.map((ctx, index) => fixture.read.execute(
        `call-${index}`, {path: `@${variant.requested}`}, controller.signal, undefined, ctx,
    )));
    assert.deepEqual(results.map(textResult), ["first", "second"]);
    assert.deepEqual(fixture.evaluations.sort((a, b) => a.agent.localeCompare(b.agent)), contexts.map((ctx, index) => ({
        agent: ctx.sessionManager.getSessionId(),
        path: path.join(ctx.cwd, variant.actual),
        accessType: PolicyAccessType.FS_READ,
        signal: controller.signal,
        toolCall: {
            toolCallId: `call-${index}`,
            toolName: "read",
            command: `read ${path.join(ctx.cwd, variant.actual)}`,
            purpose: "Read file contents",
        },
    })));
});

test("read preserves file URL fallback and native image structured output", async (t) => {
    const fixture = new ReadAuthorizationFixture(t);
    const actual = path.join(fixture.cwd, "person\u2019s.png");
    writeFileSync(actual, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
    const params = {path: pathToFileURL(path.join(fixture.cwd, "person's.png")).href};
    fixture.deniedPaths.add(actual);
    await assert.rejects(invoke(fixture.read, params, fixture.context()), /ACCESS DENIED/);
    fixture.deniedPaths.clear();
    const allowed = await invoke(fixture.read, params, fixture.context());
    const native = await createReadToolDefinition(fixture.cwd).execute("native-image", params, undefined, undefined, fixture.context());
    assert.ok(native.content.some((block) => block.type === "image"));
    assert.deepEqual(allowed, native);
    assert.deepEqual(fixture.evaluations.map((call) => call.path), [actual, actual]);
});

test("read prefers an existing exact spelling and preserves ordinary nonexistent path errors", async (t) => {
    const fixture = new ReadAuthorizationFixture(t);
    const variant = READ_FALLBACK_VARIANTS[2]!;
    const exact = path.join(fixture.cwd, variant.requested);
    const fallback = path.join(fixture.cwd, variant.actual);
    writeFileSync(exact, "exact spelling");
    writeFileSync(fallback, "fallback spelling");
    fixture.deniedPaths.add(fallback);
    assert.equal(textResult(await invoke(fixture.read, {path: variant.requested}, fixture.context())), "exact spelling");
    const missing = path.join(fixture.cwd, "nonexistent.txt");
    await assert.rejects(invoke(fixture.read, {path: "nonexistent.txt"}, fixture.context()), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && "path" in error);
        assert.equal(error.code, "ENOENT");
        assert.equal(error.path, missing);
        return true;
    });
    fixture.deniedPaths.add(missing);
    await assert.rejects(invoke(fixture.read, {path: "nonexistent.txt"}, fixture.context()), /ACCESS DENIED/);
    assert.deepEqual(fixture.evaluations.map((call) => call.path), [exact, missing, missing]);
});

test("read cancellation settles while fallback authorization is pending", {timeout: 5000}, async (t) => {
    const fixture = new ReadAuthorizationFixture(t);
    const variant = READ_FALLBACK_VARIANTS[0]!;
    const actual = path.join(fixture.cwd, variant.actual);
    writeFileSync(actual, "fixture contents");
    const controller = new AbortController();
    let entered!: () => void;
    const authorizing = new Promise<void>((resolve) => {entered = resolve;});
    let release!: () => void;
    const approval = new Promise<void>((resolve) => {release = resolve;});
    const authorize = fixture.policyRuntime.once.bind(fixture.policyRuntime);
    t.mock.method(fixture.policyRuntime, "once", async (...args: Parameters<PolicyRuntime["once"]>) => {
        const result = await authorize(...args);
        entered();
        await approval;
        return result;
    });
    const pending = fixture.read.execute("cancelled-read", {path: variant.requested}, controller.signal, undefined, fixture.context());
    const rejected = assert.rejects(pending, /aborted/i);
    try {
        await authorizing;
        controller.abort();
        await rejected;
        assert.equal(fixture.evaluations[0]?.path, actual);
        assert.equal(fixture.evaluations[0]?.signal, controller.signal);
    } finally {
        release();
        // Let Pi's operation continuation observe cancellation before removing the fixtures.
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
});

class ReadAuthorizationFixture {
    readonly cwd = mkdtempSync(path.join(os.tmpdir(), "pilot-read-authorization-"));
    readonly deniedPaths = new Set<string>();
    readonly evaluations: Array<{
        agent: string;
        path: string;
        accessType: PolicyAccessType;
        signal: AbortSignal | undefined;
        toolCall: PolicyToolCallContext;
    }> = [];
    readonly policyRuntime: PolicyRuntime;
    readonly read: ReturnType<ReadTool["toolDefinition"]>;

    constructor(t: TestContext) {
        t.after(() => rmSync(this.cwd, {recursive: true, force: true}));
        this.policyRuntime = new PolicyRuntime("read-fixture", {
            initializeSchema() {},
            loadPolicies: () => [],
            upsertPolicies() {throw new Error("Unexpected policy persistence");},
            deletePolicy() {throw new Error("Unexpected policy deletion");},
        }, {
            async resolveQueuedPolicy() {throw new Error("Unexpected policy approval");},
        });
        t.after(() => this.policyRuntime.beginShutdown());
        t.mock.method(this.policyRuntime, "once", async (
            agent: string, evaluatedPath: string, accessType: PolicyAccessType,
            signal: AbortSignal | undefined, toolCall: PolicyToolCallContext = {},
        ) => {
            this.evaluations.push({agent, path: evaluatedPath, accessType, signal, toolCall});
            return PolicyResult.of({
                evaluatedUri: evaluatedPath,
                evaluatedAccessType: accessType,
                matchedPattern: evaluatedPath,
                matchedLifetime: PolicyLifetime.ONCE,
                matchedStatus: this.deniedPaths.has(evaluatedPath) ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                matchedReason: "fixture explicit denial",
                resolutionSource: PolicyResolutionSource.SYSTEM,
            });
        });
        const runtime: PilotSessionRuntimeInterface = {
            policyRuntime: this.policyRuntime,
            decisionFlows: new UiDecisionFlowManager(this.context()),
            fullNetworkInspection: true,
            setFullNetworkInspection() {throw new Error("Unexpected network configuration");},
            beginShutdown: () => this.policyRuntime.beginShutdown(),
            close: () => this.policyRuntime.beginShutdown(),
        };
        this.read = new ReadTool({} as ExtensionAPI, () => runtime, new ToolDisplayRows()).toolDefinition();
    }

    context(cwd = this.cwd, agent = "read-fixture"): ExtensionToolContext {
        return {
            cwd,
            sessionManager: {getSessionId: () => agent},
            tools: [],
            async executeTool() {throw new Error("Unexpected nested tool execution");},
        } as unknown as ExtensionToolContext;
    }
}

function invoke(
    definition: ToolDefinition<any, any>,
    params: unknown,
    ctx: ExtensionToolContext,
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
