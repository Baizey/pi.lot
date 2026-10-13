import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {validateToolArguments, type JsonObject} from "@earendil-works/pi-ai";
import {
    createBashToolDefinition,
    createEditToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    type BashOperations,
    type ExtensionAPI,
    type ExtensionToolContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {PolicyAccessType, PolicyResponse} from "../src/policy/types.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";
import {BashTool} from "../src/tools/builtin/BashTool.js";
import {EditTool} from "../src/tools/builtin/EditTool.js";
import {ReadTool} from "../src/tools/builtin/ReadTool.js";
import {WriteTool} from "../src/tools/builtin/WriteTool.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as Theme;

test("builtin overrides retain upstream descriptions, schemas, prompt metadata and outputs", (t) => {
    const fixture = new BuiltinFixture(t);
    const pairs = [
        [fixture.read, createReadToolDefinition(fixture.cwd)],
        [fixture.write, createWriteToolDefinition(fixture.cwd)],
        [fixture.edit, createEditToolDefinition(fixture.cwd)],
        [fixture.bash.toolDefinition(), createBashToolDefinition(fixture.cwd)],
    ] as const;
    for (const [pilot, upstream] of pairs) {
        for (const key of ["name", "label", "promptSnippet", "promptGuidelines", "outputSchema", "constrainedSampling", "prepareArguments"] as const) {
            assert.deepEqual(pilot[key], upstream[key], `${upstream.name}.${key}`);
        }
        assert.equal(pilot.renderShell, "self");
        assert.notEqual(pilot.renderCall, upstream.renderCall);
        assert.notEqual(pilot.renderResult, upstream.renderResult);
        if (upstream.name === "bash") {
            assert.equal(pilot.description, `${upstream.description} Include a concise, one-line purpose for the command.`);
            const {purpose, ...properties} = pilot.parameters.properties;
            assert.deepEqual(properties, upstream.parameters.properties);
            assert.deepEqual(pilot.parameters.required, [...upstream.parameters.required, "purpose"]);
            assert.equal(purpose.minLength, 1);
            assert.equal(purpose.maxLength, 160);
            assert.equal(purpose.pattern, "^[^\\r\\n]+$");
        } else {
            assert.equal(pilot.description, upstream.description);
            assert.deepEqual(pilot.parameters, upstream.parameters);
        }
    }
    assert.ok(fixture.read.outputSchema, "Pi 1.2 read must advertise its structured output");
});

test("Bash purpose remains required, bounded and single-line at the argument validation boundary", (t) => {
    const definition = new BuiltinFixture(t).bash.toolDefinition();
    const validate = (args: JsonObject) => validateToolArguments(definition, {
        type: "toolCall", id: "purpose-call", name: "bash", arguments: args,
    });
    assert.deepEqual(validate({command: "true", purpose: "Check status", timeout: 2}), {
        command: "true", purpose: "Check status", timeout: 2,
    });
    for (const purpose of [undefined, "", "x".repeat(161), "first\nsecond", "first\rsecond"]) {
        assert.throws(() => validate({command: "true", ...(purpose === undefined ? {} : {purpose})}));
    }
});

test("authorized reads preserve Pi 1.2 text, continuation and image structured outputs", async (t) => {
    const fixture = new BuiltinFixture(t);
    writeFileSync(path.join(fixture.cwd, "text.txt"), Array.from({length: 2101}, (_, i) => `line ${i + 1}`).join("\n"));
    const result = await fixture.read.execute("read-text", {path: "text.txt"}, undefined, undefined, fixture.context());
    assert.equal(result.structuredContent, resultText(result));
    assert.equal(typeof result.structuredContent, "string");
    assert.match(resultText(result), /Use offset=2001 to continue/);
    assert.equal(result.details.truncation.truncatedBy, "lines");
    const slice = await fixture.read.execute("read-slice", {path: "text.txt", offset: 2100, limit: 2}, undefined, undefined, fixture.context());
    assert.equal(slice.structuredContent, "line 2100\nline 2101");

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(path.join(fixture.cwd, "image.png"), png);
    const image = await fixture.read.execute("read-image", {path: "image.png"}, undefined, undefined, fixture.context());
    const block = image.content.find((part) => part.type === "image");
    assert.ok(block);
    assert.deepEqual(image.structuredContent, {
        type: "image", data: block.data, mimeType: block.mimeType, note: resultText(image),
    });
    assert.deepEqual(fixture.authorizations.map((call) => call.access), [
        PolicyAccessType.FS_READ, PolicyAccessType.FS_READ, PolicyAccessType.FS_READ,
    ]);
});

test("denied and aborted file calls cannot read or mutate before authorization", async (t) => {
    const fixture = new BuiltinFixture(t);
    writeFileSync(path.join(fixture.cwd, "target.txt"), "original");
    fixture.denied = true;
    await assert.rejects(fixture.read.execute("denied-read", {path: "nonexistent.txt"}, undefined, undefined, fixture.context()), /fixture denied/);
    await assert.rejects(fixture.write.execute("denied-write", {path: "nested/new.txt", content: "new"}, undefined, undefined, fixture.context()), /fixture denied/);
    await assert.rejects(fixture.edit.execute("denied-edit", {path: "target.txt", edits: [{oldText: "original", newText: "changed"}]}, undefined, undefined, fixture.context()), /fixture denied/);
    assert.equal(existsSync(path.join(fixture.cwd, "nested")), false);
    assert.equal(readFileSync(path.join(fixture.cwd, "target.txt"), "utf8"), "original");

    fixture.denied = false;
    const signal = AbortSignal.abort();
    await assert.rejects(fixture.read.execute("aborted-read", {path: "target.txt"}, signal, undefined, fixture.context()), /aborted/);
    await assert.rejects(fixture.write.execute("aborted-write", {path: "nested/new.txt", content: "new"}, signal, undefined, fixture.context()), /aborted/);
    await assert.rejects(fixture.edit.execute("aborted-edit", {path: "target.txt", edits: [{oldText: "original", newText: "changed"}]}, signal, undefined, fixture.context()), /aborted/);
    assert.equal(existsSync(path.join(fixture.cwd, "nested")), false);
    assert.equal(readFileSync(path.join(fixture.cwd, "target.txt"), "utf8"), "original");
    assert.ok(fixture.authorizations.slice(3).every((call) => call.signal === signal));
});

test("write keeps upstream success details and creates parent directories after approval", async (t) => {
    const fixture = new BuiltinFixture(t);
    const result = await fixture.write.execute("write", {path: "nested/new.txt", content: "created"}, undefined, undefined, fixture.context());
    assert.equal(readFileSync(path.join(fixture.cwd, "nested/new.txt"), "utf8"), "created");
    assert.deepEqual(result, {content: [{type: "text", text: "Successfully wrote to nested/new.txt"}], details: undefined});
    assert.equal(fixture.authorizations[0]?.path, path.join(fixture.cwd, "nested/new.txt"));
    assert.equal(fixture.authorizations[0]?.access, PolicyAccessType.FS_WRITE);
});

test("edit retains upstream legacy, object and JSON-string argument preparation", (t) => {
    const definition = new BuiltinFixture(t).edit;
    assert.ok(definition.prepareArguments);
    const edit = {oldText: "before", newText: "after"};
    for (const edits of [[edit], edit, JSON.stringify([edit]), JSON.stringify(edit)]) {
        assert.deepEqual(definition.prepareArguments({path: "file", edits}), {path: "file", edits: [edit]});
    }
    assert.deepEqual(definition.prepareArguments({path: "file", ...edit}), {path: "file", edits: [edit]});
    assert.deepEqual(definition.prepareArguments({path: "file", edits: [{oldText: "other", newText: "changed"}], ...edit}), {
        path: "file", edits: [{oldText: "other", newText: "changed"}, edit],
    });
});

test("edit matches disjoint replacements against the original and preserves BOM and CRLF", async (t) => {
    const fixture = new BuiltinFixture(t);
    const target = path.join(fixture.cwd, "target.txt");
    writeFileSync(target, "\uFEFFfirst\r\nmiddle\r\nlast\r\n");
    const result = await fixture.edit.execute("edit", {
        path: "target.txt", edits: [{oldText: "first", newText: "last"}, {oldText: "last", newText: "first"}],
    }, undefined, undefined, fixture.context());
    assert.equal(readFileSync(target, "utf8"), "\uFEFFlast\r\nmiddle\r\nfirst\r\n");
    assert.equal(resultText(result), "Successfully replaced 2 block(s) in target.txt.");
    assert.equal(result.details.firstChangedLine, 1);
    assert.match(result.details.diff, /-1 first/);
    assert.match(result.details.diff, /\+3 first/);
    assert.match(result.details.patch, /--- target.txt\n\+\+\+ target.txt\n/);
});

test("edit validation errors leave the whole original file unchanged", async (t) => {
    const fixture = new BuiltinFixture(t);
    const target = path.join(fixture.cwd, "target.txt");
    const original = "alpha\nbeta\nalpha\nunique end\n";
    const cases = [
        {edits: [], error: /at least one replacement/},
        {edits: [{oldText: "", newText: "added"}], error: /must not be empty/},
        {edits: [{oldText: "alpha", newText: "changed"}], error: /2 occurrences/},
        {edits: [{oldText: "unique end", newText: "changed"}, {oldText: "end", newText: "tail"}], error: /overlap/},
        {edits: [{oldText: "unique end", newText: "created"}, {oldText: "created", newText: "later"}], error: /Could not find edits\[1\]/},
        {edits: [{oldText: "unique end", newText: "unique end"}], error: /No changes made/},
    ];
    for (const {edits, error} of cases) {
        writeFileSync(target, original);
        await assert.rejects(fixture.edit.execute("edit-invalid", {path: "target.txt", edits}, undefined, undefined, fixture.context()), error);
        assert.equal(readFileSync(target, "utf8"), original);
    }
});

test("concurrent edits retain upstream file mutation serialization", async (t) => {
    const fixture = new BuiltinFixture(t);
    const target = path.join(fixture.cwd, "target.txt");
    writeFileSync(target, "original");
    const results = await Promise.allSettled(["first", "second"].map((replacement) => fixture.edit.execute(
        `edit-${replacement}`,
        {path: "target.txt", edits: [{oldText: "original", newText: replacement}]},
        undefined, undefined, fixture.context(),
    )));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.match(rejected.reason.message, /Could not find the exact text/);
    assert.ok(["first", "second"].includes(readFileSync(target, "utf8")));
    assert.equal(fixture.authorizations.length, 2, "each concurrent call must be authorized independently");
});

test("edit keeps upstream fuzzy matching without normalizing untouched lines", async (t) => {
    const fixture = new BuiltinFixture(t);
    const target = path.join(fixture.cwd, "target.txt");
    writeFileSync(target, "untouched “quote”   \nchange “this”\nexact end\n");
    await fixture.edit.execute("edit-fuzzy", {
        path: "target.txt", edits: [{oldText: 'change "this"', newText: "changed"}, {oldText: "exact end", newText: "new end"}],
    }, undefined, undefined, fixture.context());
    assert.equal(readFileSync(target, "utf8"), "untouched “quote”   \nchanged\nnew end\n");
});

test("edit renders supplied previews and approved diff details without a policy or file read", (t) => {
    const fixture = new BuiltinFixture(t);
    const args = {path: "unreadable.txt", edits: [{oldText: "secret old text", newText: "requested new text"}]};
    const context = {
        args, toolCallId: "render-only", invalidate() {}, lastComponent: undefined,
        state: {pilotFullDisplay: true}, cwd: fixture.cwd, executionStarted: false,
        argsComplete: false, isPartial: true, expanded: false, showImages: false,
        isError: false, durationMs: undefined, outputPad: 2,
    } satisfies Parameters<NonNullable<typeof fixture.edit.renderCall>>[2];
    assert.ok(fixture.edit.renderCall);
    const call = fixture.edit.renderCall(args, plainTheme, context).render(120).join("\n");
    fixture.edit.renderCall(args, plainTheme, {...context, isPartial: false});
    assert.match(call, /Requested replacement 1 \(preview\)/);
    assert.match(call, /\+requested new text/);
    assert.doesNotMatch(call, /secret old text/);
    assert.equal(fixture.authorizations.length, 0);
    assert.ok(fixture.edit.renderResult);
    const result = {content: [{type: "text" as const, text: "Successfully replaced"}], details: {diff: "-1 before\n+1 after", patch: "patch", firstChangedLine: 1}};
    const rendered = fixture.edit.renderResult(result, {expanded: false, isPartial: false}, plainTheme, {...context, isPartial: false, durationMs: 25}).render(120).join("\n");
    assert.match(rendered, /  -1 before\n  \+1 after/);
    assert.doesNotMatch(rendered, /Successfully replaced/);
    assert.equal(fixture.authorizations.length, 0);
});

test("sandboxed Bash forwards each invoking context, streams and retains structured failure results", async (t) => {
    const fixture = new BuiltinFixture(t);
    let calls = 0;
    fixture.mockBashOperations(t, {
        async exec(command, cwd, {onData, signal, timeout, env}) {
            calls++;
            assert.equal(command, "fixture command");
            assert.equal(cwd, path.join(fixture.cwd, `child-${calls}`));
            assert.equal(signal, controller.signal);
            assert.equal(timeout, 3);
            assert.equal(env?.PI_SESSION_ID, `session-${calls}`);
            assert.equal(env?.PI_SESSION_FILE, path.join(cwd, "session.jsonl"));
            assert.equal(env?.PI_PROVIDER, `provider-${calls}`);
            assert.equal(env?.PI_MODEL, `model-${calls}`);
            assert.equal(env?.PI_REASONING_LEVEL, "high");
            onData(Buffer.from("combined output\n"));
            return {exitCode: calls === 1 ? 0 : 7};
        },
    });
    const controller = new AbortController();
    const definition = fixture.bash.toolDefinition();
    for (const index of [1, 2]) {
        const ctx = fixture.context(path.join(fixture.cwd, `child-${index}`), `session-${index}`);
        ctx.model = {provider: `provider-${index}`, id: `model-${index}`} as NonNullable<ExtensionToolContext["model"]>;
        ctx.thinkingLevel = "high";
        const updates: unknown[] = [];
        const result = await definition.execute(`bash-${index}`, {command: "fixture command", purpose: "Exercise sandbox", timeout: 3}, controller.signal, (update: unknown) => updates.push(update), ctx);
        const structured = structuredObject(result.structuredContent);
        assert.equal(structured.output, "combined output\n");
        assert.equal(structured.exit_code, index === 1 ? 0 : 7);
        assert.equal(structured.truncated, false);
        assert.equal(typeof structured.wall_time_seconds, "number");
        assert.equal(result.isError, index === 1 ? undefined : true);
        assert.ok(updates.length >= 2);
    }
    assert.equal(fixture.nativeClosed, 2);
    assert.deepEqual(fixture.nativeCalls, [
        {agent: "session-1", toolCallId: "bash-1", toolName: "bash", command: "fixture command", purpose: "Exercise sandbox"},
        {agent: "session-2", toolCallId: "bash-2", toolName: "bash", command: "fixture command", purpose: "Exercise sandbox"},
    ]);
});

test("sandboxed Bash retains full structured output when only model-facing text is truncated", async (t) => {
    const fixture = new BuiltinFixture(t);
    const output = Array.from({length: 2200}, (_, i) => `output ${i}`).join("\n");
    fixture.mockBashOperations(t, {async exec(_command, _cwd, {onData}) {
        onData(Buffer.from(output));
        return {exitCode: 0};
    }});
    const result = await fixture.bash.toolDefinition().execute("bash-large", {command: "fixture", purpose: "Test truncation"}, undefined, undefined, fixture.context());
    const structured = structuredObject(result.structuredContent);
    assert.equal(structured.output, output);
    assert.equal(structured.truncated, false);
    assert.equal(structured.full_output_path, undefined);
    assert.equal(result.details.truncation.truncated, true);
    t.after(() => rmSync(result.details.fullOutputPath, {force: true}));
    assert.equal(readFileSync(result.details.fullOutputPath, "utf8"), output);
    assert.match(resultText(result), /Full output:/);
    assert.equal(fixture.nativeClosed, 1);
});

test("sandboxed Bash exposes the full-output path when structured output exceeds Pi's 1MiB cap", async (t) => {
    const fixture = new BuiltinFixture(t);
    const output = "x".repeat(1024 * 1024 + 100);
    fixture.mockBashOperations(t, {async exec(_command, _cwd, {onData}) {
        onData(Buffer.from(output));
        return {exitCode: 0};
    }});
    const result = await fixture.bash.toolDefinition().execute("bash-capped", {command: "fixture", purpose: "Test structured cap"}, undefined, undefined, fixture.context());
    t.after(() => rmSync(result.details.fullOutputPath, {force: true}));
    const structured = structuredObject(result.structuredContent);
    assert.equal(structured.truncated, true);
    assert.equal(typeof structured.output, "string");
    const preview = String(structured.output);
    assert.match(preview, /\n\n\[\.\.\. 100 bytes omitted \.\.\.\]\n\n/);
    assert.equal(Buffer.byteLength(preview.replace(/\n\n\[\.\.\. 100 bytes omitted \.\.\.\]\n\n/, "")), 1024 * 1024);
    assert.equal(structured.full_output_path, result.details.fullOutputPath);
    assert.equal(readFileSync(result.details.fullOutputPath, "utf8"), output);
});

test("sandboxed Bash closes its native policy view if backend setup throws", async (t) => {
    const fixture = new BuiltinFixture(t);
    const owner = fixture.bash as unknown as {createOperations(): BashOperations};
    t.mock.method(owner, "createOperations", () => {throw new Error("setup failure");});
    await assert.rejects(fixture.bash.toolDefinition().execute("bash-setup", {command: "fixture", purpose: "Test setup failure"}, undefined, undefined, fixture.context()), /setup failure/);
    assert.equal(fixture.nativeClosed, 1);
});

test("sandboxed Bash closes its native policy view when execution fails or aborts", async (t) => {
    const fixture = new BuiltinFixture(t);
    fixture.mockBashOperations(t, {async exec(_command, _cwd, {signal}) {
        throw new Error(signal?.aborted ? "aborted" : "backend failure");
    }});
    const definition = fixture.bash.toolDefinition();
    await assert.rejects(definition.execute("bash-error", {command: "fixture", purpose: "Test errors"}, undefined, undefined, fixture.context()), /backend failure/);
    await assert.rejects(definition.execute("bash-abort", {command: "fixture", purpose: "Test abort"}, AbortSignal.abort(), undefined, fixture.context()), /Command aborted/);
    assert.equal(fixture.nativeClosed, 2);
});

function resultText(result: {content: readonly {type: string; text?: string}[]}): string {
    return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function structuredObject(value: unknown): Record<string, unknown> {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
}

class BuiltinFixture {
    readonly cwd = mkdtempSync(path.join(os.tmpdir(), "pilot-builtin-compat-"));
    readonly authorizations: Array<{path: string; access: PolicyAccessType; signal: AbortSignal | undefined}> = [];
    readonly nativeCalls: Array<{agent: string; toolCallId: string; toolName: string; command: string; purpose: string}> = [];
    denied = false;
    nativeClosed = 0;
    readonly read: ReturnType<ReadTool["toolDefinition"]>;
    readonly write: ReturnType<WriteTool["toolDefinition"]>;
    readonly edit: ReturnType<EditTool["toolDefinition"]>;
    readonly bash: BashTool;

    constructor(t: TestContext) {
        t.after(() => rmSync(this.cwd, {recursive: true, force: true}));
        const runtime = {
            policyRuntime: {
                once: async (_agent: string, evaluatedPath: string, access: PolicyAccessType, signal: AbortSignal | undefined) => {
                    this.authorizations.push({path: evaluatedPath, access, signal});
                    return {matchedStatus: this.denied ? PolicyResponse.DENIED : PolicyResponse.ALLOWED, toDenyMessage: () => "fixture denied"};
                },
                beginNativeFilesystemToolCall: (agent: string, toolCall: {toolCallId: string; toolName: string; command: string; purpose: string}) => {
                    this.nativeCalls.push({agent, ...toolCall});
                    return {close: () => this.nativeClosed++, evaluate: async () => {throw new Error("Unexpected native evaluation");}};
                },
            },
        } as unknown as PilotSessionRuntimeInterface;
        const pi = {} as ExtensionAPI;
        const rows = new ToolDisplayRows();
        this.read = new ReadTool(pi, () => runtime, rows).toolDefinition();
        this.write = new WriteTool(pi, () => runtime, rows).toolDefinition();
        this.edit = new EditTool(pi, () => runtime, rows).toolDefinition();
        this.bash = new BashTool(pi, () => runtime, rows);
    }

    context(cwd = this.cwd, sessionId = "fixture-session"): ExtensionToolContext {
        return {
            cwd,
            sessionManager: {getSessionId: () => sessionId, getSessionFile: () => path.join(cwd, "session.jsonl")},
            tools: [],
            async executeTool() {throw new Error("Unexpected nested execution");},
        } as unknown as ExtensionToolContext;
    }

    mockBashOperations(t: TestContext, operations: BashOperations): void {
        // Replace only the sandbox backend: Pi's real definition still owns context,
        // output accumulation, streaming, truncation and structured failure results.
        const owner = this.bash as unknown as {createOperations(): BashOperations};
        t.mock.method(owner, "createOperations", () => operations);
    }
}
