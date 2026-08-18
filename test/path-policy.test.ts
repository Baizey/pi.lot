import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {FusePathPolicyAuthorizer} from "../src/policy/path/fuse/FusePathPolicyAuthorizer.js";
import {FuseAccessType, FuseDecision, FuseOperation,} from "../src/policy/path/fuse/FuseFilesystem.js";
import {PolicyLogic} from "../src/policy/PolicyLogic";
import PolicyRuntime from "../src/policy/PolicyRuntime";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow";
import type {PolicyChoice} from "../src/policy/PolicyDecisionFlow";
import type {Policy} from "../src/policy/types";
import {PolicyAccessType, PolicyLifetime, PolicyResponse, ResponseType} from "../src/policy/types";
import {resolvePhysicalPath} from "../src/policy/path/validation.js";
import {PolicyDao} from "../src/storage/PolicyDao";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import type {UiDecision} from "../src/tui/UiDecisionFlowManager.js";
import {UiDecisionFlowManager, UiFlowShortcut,} from "../src/tui/UiDecisionFlowManager.js";

function policy(
    target: string,
    accessType: PolicyAccessType,
    lifetime: PolicyLifetime,
    status: PolicyResponse,
    reason: string,
): Policy {
    return {
        pattern: target,
        info: {
            [accessType]: PolicyLogic.createStatus(accessType, lifetime, status, reason),
        },
    };
}

function pathPolicyDao(
    overrides: Partial<Pick<PolicyDao, "loadPolicies" | "upsertPolicies" | "deletePolicy">> = {},
): PolicyDao {
    return {
        loadPolicies: () => [],
        upsertPolicies() {},
        deletePolicy() {},
        ...overrides,
    } as unknown as PolicyDao;
}

function scriptedDecisionFlow(choices: PolicyChoice[]): {
    flow: PolicyDecisionFlow;
    callCount(): number;
} {
    let calls = 0;
    const flow = {
        async askForPolicy(_path: string, accessType: PolicyAccessType): Promise<PolicyChoice> {
            const choice = choices[calls++];
            assert.ok(choice, "Unexpected path policy decision request");
            assert.equal(choice.accessType, accessType);
            return choice;
        },
    } as unknown as PolicyDecisionFlow;
    return {flow, callCount: () => calls};
}

function unexpectedDecisionFlow(): PolicyDecisionFlow {
    return scriptedDecisionFlow([]).flow;
}

test("a path and access type identify one policy whose properties can be replaced", () => {
    const target = path.join(os.tmpdir(), "pi-policy-replacement");
    const logic = new PolicyLogic({
        policies: [policy(target, PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "initial")],
    });

    logic.addPolicies([
        policy(target, PolicyAccessType.FS_READ, PolicyLifetime.SESSION, PolicyResponse.DENIED, "replacement"),
    ]);

    const snapshot = logic.allPolicies();
    assert.equal(snapshot.length, 1);
    assert.deepEqual(snapshot[0]?.info[PolicyAccessType.FS_READ], {
        accessType: PolicyAccessType.FS_READ,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.DENIED,
        reason: "replacement",
    });
});

test("different access types coexist at one path", () => {
    const target = path.join(os.tmpdir(), "pi-policy-access-types");
    const logic = new PolicyLogic();

    logic.addPolicies([
        policy(target, PolicyAccessType.FS_READ, PolicyLifetime.SESSION, PolicyResponse.ALLOWED, "read"),
        policy(target, PolicyAccessType.FS_WRITE, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "write"),
    ]);

    const snapshot = logic.allPolicies();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.info[PolicyAccessType.FS_READ]?.reason, "read");
    assert.equal(snapshot[0]?.info[PolicyAccessType.FS_WRITE]?.reason, "write");
});

test("deleting an access policy does not depend on its lifetime", () => {
    const target = path.join(os.tmpdir(), "pi-policy-deletion");
    const logic = new PolicyLogic({
        policies: [
            policy(target, PolicyAccessType.FS_READ, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "read"),
            policy(target, PolicyAccessType.FS_WRITE, PolicyLifetime.SESSION, PolicyResponse.DENIED, "write"),
        ],
    });

    logic.removePolicies([{uri: target, accessTypes: [PolicyAccessType.FS_READ]}]);

    assert.equal(logic.evaluate(target, PolicyAccessType.FS_READ), null);
    assert.equal(logic.evaluate(target, PolicyAccessType.FS_WRITE)?.matchedLifetime, PolicyLifetime.SESSION);
});

test("only local and global policies are included in the persisted snapshot", () => {
    const base = path.join(os.tmpdir(), "pi-policy-persistence");
    const logic = new PolicyLogic({
        policies: [
            policy(path.join(base, "once"), PolicyAccessType.FS_READ, PolicyLifetime.ONCE, PolicyResponse.ALLOWED, "once"),
            policy(path.join(base, "session"), PolicyAccessType.FS_READ, PolicyLifetime.SESSION, PolicyResponse.ALLOWED, "session"),
            policy(path.join(base, "local"), PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "local"),
            policy(path.join(base, "global"), PolicyAccessType.FS_READ, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "global"),
        ],
    });

    const persisted = logic.persistedPolicies();
    assert.deepEqual(
        persisted.map((item) => item.info[PolicyAccessType.FS_READ]?.lifetime),
        [PolicyLifetime.LOCAL, PolicyLifetime.GLOBAL],
    );
});

test("a policy on the filesystem root applies to the root and every descendant", () => {
    const logic = new PolicyLogic({
        policies: [
            policy("/", PolicyAccessType.FS_WRITE, PolicyLifetime.SESSION, PolicyResponse.DENIED, "root policy"),
        ],
    });

    for (const target of ["/", "/tmp", "/var/home/example/nested/file.txt"]) {
        const result = logic.evaluate(target, PolicyAccessType.FS_WRITE);
        assert.equal(result?.matchedPattern, "/");
        assert.equal(result?.matchedStatus, PolicyResponse.DENIED);
        assert.equal(result?.matchedReason, "root policy");
    }
});

test("recording a root policy applies it to later tool calls", async () => {
    const decisions = scriptedDecisionFlow([{
        uri: "/",
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.DENIED,
        reason: "recorded root policy",
    }]);
    const runtime = new PolicyRuntime(pathPolicyDao(), decisions.flow);

    const recorded = await runtime.beginToolCall()("/", PolicyAccessType.FS_WRITE);
    assert.equal(recorded.matchedPattern, "/");
    assert.equal(recorded.matchedStatus, PolicyResponse.DENIED);

    const laterResult = await runtime.beginToolCall()("/var/home/example/file.txt", PolicyAccessType.FS_WRITE);
    assert.equal(laterResult.matchedPattern, "/");
    assert.equal(laterResult.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(laterResult.matchedReason, "recorded root policy");
    assert.equal(decisions.callCount(), 1);
});

test("the most-specific path policy wins", () => {
    const parent = path.join(os.tmpdir(), "pi-policy-specificity");
    const child = path.join(parent, "child");
    const logic = new PolicyLogic({
        policies: [
            policy(parent, PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "parent"),
            policy(child, PolicyAccessType.FS_READ, PolicyLifetime.SESSION, PolicyResponse.DENIED, "child"),
        ],
    });

    const result = logic.evaluate(path.join(child, "file.txt"), PolicyAccessType.FS_READ);
    assert.equal(result?.matchedPattern, resolvePhysicalPath(child));
    assert.equal(result?.matchedStatus, PolicyResponse.DENIED);
});

test("path policy matching preserves Linux case sensitivity", () => {
    const parent = path.join(os.tmpdir(), "pi-policy-case-sensitive");
    const upperCasePath = path.join(parent, "Target");
    const lowerCasePath = path.join(parent, "target");
    const logic = new PolicyLogic({
        policies: [
            policy(upperCasePath, PolicyAccessType.FS_WRITE, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "exact case"),
        ],
    });

    assert.equal(logic.evaluate(upperCasePath, PolicyAccessType.FS_WRITE)?.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(logic.evaluate(lowerCasePath, PolicyAccessType.FS_WRITE), null);
});

test("local and global path policies round-trip through SQLite", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-policy-dao-"));
    const database = SqliteDatabase.test(false, path.join(directory, "policies.sqlite"));

    try {
        const target = path.join(directory, "workspace");
        const saved = new PolicyLogic({
            policies: [
                policy(target, PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "local read"),
                policy(target, PolicyAccessType.FS_WRITE, PolicyLifetime.GLOBAL, PolicyResponse.DENIED, "global write"),
                policy(target, PolicyAccessType.FS_WRITE, PolicyLifetime.SESSION, PolicyResponse.DENIED, "session delete"),
            ],
        });
        const dao = new PolicyDao(database);
        dao.initializeSchema();
        dao.upsertPolicies(saved.persistedPolicies());

        const loaded = new PolicyLogic({policies: dao.loadPolicies()});
        assert.equal(loaded.evaluate(target, PolicyAccessType.FS_READ)?.matchedLifetime, PolicyLifetime.LOCAL);
        assert.equal(loaded.evaluate(target, PolicyAccessType.FS_WRITE)?.matchedLifetime, PolicyLifetime.GLOBAL);
        assert.equal(loaded.evaluate(target, PolicyAccessType.FS_WRITE), null);
    } finally {
        database.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("runtime policy ownership follows tool-call, session, and local lifetimes", async () => {
    const target = path.join(os.tmpdir(), "pi-policy-runtime");
    let persisted: Policy[] = [];
    const decisions = scriptedDecisionFlow([
        {
            uri: target,
            accessType: PolicyAccessType.FS_READ,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "once",
        },
        {
            uri: target,
            accessType: PolicyAccessType.FS_READ,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.DENIED,
            reason: "second call",
        },
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.SESSION,
            status: PolicyResponse.DENIED,
            reason: "session",
        },
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.LOCAL,
            status: PolicyResponse.ALLOWED,
            reason: "local",
        },
    ]);
    const runtime = new PolicyRuntime(pathPolicyDao({
        loadPolicies: () => structuredClone(persisted),
        upsertPolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    }), decisions.flow);
    runtime.setDefaultResponse("fs_read", ResponseType.ask_user);
    const firstCall = runtime.beginToolCall();
    const secondCall = runtime.beginToolCall();

    assert.equal((await firstCall(target, PolicyAccessType.FS_READ)).matchedLifetime, PolicyLifetime.ONCE);
    assert.equal((await firstCall(target, PolicyAccessType.FS_READ)).matchedReason, "once");
    assert.equal((await secondCall(target, PolicyAccessType.FS_READ)).matchedReason, "second call");

    assert.equal((await firstCall(target, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.SESSION);
    assert.equal((await secondCall(target, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.SESSION);
    assert.deepEqual(persisted, []);

    assert.equal((await firstCall(target, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.LOCAL);
    assert.equal(decisions.callCount(), 4);

    const nextSessionDecisions = scriptedDecisionFlow([{
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "new session",
    }]);
    const nextSession = new PolicyRuntime(pathPolicyDao({
        loadPolicies: () => structuredClone(persisted),
    }), nextSessionDecisions.flow);
    assert.equal(
        (await nextSession.beginToolCall()(target, PolicyAccessType.FS_WRITE)).matchedLifetime,
        PolicyLifetime.LOCAL,
    );
    assert.equal((await nextSession.beginToolCall()(target, PolicyAccessType.FS_WRITE)).matchedReason, "new session");
});

test("FUSE path approval uses the decision flow manager and records session policy", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-policy-flow-"));
    const target = path.join(workspace, "allowed.txt");
    const promptTitles: string[] = [];
    const ctx = {
        cwd: workspace,
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(title: string, options: string[]): Promise<string | undefined> {
                promptTitles.push(title);
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
    const runtime = new PolicyRuntime(
        pathPolicyDao(),
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
    const reports: string[] = [];
    const authorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        policyEvaluator: runtime.beginToolCall(),
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
        assert.equal(reports.length, 0);
        assert.equal(
            (await runtime.beginToolCall()(target, PolicyAccessType.FS_WRITE)).matchedLifetime,
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
    const runtime = new PolicyRuntime(
        pathPolicyDao(),
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
    const toolCall = runtime.beginToolCall();
    const reports: string[] = [];
    const authorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        policyEvaluator: toolCall,
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
        assert.equal((await toolCall(target, PolicyAccessType.FS_WRITE)).matchedReason, denialReason);
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("the decision flow manager supports TUI allow-once and deny-once shortcuts", async () => {
    type ShortcutApproval = { status: PolicyResponse };
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
                    tui: { requestRender(): void },
                    theme: object,
                    keybindings: object,
                    done: (value: T) => void,
                ) => TestComponent): Promise<T> {
                    return new Promise<T>((resolve) => {
                        const component = factory({
                            requestRender() {
                            }
                        }, {}, {}, resolve);
                        component.handleInput?.(shortcutInputs[index]!);
                    });
                },
            },
        } as unknown as ExtensionContext;
        const statusDecision = {
            type: "select",
            key: "status",
            title: "Path policy decision",
            options: [{title: "Allow", value: PolicyResponse.ALLOWED, next: null}],
        } satisfies UiDecision<ShortcutApproval>;

        const result = await new UiDecisionFlowManager(ctx).runFlow(
            statusDecision,
            {status: statusDecision},
            () => ({status: PolicyResponse.DENIED}),
            {shortcuts: {enabled: true}},
        );

        assert.equal(result, expected[index]);
    }
});

test("a non-interactive path decision fails closed without opening a prompt", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-policy-no-ui-"));
    const target = path.join(workspace, "denied.txt");
    let prompts = 0;
    const ctx = {
        cwd: workspace,
        hasUI: false,
        mode: "print",
        ui: {
            async select(): Promise<string | undefined> {
                prompts++;
                return "Allow";
            },
        },
    } as unknown as ExtensionContext;
    const runtime = new PolicyRuntime(
        pathPolicyDao(),
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
    const toolCall = runtime.beginToolCall();
    const reports: string[] = [];
    const authorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        policyEvaluator: toolCall,
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
        assert.match(reports[0] ?? "", /No uri policy scope selected/);
        assert.equal((await toolCall(target, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.ONCE);
        assert.equal(
            (await runtime.beginToolCall()(target, PolicyAccessType.FS_WRITE)).matchedStatus,
            PolicyResponse.DENIED,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});
