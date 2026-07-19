import assert from "node:assert/strict";
import test from "node:test";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionShutdownEvent,
    SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import pilotExtension, {PilotExtension} from "../src/extension.js";
import {PathPolicyRuntime} from "../src/policy/path/PathPolicyRuntime.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";

const experimentToolNames = ["bash-fuse", "bash-network"];

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>;
type SessionShutdownHandler = (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>;

type RegisteredTool = {
    name: string;
    execute: (
        id: string,
        params: {command: string},
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<unknown>;
};

type ExtensionHarness = {
    pi: ExtensionAPI;
    registeredTools: RegisteredTool[];
    registeredToolNames: string[];
    sessionStart: () => SessionStartHandler;
    sessionShutdown: () => SessionShutdownHandler;
};

test("the production extension installs Bash immediately but defers session resources", async () => {
    const harness = extensionHarness();
    const ctx = {cwd: process.cwd()} as ExtensionContext;

    pilotExtension(harness.pi);

    assert.deepEqual(harness.registeredToolNames, ["bash"]);
    const bashTool = harness.registeredTools[0];
    assert.ok(bashTool);
    await assert.rejects(
        bashTool.execute("before-start", {command: "true"}, undefined, undefined, ctx),
        /session runtime is not available/,
    );
    assert.equal(typeof harness.sessionStart(), "function");
    assert.equal(typeof harness.sessionShutdown(), "function");
});

test("one session runtime owns the production Bash override until session shutdown", async () => {
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
            const pathPolicy = new PathPolicyRuntime({
                loadPolicies: () => [],
                replacePolicies: () => {},
            });
            return {
                pathPolicy,
                decisionFlows: new UiDecisionFlowManager(runtimeContext),
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
    assert.deepEqual(harness.registeredToolNames, ["bash"]);
    assert.equal(harness.registeredToolNames.some((name) => experimentToolNames.includes(name)), false);

    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
    await harness.sessionShutdown()({type: "session_shutdown", reason: "quit"}, ctx);
    assert.equal(runtimeCloses, 1);
});

function extensionHarness(): ExtensionHarness {
    const registeredTools: RegisteredTool[] = [];
    const registeredToolNames: string[] = [];
    let startHandler: SessionStartHandler | undefined;
    let shutdownHandler: SessionShutdownHandler | undefined;
    const pi = {
        registerTool(tool: RegisteredTool) {
            registeredTools.push(tool);
            registeredToolNames.push(tool.name);
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
