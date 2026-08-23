import assert from "node:assert/strict";
import test from "node:test";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionShutdownEvent,
    SessionStartEvent,
    Theme,
} from "@earendil-works/pi-coding-agent";
import {initTheme} from "@earendil-works/pi-coding-agent";
import {PilotExtension} from "../src/pilot-extension.js";
import PolicyRuntime from "../src/policy/PolicyRuntime";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow";
import {PolicyDaoInterface} from "../src/storage/PolicyDao";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime";
import {UiDecisionFlowQueue} from "../src/tui/UiDecisionFlowQueue";

const expectedToolNames = [
    "bash",
    "web_search",
    "read",
    "edit",
    "write",
    "subagent_spawn",
    "subagent_status",
    "subagent_message",
    "subagent_stop",
];

function createPolicyRuntime(ctx: ExtensionContext): PolicyRuntime {
    return new PolicyRuntime(
        "extension-test-agent",
        {
            initializeSchema: () => undefined,
            loadPolicies: () => [],
            upsertPolicies() {
            },
            deletePolicy() {
            },
        } satisfies PolicyDaoInterface,
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
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
            content: Array<{ type: string; text?: string }>;
            details?: Record<string, unknown>;
        },
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RegisteredToolRenderContext,
    ) => RenderComponent;
    execute: (
        id: string,
        params: { command: string; purpose: string; timeout?: number },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<unknown>;
};

type ExtensionHarness = {
    pi: ExtensionAPI;
    registeredTools: RegisteredTool[];
    registeredToolNames: string[];
    hasShortcut: (key: string) => boolean;
    sessionStart: () => SessionStartHandler;
    sessionShutdown: () => SessionShutdownHandler;
};

test("the production extension installs built-in overrides immediately but defers session resources", async () => {
    const harness = extensionHarness();
    const ctx = {cwd: process.cwd()} as ExtensionContext;

    new PilotExtension(harness.pi, {
        createMcpExtension: createNoopMcpExtension,
    }).register();

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
    assert.equal(harness.hasShortcut("alt+o"), false);
    assert.equal(typeof harness.sessionStart(), "function");
    assert.equal(typeof harness.sessionShutdown(), "function");
});

test("Pi's expanded state switches Bash between minimal and truncated while row state reserves full", async () => {
    const harness = extensionHarness();
    const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        mode: "tui",
        ui: {
            setToolsExpanded() {
            }
        },
    } as unknown as ExtensionContext;
    const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;

    new PilotExtension(harness.pi, {
        createMcpExtension: createNoopMcpExtension,
        createSessionRuntime(runtimeContext) {
            return {
                policyRuntime: createPolicyRuntime(runtimeContext),
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
                fullNetworkInspection: true,
                setFullNetworkInspection() {
                },
                close() {
                },
            };
        },
    }).register();
    await harness.sessionStart()({type: "session_start", reason: "startup"}, ctx);

    const bashTool = registeredTool(harness, "bash");
    assert.ok(bashTool.renderCall && bashTool.renderResult);
    const args = {
        purpose: "Verify native display controls",
        command: Array.from({length: 10}, (_, index) => `echo ${index + 1}`).join("\n"),
    };
    const output = {content: [{type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix"}]};
    const displayState: Record<string, unknown> = {};

    assert.deepEqual(
        bashTool.renderCall(args, theme, toolRenderContext(args, displayState)).render(120),
        ["bash | Verify native display controls"],
    );
    assert.deepEqual(
        bashTool.renderResult(
            output,
            {expanded: false, isPartial: false},
            theme,
            toolRenderContext(args, displayState),
        ).render(120),
        [],
    );

    const truncatedCall = bashTool.renderCall(
        args,
        theme,
        toolRenderContext(args, displayState, {expanded: true}),
    ).render(120);
    assert.equal(truncatedCall.length, 10);
    assert.equal(truncatedCall.at(-1), "    ... (2 more lines)");
    assert.deepEqual(
        bashTool.renderResult(
            output,
            {expanded: true, isPartial: false},
            theme,
            toolRenderContext(args, displayState, {expanded: true}),
        ).render(120),
        ["", "... (1 earlier line)", "two", "three", "four", "five", "six"],
    );

    const fullState = {pilotFullDisplay: true};
    const fullCall = bashTool.renderCall(
        args,
        theme,
        toolRenderContext(args, fullState),
    ).render(120);
    assert.equal(fullCall.length, 11);
    assert.equal(fullCall.at(-1), "    echo 10");
    assert.deepEqual(
        bashTool.renderResult(
            output,
            {expanded: false, isPartial: false},
            theme,
            toolRenderContext(args, fullState),
        ).render(120),
        ["", "one", "two", "three", "four", "five", "six"],
    );

    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
});

test("Bash components remain renderable during and after session shutdown", async () => {
    const harness = extensionHarness();
    const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        mode: "tui",
        ui: {
            setToolsExpanded() {
            }
        },
    } as unknown as ExtensionContext;
    const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;
    let releaseMcpStop!: () => void;
    const mcpStop = new Promise<void>((resolve) => {
        releaseMcpStop = resolve;
    });
    let runtimeCloses = 0;

    new PilotExtension(harness.pi, {
        createMcpExtension: () => ({
            register() {
            },
            async startSession() {
            },
            stopSession: () => mcpStop,
            toolDefinitions: () => [],
        }),
        createSessionRuntime(runtimeContext) {
            return {
                policyRuntime: createPolicyRuntime(runtimeContext),
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
                fullNetworkInspection: true,
                setFullNetworkInspection() {
                },
                close() {
                    runtimeCloses++;
                },
            };
        },
    }).register();
    await harness.sessionStart()({type: "session_start", reason: "startup"}, ctx);

    const bashTool = registeredTool(harness, "bash");
    assert.ok(bashTool.renderCall);
    const call = bashTool.renderCall(
        {purpose: "Keep rendering during teardown", command: "echo complete"},
        theme,
        toolRenderContext(
            {purpose: "Keep rendering during teardown", command: "echo complete"},
            {},
            {expanded: true},
        ),
    );
    const shutdown = harness.sessionShutdown()({type: "session_shutdown", reason: "reload"}, ctx);

    let renderError: unknown;
    let renderedLines: string[] | undefined;
    try {
        renderedLines = call.render(120);
    } catch (error) {
        renderError = error;
    }
    releaseMcpStop();
    await shutdown;

    assert.ifError(renderError);
    const expectedLines = [
        "bash | Keep rendering during teardown",
        "    echo complete",
    ];
    assert.deepEqual(renderedLines, expectedLines);
    assert.equal(runtimeCloses, 1);
    assert.deepEqual(call.render(120), expectedLines);
});

test("read, edit, and write use minimal/truncated presentation and reserve native rendering for full", async () => {
    initTheme("dark");
    const harness = extensionHarness();
    const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        mode: "tui",
        ui: {
            setToolsExpanded() {
            }
        },
    } as unknown as ExtensionContext;
    const theme = {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    } as unknown as Theme;

    new PilotExtension(harness.pi, {
        createMcpExtension: createNoopMcpExtension,
        createSessionRuntime(runtimeContext) {
            const queue = new UiDecisionFlowQueue();
            return {
                policyRuntime: createPolicyRuntime(runtimeContext),
                decisionFlows: new UiDecisionFlowManager(runtimeContext, queue),
                fullNetworkInspection: true,
                setFullNetworkInspection() {
                },
                close() {
                },
            } satisfies PilotSessionRuntimeInterface;
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
    const readState: Record<string, unknown> = {};
    const writeState: Record<string, unknown> = {};
    const editState: Record<string, unknown> = {};
    let readCallContext = toolRenderContext(readArgs, readState, {expanded: true});
    let writeCallContext = toolRenderContext(writeArgs, writeState, {expanded: true});
    let editCallContext = toolRenderContext(editArgs, editState, {expanded: true});
    let readCall = readTool.renderCall(readArgs, theme, readCallContext);
    let writeCall = writeTool.renderCall(writeArgs, theme, writeCallContext);
    let editCall = editTool.renderCall(editArgs, theme, editCallContext);

    assert.deepEqual(readCall.render(120).map((line) => line.trimEnd()), ["read | notes.data:2-3"]);
    assert.deepEqual(
        writeCall.render(120).map((line) => line.trimEnd()),
        ["write | created.data", "    alpha", "    beta"],
    );
    assert.deepEqual(
        editCall.render(120).map((line) => line.trimEnd()),
        ["edit | changed.data (2 replacements)"],
    );

    readCallContext = {...readCallContext, expanded: false, lastComponent: readCall};
    writeCallContext = {...writeCallContext, expanded: false, lastComponent: writeCall};
    editCallContext = {...editCallContext, expanded: false, lastComponent: editCall};
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

    readState.pilotFullDisplay = true;
    writeState.pilotFullDisplay = true;
    editState.pilotFullDisplay = true;
    readCall = readTool.renderCall(
        readArgs,
        theme,
        {...readCallContext, expanded: false, lastComponent: readCall},
    );
    writeCall = writeTool.renderCall(
        writeArgs,
        theme,
        {...writeCallContext, expanded: false, lastComponent: writeCall},
    );
    assert.equal(readCall.render(120)[0]?.includes("read |"), false);
    assert.equal(writeCall.render(120)[0]?.includes("write |"), false);

    editCallContext = {...editCallContext, expanded: false, lastComponent: editCall};
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
        {expanded: false, isPartial: false},
        theme,
        toolRenderContext(editArgs, editState, {expanded: false}),
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
        createMcpExtension: createNoopMcpExtension,
        createSessionRuntime(runtimeContext) {
            runtimeCreations++;
            const policy = createPolicyRuntime(runtimeContext);
            return {
                policyRuntime: policy,
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
                fullNetworkInspection: true,
                setFullNetworkInspection() {
                },
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
        invalidate() {
        },
        lastComponent: options.lastComponent,
        executionStarted: true,
        argsComplete: false,
        isPartial: false,
        expanded: options.expanded ?? false,
        showImages: false,
        isError: options.isError ?? false,
    };
}

function createNoopMcpExtension() {
    return {
        register() {
        },
        async startSession() {
        },
        async stopSession() {
        },
        toolDefinitions: () => [],
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
        registerShortcut(key: string, options: { handler: ShortcutHandler }) {
            shortcuts.set(key, options.handler);
        },
        registerCommand() {
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
        hasShortcut(key) {
            return shortcuts.has(key);
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
