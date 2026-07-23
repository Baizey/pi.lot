import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {FusePathPolicyAuthorizer} from "../src/fuse/FusePathPolicyAuthorizer.js";
import {
    FuseAccessType,
    FuseDecision,
    FuseOperation,
} from "../src/fuse/FuseFilesystem.js";
import {PathPolicyLogic} from "../src/policy/path/PathPolicyLogic.js";
import {PathPolicyRuntime} from "../src/policy/path/PathPolicyRuntime.js";
import {FsAccessType} from "../src/policy/path/types.js";
import type {PathPolicy} from "../src/policy/path/types.js";
import {PolicyLifetime, PolicyStatus} from "../src/policy/types";
import {PathPolicyDao} from "../src/storage/PathPolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {
    UiDecisionFlowManager,
    UiFlowShortcut,
} from "../src/tui/UiDecisionFlowManager.js";
import type {UiDecision} from "../src/tui/UiDecisionFlowManager.js";

function policy(
    target: string,
    accessType: FsAccessType,
    lifetime: PolicyLifetime,
    status: PolicyStatus,
    reason: string,
): PathPolicy {
    return {
        path: target,
        info: {
            [accessType]: PathPolicyLogic.createStatus(accessType, lifetime, status, reason),
        },
    };
}

test("a path and access type identify one policy whose properties can be replaced", () => {
    const target = path.join(os.tmpdir(), "pi-policy-replacement");
    const logic = new PathPolicyLogic({
        policies: [policy(target, FsAccessType.READ, PolicyLifetime.LOCAL, PolicyStatus.ALLOWED, "initial")],
    });

    logic.addPolicies([
        policy(target, FsAccessType.READ, PolicyLifetime.SESSION, PolicyStatus.DENIED, "replacement"),
    ]);

    const snapshot = logic.policiesSnapshot();
    assert.equal(snapshot.length, 1);
    assert.deepEqual(snapshot[0]?.info[FsAccessType.READ], {
        accessType: FsAccessType.READ,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyStatus.DENIED,
        reason: "replacement",
    });
});

test("different access types coexist at one path", () => {
    const target = path.join(os.tmpdir(), "pi-policy-access-types");
    const logic = new PathPolicyLogic();

    logic.addPolicies([
        policy(target, FsAccessType.READ, PolicyLifetime.SESSION, PolicyStatus.ALLOWED, "read"),
        policy(target, FsAccessType.WRITE, PolicyLifetime.LOCAL, PolicyStatus.DENIED, "write"),
    ]);

    const snapshot = logic.policiesSnapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.info[FsAccessType.READ]?.reason, "read");
    assert.equal(snapshot[0]?.info[FsAccessType.WRITE]?.reason, "write");
});

test("deleting an access policy does not depend on its lifetime", () => {
    const target = path.join(os.tmpdir(), "pi-policy-deletion");
    const logic = new PathPolicyLogic({
        policies: [
            policy(target, FsAccessType.READ, PolicyLifetime.GLOBAL, PolicyStatus.ALLOWED, "read"),
            policy(target, FsAccessType.WRITE, PolicyLifetime.SESSION, PolicyStatus.DENIED, "write"),
        ],
    });

    logic.removePolicies([{path: target, accessTypes: [FsAccessType.READ]}]);

    assert.equal(logic.evaluate(target, FsAccessType.READ), null);
    assert.equal(logic.evaluate(target, FsAccessType.WRITE)?.matchedLifetime, PolicyLifetime.SESSION);
});

test("only local and global policies are included in the persisted snapshot", () => {
    const base = path.join(os.tmpdir(), "pi-policy-persistence");
    const logic = new PathPolicyLogic({
        policies: [
            policy(path.join(base, "once"), FsAccessType.READ, PolicyLifetime.ONCE, PolicyStatus.ALLOWED, "once"),
            policy(path.join(base, "session"), FsAccessType.READ, PolicyLifetime.SESSION, PolicyStatus.ALLOWED, "session"),
            policy(path.join(base, "local"), FsAccessType.READ, PolicyLifetime.LOCAL, PolicyStatus.ALLOWED, "local"),
            policy(path.join(base, "global"), FsAccessType.READ, PolicyLifetime.GLOBAL, PolicyStatus.ALLOWED, "global"),
        ],
    });

    const persisted = logic.persistedPolicies();
    assert.deepEqual(
        persisted.map((item) => item.info[FsAccessType.READ]?.lifetime),
        [PolicyLifetime.LOCAL, PolicyLifetime.GLOBAL],
    );
});

test("a policy on the filesystem root applies to the root and every descendant", () => {
    const logic = new PathPolicyLogic({
        policies: [
            policy("/", FsAccessType.WRITE, PolicyLifetime.SESSION, PolicyStatus.DENIED, "root policy"),
        ],
    });

    for (const target of ["/", "/tmp", "/var/home/example/nested/file.txt"]) {
        const result = logic.evaluate(target, FsAccessType.WRITE);
        assert.equal(result?.matchedPattern, "/");
        assert.equal(result?.matchedStatus, PolicyStatus.DENIED);
        assert.equal(result?.matchedReason, "root policy");
    }
});

test("recording a root policy applies it to later tool calls", () => {
    const runtime = new PathPolicyRuntime({
        loadPolicies: () => [],
        replacePolicies: () => {},
    });
    const firstCall = runtime.beginToolCall();

    const recorded = firstCall.record({
        path: "/",
        accessType: FsAccessType.WRITE,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyStatus.DENIED,
        reason: "recorded root policy",
    });

    assert.equal(recorded.matchedPattern, "/");
    assert.equal(recorded.matchedStatus, PolicyStatus.DENIED);
    const laterResult = runtime.beginToolCall().evaluate("/var/home/example/file.txt", FsAccessType.WRITE);
    assert.equal(laterResult?.matchedPattern, "/");
    assert.equal(laterResult?.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(laterResult?.matchedReason, "recorded root policy");
});

test("the most-specific path policy wins", () => {
    const parent = path.join(os.tmpdir(), "pi-policy-specificity");
    const child = path.join(parent, "child");
    const logic = new PathPolicyLogic({
        policies: [
            policy(parent, FsAccessType.READ, PolicyLifetime.LOCAL, PolicyStatus.ALLOWED, "parent"),
            policy(child, FsAccessType.READ, PolicyLifetime.SESSION, PolicyStatus.DENIED, "child"),
        ],
    });

    const result = logic.evaluate(path.join(child, "file.txt"), FsAccessType.READ);
    assert.equal(result?.matchedPattern, logic.policyPathFor(child));
    assert.equal(result?.matchedStatus, PolicyStatus.DENIED);
});

test("path policy matching preserves Linux case sensitivity", () => {
    const parent = path.join(os.tmpdir(), "pi-policy-case-sensitive");
    const upperCasePath = path.join(parent, "Target");
    const lowerCasePath = path.join(parent, "target");
    const logic = new PathPolicyLogic({
        policies: [
            policy(upperCasePath, FsAccessType.WRITE, PolicyLifetime.LOCAL, PolicyStatus.ALLOWED, "exact case"),
        ],
    });

    assert.equal(logic.evaluate(upperCasePath, FsAccessType.WRITE)?.matchedStatus, PolicyStatus.ALLOWED);
    assert.equal(logic.evaluate(lowerCasePath, FsAccessType.WRITE), null);
});

test("local and global path policies round-trip through SQLite", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-policy-dao-"));
    const database = SqliteDatabase.test(false, path.join(directory, "policies.sqlite"));

    try {
        const target = path.join(directory, "workspace");
        const saved = new PathPolicyLogic({
            policies: [
                policy(target, FsAccessType.READ, PolicyLifetime.LOCAL, PolicyStatus.ALLOWED, "local read"),
                policy(target, FsAccessType.WRITE, PolicyLifetime.GLOBAL, PolicyStatus.DENIED, "global write"),
                policy(target, FsAccessType.DELETE, PolicyLifetime.SESSION, PolicyStatus.DENIED, "session delete"),
            ],
        });
        const dao = new PathPolicyDao(database).initializeSchema();
        dao.replacePolicies(saved.persistedPolicies());

        const loaded = new PathPolicyLogic({policies: dao.loadPolicies()});
        assert.equal(loaded.evaluate(target, FsAccessType.READ)?.matchedLifetime, PolicyLifetime.LOCAL);
        assert.equal(loaded.evaluate(target, FsAccessType.WRITE)?.matchedLifetime, PolicyLifetime.GLOBAL);
        assert.equal(loaded.evaluate(target, FsAccessType.DELETE), null);
    } finally {
        database.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("runtime policy ownership follows tool-call, session, and local lifetimes", () => {
    const target = path.join(os.tmpdir(), "pi-policy-runtime");
    let persisted: PathPolicy[] = [];
    const runtime = new PathPolicyRuntime({
        loadPolicies: () => structuredClone(persisted),
        replacePolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    });
    const firstCall = runtime.beginToolCall();
    const secondCall = runtime.beginToolCall();

    firstCall.record({
        path: target,
        accessType: FsAccessType.READ,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyStatus.ALLOWED,
        reason: "once",
    });
    assert.equal(firstCall.evaluate(target, FsAccessType.READ)?.matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(secondCall.evaluate(target, FsAccessType.READ), null);

    firstCall.record({
        path: target,
        accessType: FsAccessType.WRITE,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyStatus.DENIED,
        reason: "session",
    });
    assert.equal(secondCall.evaluate(target, FsAccessType.WRITE)?.matchedLifetime, PolicyLifetime.SESSION);
    assert.deepEqual(persisted, []);

    firstCall.record({
        path: target,
        accessType: FsAccessType.DELETE,
        lifetime: PolicyLifetime.LOCAL,
        status: PolicyStatus.ALLOWED,
        reason: "local",
    });
    const nextSession = new PathPolicyRuntime({
        loadPolicies: () => structuredClone(persisted),
        replacePolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    });
    assert.equal(
        nextSession.beginToolCall().evaluate(target, FsAccessType.DELETE)?.matchedLifetime,
        PolicyLifetime.LOCAL,
    );
    assert.equal(nextSession.beginToolCall().evaluate(target, FsAccessType.WRITE), null);
});

test("FUSE path approval uses the decision flow manager and records session policy", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-policy-flow-"));
    const target = path.join(workspace, "allowed.txt");
    const controller = new AbortController();
    const promptTitles: string[] = [];
    const promptSignals: Array<AbortSignal | undefined> = [];
    const ctx = {
        cwd: workspace,
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(
                title: string,
                options: string[],
                dialogOptions?: {signal?: AbortSignal},
            ): Promise<string | undefined> {
                promptTitles.push(title);
                promptSignals.push(dialogOptions?.signal);
                if (title.startsWith("Path policy scope")) return options[0];
                if (title.startsWith("Path policy decision")) return "Allow";
                if (title.startsWith("Path policy lifetime")) return "This session";
                return undefined;
            },
            async input(): Promise<string | undefined> {
                assert.fail("allowing a path must not ask for a denial reason");
            },
            async custom(): Promise<never> {
                assert.fail("RPC decisions must use Pi's dialog protocol, not a TUI component");
            },
        },
    } as unknown as ExtensionContext;
    const runtime = new PathPolicyRuntime({
        loadPolicies: () => [],
        replacePolicies: () => {},
    });
    const reports: string[] = [];
    const authorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        command: "printf allowed > allowed.txt",
        purpose: "Create the allowed test file",
        decisionFlows: new UiDecisionFlowManager(ctx),
        signal: controller.signal,
        policy: runtime.beginToolCall(),
        report: (message) => reports.push(message),
    });

    try {
        const decision = await authorizer.decide({
            sequence: 1,
            operation: FuseOperation.CREATE,
            pathAccesses: [{access: FuseAccessType.WRITE, path: target}],
        });

        assert.equal(decision, FuseDecision.ALLOW);
        assert.equal(promptTitles.length, 3);
        assert.equal(promptTitles.every((title) => title.includes(target)), true);
        assert.equal(promptTitles.every((title) => title.includes("Purpose: Create the allowed test file")), true);
        assert.deepEqual(promptSignals, [controller.signal, controller.signal, controller.signal]);
        assert.equal(reports.length, 0);
        assert.equal(
            runtime.beginToolCall().evaluate(target, FsAccessType.WRITE)?.matchedLifetime,
            PolicyLifetime.SESSION,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE path denial records the optional reason collected by the decision flow", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-policy-denial-"));
    const target = path.join(workspace, "denied.txt");
    const denialReason = "Generated files must not be overwritten.";
    let reasonPrompts = 0;
    const ctx = {
        cwd: workspace,
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(title: string, options: string[]): Promise<string | undefined> {
                if (title.startsWith("Path policy scope")) return options[0];
                if (title.startsWith("Path policy decision")) return "Deny";
                if (title.startsWith("Path policy lifetime")) return "Once";
                return undefined;
            },
            async input(): Promise<string | undefined> {
                reasonPrompts++;
                return denialReason;
            },
        },
    } as unknown as ExtensionContext;
    const runtime = new PathPolicyRuntime({
        loadPolicies: () => [],
        replacePolicies: () => {},
    });
    const toolCall = runtime.beginToolCall();
    const reports: string[] = [];
    const authorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        command: "printf denied > denied.txt",
        purpose: "Attempt to overwrite a denied test file",
        decisionFlows: new UiDecisionFlowManager(ctx),
        policy: toolCall,
        report: (message) => reports.push(message),
    });

    try {
        const decision = await authorizer.decide({
            sequence: 1,
            operation: FuseOperation.WRITE,
            pathAccesses: [{access: FuseAccessType.WRITE, path: target}],
        });

        assert.equal(decision, FuseDecision.DENY);
        assert.equal(reasonPrompts, 1);
        assert.equal(reports[0]?.includes(denialReason), true);
        assert.equal(toolCall.evaluate(target, FsAccessType.WRITE)?.matchedReason, denialReason);
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("the decision flow manager supports TUI allow-once and deny-once shortcuts", async () => {
    type ShortcutApproval = {status: PolicyStatus};
    type TestComponent = {
        render(width: number): string[];
        handleInput?(data: string): void;
        invalidate(): void;
    };

    const shortcutInputs = ["\x1b[C", "\x1b[D"];
    const expected = [UiFlowShortcut.ALLOW_ALL_ONCE, UiFlowShortcut.DENY_ALL_ONCE];
    for (let index = 0; index < shortcutInputs.length; index++) {
        const ctx = {
            cwd: process.cwd(),
            hasUI: true,
            mode: "tui",
            ui: {
                async select(): Promise<never> {
                    assert.fail("TUI shortcut flows must use the custom decision component");
                },
                async input(): Promise<never> {
                    assert.fail("this flow has no input decision");
                },
                async custom<T>(factory: (
                    tui: {requestRender(): void},
                    theme: object,
                    keybindings: object,
                    done: (value: T) => void,
                ) => TestComponent): Promise<T> {
                    return new Promise<T>((resolve) => {
                        const component = factory({requestRender() {}}, {}, {}, resolve);
                        component.handleInput?.(shortcutInputs[index]!);
                    });
                },
            },
        } as unknown as ExtensionContext;
        const statusDecision = {
            type: "select",
            key: "status",
            title: "Path policy decision",
            options: [{title: "Allow", value: PolicyStatus.ALLOWED, next: null}],
        } satisfies UiDecision<ShortcutApproval>;

        const result = await new UiDecisionFlowManager(ctx).runFlow(
            statusDecision,
            {status: statusDecision},
            () => ({status: PolicyStatus.DENIED}),
            {shortcuts: {enabled: true}},
        );

        assert.equal(result, expected[index]);
    }
});

test("an aborted FUSE decision flow fails closed without opening a prompt", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-policy-cancel-"));
    const target = path.join(workspace, "denied.txt");
    const controller = new AbortController();
    controller.abort();
    let prompts = 0;
    const ctx = {
        cwd: workspace,
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(): Promise<string | undefined> {
                prompts++;
                return "Allow";
            },
        },
    } as unknown as ExtensionContext;
    const runtime = new PathPolicyRuntime({
        loadPolicies: () => [],
        replacePolicies: () => {},
    });
    const toolCall = runtime.beginToolCall();
    const reports: string[] = [];
    const authorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        command: "printf denied > denied.txt",
        purpose: "Attempt to create a file after cancellation",
        decisionFlows: new UiDecisionFlowManager(ctx),
        signal: controller.signal,
        policy: toolCall,
        report: (message) => reports.push(message),
    });

    try {
        const decision = await authorizer.decide({
            sequence: 1,
            operation: FuseOperation.CREATE,
            pathAccesses: [{access: FuseAccessType.WRITE, path: target}],
        });

        assert.equal(decision, FuseDecision.DENY);
        assert.equal(prompts, 0);
        assert.match(reports[0] ?? "", /No path policy scope selected/);
        assert.equal(toolCall.evaluate(target, FsAccessType.WRITE)?.matchedLifetime, PolicyLifetime.ONCE);
        assert.equal(runtime.beginToolCall().evaluate(target, FsAccessType.WRITE), null);
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});
