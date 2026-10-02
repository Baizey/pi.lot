import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    initTheme,
    SessionManager,
    SettingsManager,
    ToolExecutionComponent,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type Theme,
    type ToolDefinition,
    type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import {validateToolArguments, type JsonObject} from "@earendil-works/pi-ai";
import {getCapabilities, setCapabilities} from "@earendil-works/pi-tui";
import {CodemodeExtension} from "../src/tools/codemode/CodemodeExtension.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {displayWidth} from "../src/tui/terminalText.js";

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

test("codemode requires a purpose while keeping native exposure, defaults, and live loadout settings", () => {
    const rows = new ToolDisplayRows();
    const {pi, tool, settings} = harness(rows);
    let native!: ToolDefinition;
    createCodemodeExtension()({...pi, registerTool: (definition) => { native = definition as ToolDefinition; }});
    type Schema = ToolDefinition["parameters"] & {properties: Record<string, unknown>; required: string[]};
    const parameters = tool.parameters as Schema;
    const nativeParameters = native.parameters as Schema;
    assert.notEqual(parameters, nativeParameters);
    assert.equal(parameters.properties.code, nativeParameters.properties.code);
    assert.deepEqual(nativeParameters.required, ["code"], "the shared native schema must not be mutated");
    assert.ok(parameters.required.includes("purpose"));
    assert.equal(CodemodeExtension.nativeMcpTools([tool])[0]!.parameters, native.parameters);
    const unrelated = {...tool, parameters: {...tool.parameters}};
    assert.equal(CodemodeExtension.nativeMcpTools([unrelated])[0], unrelated);
    assert.deepEqual(parameters.properties.purpose, {
        type: "string",
        description: "A short, one-line explanation of what the script will achieve",
        minLength: 1,
        maxLength: 160,
        pattern: "^[^\\r\\n]+$",
    });
    assert.equal(tool.exposure, "model-only");
    assert.equal(tool.defaultActive, false);
    assert.equal(tool.renderShell, "self");
    assert.deepEqual(tool.constrainedSampling, {type: "json_schema", strict: "prefer"});
    for (const guideline of native.promptGuidelines ?? []) assert.ok(tool.promptGuidelines?.includes(guideline));
    assert.ok(tool.promptGuidelines?.some((guideline) => guideline.includes("JSON object")
        && guideline.includes("purpose") && guideline.includes("code")
        && guideline.includes("raw-input convention does not apply")));
    assertPurposeDescription(tool.description, native.description);
    assert.equal(tool.promptSnippet, native.promptSnippet);

    const callable: ToolLoadout["callable"] = [{
        name: "read", label: "read", description: "Read fixture",
        parameters: tool.parameters,
        async execute() { return {content: [], details: undefined}; },
    }];
    const loadout: ToolLoadout = {
        declared: callable, callable, registered: callable,
        getExposure: () => "direct",
        getNamespace: () => undefined,
    };
    for (const mode of ["on", "only"] as const) {
        settings.codemode.mode = mode;
        for (const inlineBudget of [0, 3000]) {
            settings.codemode.inlineBudget = inlineBudget;
            const prepared = tool.prepareLoadout!(loadout)!;
            const nativePrepared = native.prepareLoadout!(loadout)!;
            assert.deepEqual(prepared.hiddenDeclarations, nativePrepared.hiddenDeclarations);
            assert.equal(prepared.descriptions?.read, nativePrepared.descriptions?.read);
            assertPurposeDescription(prepared.descriptions!.codemode!, nativePrepared.descriptions!.codemode!);
            assert.deepEqual(prepared.hiddenDeclarations, mode === "only" ? ["read"] : []);
        }
    }
});

test("codemode validates purpose before script execution", () => {
    const {tool} = harness(new ToolDisplayRows());
    const validate = (args: JsonObject) => validateToolArguments(tool, {
        type: "toolCall", id: "script", name: "codemode", arguments: args,
    });
    assert.deepEqual(validate({purpose: "Read the fixture", code: "return 1;"}), {
        purpose: "Read the fixture", code: "return 1;",
    });
    assert.throws(() => validate({code: "return 1;"}), /purpose/);
    for (const purpose of ["", "first\nsecond", "first\rsecond", "x".repeat(161)]) {
        assert.throws(() => validate({purpose, code: "return 1;"}), /purpose/);
    }
});

test("codemode uses compact, expanded, and row-local full views with bounded copy-safe output", (t) => {
    initTheme("dark");
    const rows = new ToolDisplayRows();
    t.after(() => rows.clear());
    const {tool} = harness(rows);
    const script = Array.from({length: 12}, (_, index) => `console.log("line ${index + 1} 界🙂");`);
    const output = Array.from({length: 12}, (_, index) => `output ${index + 1} 界🙂`);
    const calls: CodemodeToolDetails["calls"] = Array.from({length: 12}, (_, index) => ({
        id: `script/${index + 1}`, name: `tool_${index + 1}`,
        args: '{"path":"fixture"}', status: "ok", durationMs: 12,
    }));
    const component = new ToolExecutionComponent(
        "codemode", "script", {purpose: "Inspect fixture tools", code: script.join("\n")}, {}, tool,
        {requestRender() {}} as ConstructorParameters<typeof ToolExecutionComponent>[5], process.cwd(),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({
        content: [{type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n"},
            {type: "text", text: output.join("\n")}],
        details: {calls, fullOutputPath: "/tmp/full-codemode.txt"},
        isError: false,
    });
    const minimal = component.render(120).map(stripAnsi).filter(Boolean);
    assert.equal(minimal[0], "  codemode | Inspect fixture tools");
    assert.ok(minimal.some((line) => line.includes("✓ tool_12")));
    assert.equal(minimal.some((line) => line.includes("✓ tool_1 ")), false);
    assert.ok(minimal.some((line) => line.includes("earlier lines")));
    assert.equal(minimal.some((line) => line.includes("console.log") || line.includes("output ")), false);
    assert.equal(minimal.some((line) => line.includes("Full output:")), false);
    assert.ok(minimal.length <= 10);
    for (const width of [1, 8, 20, 80]) {
        assert.ok(component.render(width).every((line) => displayWidth(line) <= width));
    }
    assert.equal(rows.list()[0]!.toolName, "codemode");

    component.setExpanded(true);
    const expanded = component.render(120).map(stripAnsi);
    assert.ok(expanded.includes(script[0]!));
    assert.equal(expanded.includes(script.at(-1)!), false);
    assert.ok(expanded.includes(output.at(-1)!));
    assert.equal(expanded.includes(output[0]!), false);
    assert.ok(expanded.some((line) => line.includes("✓ tool_12")));
    assert.equal(expanded.some((line) => line.includes("✓ tool_1 ")), false);
    assert.ok(expanded.includes("Full output: /tmp/full-codemode.txt"));
    assert.equal(expanded.some((line) => line.includes("Script completed") || line.includes("Wall time")), false);

    rows.toggle("script");
    component.setExpanded(false);
    const full = component.render(120).map(stripAnsi);
    for (const line of [...script, ...output]) assert.ok(full.includes(line));
    for (const call of calls) assert.ok(full.some((line) => line.includes(`✓ ${call.name} `)));
    assert.ok(full.every((line) => !/[ \t]+$/.test(line)));
    for (const width of [1, 8, 20, 80]) {
        assert.ok(component.render(width).every((line) => displayWidth(line) <= width));
    }
});

test("codemode streams nested statuses and costs, stops its spinner, and retains full errors", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    t.after(() => rows.clear());
    const {tool} = harness(rows);
    const state = {};
    let invalidations = 0;
    const context = renderContext(state, {isPartial: true, invalidate: () => invalidations++});
    const args = {purpose: "Inspect the fixture", code: "await tools.read({path: 'fixture'});"};
    assert.deepEqual(tool.renderCall!(args, plainTheme, context).render(120),
        ["⠋ codemode | Inspect the fixture", "await tools.read({path: 'fixture'});"]);
    assert.deepEqual(tool.renderCall!(args, plainTheme, {...context, expanded: false}).render(120),
        ["⠋ codemode | Inspect the fixture"]);
    t.mock.timers.tick(80);
    assert.equal(invalidations, 1);
    const calls: CodemodeToolDetails["calls"] = [
        {id: "script/?", name: "read", args: '{"path":"fixture"}', status: "running"},
        {id: "script/models.classify/1", name: "models.classify", args: "demo/model", status: "ok", cost: 0.001},
        {id: "script/models.classify/2", name: "models.classify", args: "demo/model", status: "error", cost: 0.002,
            error: "classifier failed\nsecond line", durationMs: 1200},
        {id: "script/2", name: "bash", args: "{}", status: "cancelled"},
    ];
    const result = {content: [{type: "text" as const, text: "must not appear while streaming"}], details: {calls}};
    const partial = tool.renderResult!(result, {expanded: true, isPartial: true}, plainTheme, context).render(160);
    assert.ok(partial.some((line) => line.startsWith("… read ")));
    assert.ok(partial.some((line) => line.includes("✓ models.classify demo/model $0.0010")));
    assert.ok(partial.some((line) => line.includes("✗ models.classify demo/model 1.2s $0.0020")));
    assert.ok(partial.includes("⊘ bash {}"));
    assert.ok(partial.includes("Model calls: $0.0030"));
    assert.equal(partial.includes("must not appear while streaming"), false);
    const minimal = tool.renderResult!(result, {expanded: false, isPartial: true}, plainTheme, context).render(160);
    assert.deepEqual(minimal, partial, "minimal mode still shows nested activity and costs");

    rows.toggle("script");
    const failed = {
        content: [{type: "text" as const, text: "Script failed\nWall time 1.2 seconds\nOutput:\n"},
            {type: "text" as const, text: "Script error:\nnested tool denied"}],
        details: {calls},
    };
    const completeContext = {...context, isPartial: false, isError: true};
    assert.deepEqual(tool.renderCall!({code: "throw new Error('denied');"}, plainTheme, completeContext).render(120),
        ["  codemode", "throw new Error('denied');"]);
    const full = tool.renderResult!(failed, {expanded: false, isPartial: false}, plainTheme, completeContext).render(160);
    assert.ok(full.includes("classifier failed"));
    assert.ok(full.includes("second line"));
    assert.ok(full.includes("nested tool denied"));
    const colorTheme = {
        ...plainTheme,
        fg: (color: string, text: string) => `\x1b[${color === "error" ? 31 : 37}m${text}\x1b[0m`,
    } as Theme;
    const colored = tool.renderResult!(failed, {expanded: false, isPartial: false}, colorTheme, completeContext).render(160);
    assert.ok(colored.find((line) => line.includes("classifier failed"))!.includes("\x1b[31m"));
    assert.ok(colored.find((line) => line.includes("second line"))!.includes("\x1b[31m"));
    const requestsAfterCompletion = invalidations;
    t.mock.timers.tick(800);
    assert.equal(invalidations, requestsAfterCompletion, "completed parent rows must stop requesting redraws");
});

test("codemode export contexts cannot replace live rows or start animations", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const rows = new ToolDisplayRows();
    t.after(() => rows.clear());
    const {tool} = harness(rows);
    const liveState = {};
    let invalidations = 0;
    const live = renderContext(liveState, {isPartial: true, invalidate: () => invalidations++});
    tool.renderCall!({code: "return 1;"}, plainTheme, live);
    t.mock.timers.tick(80);
    assert.equal(invalidations, 1);

    const exportState = {};
    const exported = renderContext(exportState, {
        executionStarted: true, isPartial: true, expanded: false,
        invalidate() { throw new Error("exports must not animate"); },
    });
    assert.deepEqual(tool.renderCall!({code: "return 1;"}, plainTheme, exported).render(120), ["  codemode"]);
    assert.equal(rows.list().length, 1);
    rows.toggle("script");
    assert.equal(invalidations, 2, "the live invalidator still owns this call");
    assert.equal(rows.list()[0]!.full, true);
    assert.equal("pilotFullDisplay" in exportState, false);

    tool.renderResult!({content: [], details: undefined}, {expanded: false, isPartial: false}, plainTheme, exported);
    tool.renderResult!({content: [], details: undefined}, {expanded: false, isPartial: false}, plainTheme, live);
    t.mock.timers.tick(800);
    assert.equal(invalidations, 2, "result completion stops animation without another call render");
});

test("codemode handles missing details, rejected input, images, terminal controls, and display limits", (t) => {
    const rows = new ToolDisplayRows();
    const {tool} = harness(rows);
    const context = renderContext({pilotFullDisplay: true}, {isError: true});
    const result = tool.renderResult!({
        content: [{type: "text", text: "Invalid options\n\u001b]0;unsafe\u0007denied"},
            {type: "image", mimeType: "image/png", data: "not displayed as text"}],
        details: undefined,
    }, {expanded: false, isPartial: false}, plainTheme, context).render(120);
    assert.ok(result.includes("Invalid options"));
    assert.ok(result.includes("denied"));
    assert.ok(result.includes("[image]"));
    const capabilities = getCapabilities();
    t.after(() => setCapabilities(capabilities));
    setCapabilities({...capabilities, images: null});
    const imageResult = {content: [{type: "image" as const, mimeType: "image/png", data: "opaque"}], details: undefined};
    assert.ok(tool.renderResult!(imageResult, {expanded: true, isPartial: false}, plainTheme,
        {...context, showImages: true}).render(120).includes("[image]"));
    setCapabilities({...capabilities, images: "kitty"});
    assert.deepEqual(tool.renderResult!(imageResult, {expanded: true, isPartial: false}, plainTheme,
        {...context, showImages: true}).render(120), []);
    assert.equal(result.some((line) => line.includes("unsafe") || line.includes("not displayed as text")), false);
    assert.deepEqual(tool.renderCall!({}, plainTheme, renderContext({}, {expanded: false})).render(120), ["  codemode"]);

    const script = Array.from({length: 500}, (_, index) => `line ${index}`).join("\n");
    const call = tool.renderCall!({code: script}, plainTheme, context).render(120);
    assert.ok(call.length <= 100);
    assert.ok(call.some((line) => line.includes("omitted from display")));
    const calls: CodemodeToolDetails["calls"] = Array.from({length: 500}, (_, index) => ({
        id: `script/${index}`, name: `tool_${index}`, args: "{}", status: "ok",
    }));
    const bounded = tool.renderResult!({content: [], details: {calls}},
        {expanded: false, isPartial: false}, plainTheme, context).render(120);
    assert.ok(bounded.length <= 101);
    assert.ok(bounded.some((line) => line.includes("✓ tool_499")));
    assert.ok(bounded.some((line) => line.includes("omitted from display")));
});

test("codemode wraps long scripts and output before applying preview limits", () => {
    const rows = new ToolDisplayRows();
    const {tool} = harness(rows);
    const source = `START${"x".repeat(1000)}END`;
    const context = renderContext({});
    const preview = tool.renderCall!({code: source}, plainTheme, context).render(40);
    assert.ok(preview.length <= 10, "header, eight visual script rows, and fold notice");
    assert.ok(preview.some((line) => line.includes("START")));
    assert.equal(preview.some((line) => line.includes("END")), false);
    assert.ok(preview.every((line) => displayWidth(line) <= 40));
    const result = {content: [{type: "text" as const, text: source}], details: {calls: []}};
    const output = tool.renderResult!(result, {expanded: true, isPartial: false}, plainTheme, context).render(40);
    assert.ok(output.length <= 7, "spacer, fold notice, and five visual output rows");
    assert.ok(output.some((line) => line.includes("END")));
    rows.toggle("script");
    const full = tool.renderCall!({code: source}, plainTheme, context).render(40);
    assert.equal(full.slice(1).join(""), source);
});

test("real loader replaces only the duplicate builtin and SDK execution preserves nested routing and store", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-codemode-"));
    const rows = new ToolDisplayRows();
    try {
        for (const suppressed of [false, true]) {
            const settingsManager = SettingsManager.inMemory({
                extensions: suppressed ? ["-builtin:codemode"] : [],
                defaultTools: ["codemode"],
                codemode: {mode: "only", inlineBudget: 0},
            });
            const loader = new DefaultResourceLoader({
                cwd: directory, agentDir: directory, settingsManager,
                noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
                extensionFactories: [
                    {name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true},
                    (pi) => new CodemodeExtension(pi, rows).register(),
                ],
            });
            await loader.reload();
            const loaded = loader.getExtensions();
            assert.deepEqual(loaded.errors, []);
            assert.equal(loaded.extensions.filter((extension) => extension.tools.has("codemode")).length, 1);
            assert.equal((loaded.warnings ?? []).some((warning) => warning.path === "builtin:codemode"), !suppressed);
            const {session} = await createAgentSession({
                cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader,
                sessionManager: SessionManager.inMemory(directory),
                noTools: "builtin",
                customTools: [{
                    name: "echo", label: "echo", description: "Fixture echo", exposure: "codemode",
                    parameters: {type: "object", properties: {}},
                    async execute(_id, _params, _signal, _onUpdate, ctx) {
                        assert.equal(ctx.cwd, directory);
                        return {content: [{type: "text", text: "nested fixture"}], details: undefined};
                    },
                }],
            });
            try {
                await session.bindExtensions({});
                session.setActiveToolsByName(["codemode"]);
                const tool = session.agent.state.tools.find((definition) => definition.name === "codemode");
                assert.ok(tool);
                const nested: string[] = [];
                const unsubscribe = session.subscribe((event) => {
                    if (event.type === "tool_execution_start" && event.parentToolCallId) nested.push(event.toolName);
                });
                try {
                    const run = async (id: string, code: string) => {
                        const args = {purpose: "Exercise nested routing and storage", code};
                        session.agent.state.messages.push({
                            role: "assistant", content: [{type: "toolCall", id, name: "codemode", arguments: args}],
                            api: "openai-completions", provider: "fixture", model: "fixture",
                            usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                                cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
                            stopReason: "toolUse", timestamp: Date.now(),
                        });
                        return tool.execute(id, args, undefined, undefined);
                    };
                    const first = await run("first", 'const value = await tools.echo({}); store("fixture", value); return value;');
                    assert.equal(first.isError, undefined);
                    assert.match(JSON.stringify(first.content), /nested fixture/);
                    assert.deepEqual(nested, ["echo"]);
                    const second = await run("second", 'return load("fixture");');
                    assert.match(JSON.stringify(second.content), /nested fixture/);
                    assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "custom"
                        && entry.customType === "codemode-store"));
                    const globals = await run("globals", 'return {imageGeneration: typeof models.generateImages, missingTool: "missing" in tools};');
                    assert.equal(globals.isError, undefined);
                    assert.match(JSON.stringify(globals.content), /imageGeneration.*function/);
                    assert.match(JSON.stringify(globals.content), /missingTool.*false/);
                    const unknown = await run("unknown", 'return typeof tools.missing;');
                    assert.equal(unknown.isError, true);
                    assert.match(JSON.stringify(unknown.content), /missing/);
                } finally {
                    unsubscribe();
                }
            } finally {
                session.dispose();
            }
        }
    } finally {
        rows.clear();
        rmSync(directory, {recursive: true, force: true});
    }
});

function assertPurposeDescription(description: string, native: string): void {
    assert.match(description, /JSON object.*`purpose`.*`code`/);
    assert.match(description, /`code` runs as an async function body/);
    assert.match(description, /Optional first line of `code`: `\/\/ @options:/);
    assert.doesNotMatch(description, /The input is raw JavaScript|not JSON|start the tool input/);
    assert.match(description, /classifiers and image generation\. Read .*codemode\.md first/);
    // Pi still owns globals, docs references, and the generated tool catalogue verbatim.
    assert.equal(description.slice(description.indexOf("\n\n")), native.slice(native.indexOf("\n\n")));
}

function harness(rows: ToolDisplayRows) {
    let tool!: ToolDefinition;
    const settings = {codemode: {mode: "on" as "on" | "only", inlineBudget: 3000}};
    const pi = {
        registerTool: (definition: ToolDefinition) => { tool = definition; },
        getSettings: () => settings,
        getAllTools: () => [],
        appendEntry() {},
    } as unknown as ExtensionAPI;
    new CodemodeExtension(pi, rows).register();
    return {pi, tool, settings};
}

function renderContext(state: object, options: Partial<Parameters<NonNullable<ToolDefinition["renderCall"]>>[2]> = {}) {
    return {
        args: {}, toolCallId: "script", state, invalidate() {}, lastComponent: undefined,
        cwd: process.cwd(), executionStarted: false, argsComplete: true,
        isPartial: false, expanded: true, showImages: false, isError: false,
        ...options,
    };
}

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
