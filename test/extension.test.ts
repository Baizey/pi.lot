import assert from "node:assert/strict";
import test from "node:test";
import {initTheme} from "@earendil-works/pi-coding-agent";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionShutdownEvent,
    SessionStartEvent,
    Theme,
} from "@earendil-works/pi-coding-agent";
import pilotExtension, {PilotExtension} from "../src/extension.js";
import PolicyRuntime from "../src/policy/PolicyRuntime";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow";
import {PolicyDao} from "../src/storage/PolicyDao";
import {NetworkPolicyRuntime} from "../src/policy/network/NetworkPolicyRuntime.js";
import {NetworkPolicyDecisionFlow} from "../src/policy/network/NetworkPolicyDecisionFlow.js";
import {NetworkPolicyDao} from "../src/storage/NetworkPolicyDao.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import {ToolDisplayController} from "../src/tui/tool/ToolDisplayController.js";

const expectedToolNames = ["bash", "read", "edit", "write", "bash-network"];

function createPathPolicyRuntime(ctx: ExtensionContext): PolicyRuntime {
    return new PolicyRuntime(
        {
            loadPolicies: () => [],
            upsertPolicies() {},
            deletePolicy() {},
        } as unknown as PolicyDao,
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
}

function createNetworkPolicyRuntime(ctx: ExtensionContext): NetworkPolicyRuntime {
    return new NetworkPolicyRuntime(
        {
            loadPolicies: () => [],
            upsertPolicies() {},
            deletePolicy() {},
        } as unknown as NetworkPolicyDao,
        new NetworkPolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
}

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>;
type SessionShutdownHandler = (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>;
type ShortcutHandler = (ctx: ExtensionContext) => unknown;

type RegisteredToolParameter = {
    type?: string;
    description?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
};

type RenderComponent = {
    render(width: number): string[];
};

type RegisteredToolRenderContext = {
    expanded: boolean;
    isError: boolean;
    [key: string]: unknown;
};

type RegisteredTool = {
    name: string;
    description: string;
    parameters: {
        properties: Record<string, RegisteredToolParameter>;
        required?: string[];
    };
    renderShell?: "default" | "self";
    prepareArguments?: (args: unknown) => unknown;
    renderCall?: (
        args: Record<string, unknown>,
        theme: Theme,
        context: RegisteredToolRenderContext,
    ) => RenderComponent;
    renderResult?: (
        result: {
            content: Array<{type: string; text?: string}>;
            details?: Record<string, unknown>;
        },
        options: {expanded: boolean; isPartial: boolean},
        theme: Theme,
        context: RegisteredToolRenderContext,
    ) => RenderComponent;
    execute: (
        id: string,
        params: {command: string; purpose: string; timeout?: number},
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<unknown>;
};

type ExtensionHarness = {
    pi: ExtensionAPI;
    registeredTools: RegisteredTool[];
    registeredToolNames: string[];
    shortcut: (key: string) => ShortcutHandler;
    sessionStart: () => SessionStartHandler;
    sessionShutdown: () => SessionShutdownHandler;
};

test("the production extension installs built-in overrides immediately but defers session resources", async () => {
    const harness = extensionHarness();
    const ctx = {cwd: process.cwd()} as ExtensionContext;

    pilotExtension(harness.pi);

    assert.deepEqual(harness.registeredToolNames, expectedToolNames);
    const bashTool = registeredTool(harness, "bash");
    assert.ok(bashTool);
    const commandParameter = bashTool.parameters.properties.command;
    const purposeParameter = bashTool.parameters.properties.purpose;
    assert.equal(commandParameter?.description, "Bash command to execute");
    assert.ok(purposeParameter);
    assert.equal(purposeParameter.description, "A short, one-line explanation of what the command will achieve");
    assert.equal(purposeParameter.minLength, 1);
    assert.equal(purposeParameter.maxLength, 160);
    assert.equal(purposeParameter.pattern, "^[^\\r\\n]+$");
    assert.equal(bashTool.parameters.required?.includes("purpose"), true);
    await assert.rejects(
        bashTool.execute(
            "before-start",
            {command: "true", purpose: "Verify that Bash fails closed before session startup"},
            undefined,
            undefined,
            ctx,
        ),
        /session runtime is not available/,
    );
    await assert.rejects(
        registeredTool(harness, "bash-network").execute(
            "network-before-start",
            {command: "true", purpose: "Verify network runtime ownership"},
            undefined,
            undefined,
            ctx,
        ),
        /session runtime is not available/,
    );
    assert.equal(typeof harness.shortcut("alt+o"), "function");
    assert.equal(typeof harness.sessionStart(), "function");
    assert.equal(typeof harness.sessionShutdown(), "function");
});

test("Alt+O toggles the production Bash renderer through the session runtime", async () => {
    const harness = extensionHarness();
    const expandedStates: boolean[] = [];
    const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        mode: "tui",
        ui: {
            setToolsExpanded(expanded: boolean) {
                expandedStates.push(expanded);
            },
        },
    } as unknown as ExtensionContext;
    const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;

    new PilotExtension(harness.pi, {
        createSessionRuntime(runtimeContext) {
            const toolDisplay = new ToolDisplayController(runtimeContext);
            return {
                pathPolicy: createPathPolicyRuntime(runtimeContext),
                networkPolicy: createNetworkPolicyRuntime(runtimeContext),
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
                toolDisplay,
                close() {},
            };
        },
    }).register();
    await harness.sessionStart()({type: "session_start", reason: "startup"}, ctx);

    const bashTool = registeredTool(harness, "bash");
    assert.ok(bashTool?.renderCall);
    assert.ok(bashTool.renderResult);
    const args = {
        purpose: "Verify live display controls",
        command: Array.from({length: 10}, (_, index) => `echo ${index + 1}`).join("\n"),
    };
    const call = bashTool.renderCall(args, theme, {expanded: false, isError: false});
    const result = bashTool.renderResult(
        {content: [{type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix"}]},
        {expanded: false, isPartial: false},
        theme,
        {expanded: false, isError: false},
    );

    assert.match(call.render(120).at(-1) ?? "", /2 more lines/);
    assert.match(result.render(120)[1] ?? "", /1 earlier line/);
    harness.shortcut("alt+o")(ctx);
    assert.deepEqual(call.render(120), ["bash | Verify live display controls"]);
    assert.deepEqual(result.render(120), []);
    harness.shortcut("alt+o")(ctx);
    assert.match(call.render(120).at(-1) ?? "", /2 more lines/);

    bashTool.renderCall(args, theme, {expanded: true, isError: false});
    assert.equal(call.render(120).some((line) => line.includes("more lines")), false);
    harness.shortcut("alt+o")(ctx);
    assert.deepEqual(call.render(120), ["bash | Verify live display controls"]);
    harness.shortcut("alt+o")(ctx);
    assert.equal(call.render(120).some((line) => line.includes("more lines")), false);
    assert.deepEqual(expandedStates, [false, false, false, false, true]);

    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
});

test("read, edit, and write preserve native rendering while honoring minimal mode", async () => {
    initTheme("dark");
    const harness = extensionHarness();
    const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        mode: "tui",
        ui: {setToolsExpanded() {}},
    } as unknown as ExtensionContext;
    const theme = {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;

    new PilotExtension(harness.pi, {
        createSessionRuntime(runtimeContext) {
            return {
                pathPolicy: createPathPolicyRuntime(runtimeContext),
                networkPolicy: createNetworkPolicyRuntime(runtimeContext),
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
                toolDisplay: new ToolDisplayController(runtimeContext),
                close() {},
            };
        },
    }).register();
    await harness.sessionStart()({type: "session_start", reason: "startup"}, ctx);

    const readTool = registeredTool(harness, "read");
    const editTool = registeredTool(harness, "edit");
    const writeTool = registeredTool(harness, "write");
    assert.ok(readTool.renderCall && readTool.renderResult);
    assert.ok(editTool.renderCall && editTool.renderResult);
    assert.ok(writeTool.renderCall && writeTool.renderResult);
    assert.equal(editTool.renderShell, "self");
    assert.equal(typeof editTool.prepareArguments, "function");

    const readArgs = {path: "notes.data", offset: 2, limit: 2};
    const writeArgs = {path: "created.data", content: "alpha\nbeta"};
    const editArgs = {
        path: "changed.data",
        edits: [
            {oldText: "old one", newText: "new one"},
            {oldText: "old two", newText: "new two"},
        ],
    };
    const readState = {};
    const writeState = {};
    const editState = {};
    let readCallContext = toolRenderContext(readArgs, readState);
    let writeCallContext = toolRenderContext(writeArgs, writeState);
    let editCallContext = toolRenderContext(editArgs, editState);
    let readCall = readTool.renderCall(readArgs, theme, readCallContext);
    let writeCall = writeTool.renderCall(writeArgs, theme, writeCallContext);
    let editCall = editTool.renderCall(editArgs, theme, editCallContext);

    assert.equal(readCall.render(120).some((line) => line.includes("notes.data")), true);
    assert.equal(writeCall.render(120).some((line) => line.includes("alpha")), true);
    assert.equal(editCall.render(120).some((line) => line.includes("2 replacements")), true);

    harness.shortcut("alt+o")(ctx);
    readCallContext = {...readCallContext, lastComponent: readCall};
    writeCallContext = {...writeCallContext, lastComponent: writeCall};
    editCallContext = {...editCallContext, lastComponent: editCall};
    readCall = readTool.renderCall(readArgs, theme, readCallContext);
    writeCall = writeTool.renderCall(writeArgs, theme, writeCallContext);
    editCall = editTool.renderCall(editArgs, theme, editCallContext);

    assert.deepEqual(readCall.render(120).map((line) => line.trimEnd()), ["read | notes.data:2-3"]);
    assert.deepEqual(writeCall.render(120).map((line) => line.trimEnd()), ["write | created.data"]);
    assert.equal(editCall.render(120).some((line) => line.includes("edit | changed.data")), true);
    assert.equal(editCall.render(120).some((line) => line.includes("2 replacements")), true);
    assert.deepEqual(
        readTool.renderCall(
            {path: "notes.data", limit: 2},
            theme,
            toolRenderContext({path: "notes.data", limit: 2}, {}),
        ).render(120).map((line) => line.trimEnd()),
        ["read | notes.data:1-2"],
    );
    assert.deepEqual(
        readTool.renderCall(
            {path: "notes.data", offset: 2},
            theme,
            toolRenderContext({path: "notes.data", offset: 2}, {}),
        ).render(120).map((line) => line.trimEnd()),
        ["read | notes.data:2"],
    );

    const errorResult = {content: [{type: "text", text: "visible error details"}]};
    assert.deepEqual(
        readTool.renderResult(
            errorResult,
            {expanded: false, isPartial: false},
            theme,
            toolRenderContext(readArgs, readState, {isError: true}),
        ).render(120),
        [],
    );
    assert.deepEqual(
        writeTool.renderResult(
            errorResult,
            {expanded: false, isPartial: false},
            theme,
            toolRenderContext(writeArgs, writeState, {isError: true}),
        ).render(120),
        [],
    );
    assert.deepEqual(
        editTool.renderResult(
            errorResult,
            {expanded: false, isPartial: false},
            theme,
            toolRenderContext(editArgs, editState, {isError: true}),
        ).render(120),
        [],
    );

    harness.shortcut("alt+o")(ctx);
    editCallContext = {...editCallContext, expanded: true, lastComponent: editCall};
    editCall = editTool.renderCall(editArgs, theme, editCallContext);
    editTool.renderResult(
        {
            content: [{type: "text", text: "Successfully replaced 2 blocks"}],
            details: {
                diff: "@@ -1 +1 @@\n-old value\n+new value",
                patch: "",
                firstChangedLine: 1,
            },
        },
        {expanded: true, isPartial: false},
        theme,
        toolRenderContext(editArgs, editState, {expanded: true}),
    );
    assert.equal(editCall.render(120).some((line) => line.includes("old value")), true);
    assert.equal(editCall.render(120).some((line) => line.includes("new value")), true);

    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
});

test("one session runtime owns the production tool overrides until session shutdown", async () => {
    const harness = extensionHarness();
    const ctx = {
        cwd: process.cwd(),
        hasUI: false,
        mode: "print",
        ui: {},
    } as unknown as ExtensionContext;
    let runtimeCreations = 0;
    let runtimeCloses = 0;

    new PilotExtension(harness.pi, {
        createSessionRuntime(runtimeContext) {
            runtimeCreations++;
            const pathPolicy = createPathPolicyRuntime(runtimeContext);
            const networkPolicy = createNetworkPolicyRuntime(runtimeContext);
            const toolDisplay = new ToolDisplayController(runtimeContext);
            return {
                pathPolicy,
                networkPolicy,
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
                toolDisplay,
                close() {
                    runtimeCloses++;
                },
            };
        },
    }).register();

    await harness.sessionStart()({type: "session_start", reason: "startup"}, ctx);

    assert.equal(runtimeCreations, 1);
    assert.throws(
        () => harness.sessionStart()({type: "session_start", reason: "reload"}, ctx),
        /session runtime is already started/,
    );
    assert.equal(runtimeCreations, 1);
    assert.deepEqual(harness.registeredToolNames, expectedToolNames);
    assert.equal(harness.registeredToolNames.includes("bash-fuse"), false);

    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
    assert.equal(runtimeCloses, 1);
});

function registeredTool(harness: ExtensionHarness, name: string): RegisteredTool {
    const tool = harness.registeredTools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    return tool;
}

function toolRenderContext(
    args: Record<string, unknown>,
    state: Record<string, unknown>,
    options: {
        expanded?: boolean;
        isError?: boolean;
        lastComponent?: RenderComponent;
    } = {},
): RegisteredToolRenderContext {
    return {
        args,
        state,
        toolCallId: `test-${String(args.path ?? "tool")}`,
        cwd: process.cwd(),
        invalidate() {},
        lastComponent: options.lastComponent,
        executionStarted: true,
        argsComplete: false,
        isPartial: false,
        expanded: options.expanded ?? false,
        showImages: false,
        isError: options.isError ?? false,
    };
}

function extensionHarness(): ExtensionHarness {
    const registeredTools: RegisteredTool[] = [];
    const registeredToolNames: string[] = [];
    const shortcuts = new Map<string, ShortcutHandler>();
    let startHandler: SessionStartHandler | undefined;
    let shutdownHandler: SessionShutdownHandler | undefined;
    const pi = {
        registerTool(tool: RegisteredTool) {
            registeredTools.push(tool);
            registeredToolNames.push(tool.name);
        },
        registerShortcut(key: string, options: {handler: ShortcutHandler}) {
            shortcuts.set(key, options.handler);
        },
        on(event: string, handler: unknown) {
            if (event === "session_start") startHandler = handler as SessionStartHandler;
            if (event === "session_shutdown") shutdownHandler = handler as SessionShutdownHandler;
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        registeredTools,
        registeredToolNames,
        shortcut(key) {
            const handler = shortcuts.get(key);
            assert.ok(handler);
            return handler;
        },
        sessionStart() {
            assert.ok(startHandler);
            return startHandler;
        },
        sessionShutdown() {
            assert.ok(shutdownHandler);
            return shutdownHandler;
        },
    };
}
