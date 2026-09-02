import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PolicyEngine} from "../src/policy/PolicyEngine";
import PolicyRuntime from "../src/policy/PolicyRuntime";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow";
import type {PolicyChoice} from "../src/policy/PolicyDecisionFlow";
import type {Policy} from "../src/policy/types";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyFallbackResponse
} from "../src/policy/types";
import {resolvePhysicalPath} from "../src/policy/path/validation.js";
import {PolicyDao} from "../src/storage/PolicyDao";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import type {UiDecision} from "../src/tui/UiDecisionFlowManager.js";
import {UiDecisionFlowManager, UiFlowShortcut,} from "../src/tui/UiDecisionFlowManager.js";

const TEST_AGENT_IDENTIFIER = "path-policy-test-agent";

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
            [accessType]: PolicyEngine.createStatus(accessType, lifetime, status, reason),
        },
    };
}

function pathPolicyDao(
    overrides: Partial<Pick<PolicyDao, "loadPolicies" | "upsertPolicies" | "deletePolicy">> = {},
): PolicyDao {
    return {
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
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

test("a path and access type identify one policy whose properties can be replaced", () => {
    const target = path.join(os.tmpdir(), "pi-policy-replacement");
    const logic = new PolicyEngine([
        policy(target, PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "initial"),
    ]);

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
    const logic = new PolicyEngine();

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
    const logic = new PolicyEngine([
        policy(target, PolicyAccessType.FS_READ, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "read"),
        policy(target, PolicyAccessType.FS_WRITE, PolicyLifetime.SESSION, PolicyResponse.DENIED, "write"),
    ]);

    logic.removePolicies([{uri: target, accessTypes: [PolicyAccessType.FS_READ]}]);

    assert.equal(logic.evaluate(target, PolicyAccessType.FS_READ), null);
    assert.equal(logic.evaluate(target, PolicyAccessType.FS_WRITE)?.matchedLifetime, PolicyLifetime.SESSION);
});

test("only local and global policies are included in the persisted snapshot", () => {
    const base = path.join(os.tmpdir(), "pi-policy-persistence");
    const logic = new PolicyEngine([
        policy(path.join(base, "once"), PolicyAccessType.FS_READ, PolicyLifetime.ONCE, PolicyResponse.ALLOWED, "once"),
        policy(path.join(base, "session"), PolicyAccessType.FS_READ, PolicyLifetime.SESSION, PolicyResponse.ALLOWED, "session"),
        policy(path.join(base, "local"), PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "local"),
        policy(path.join(base, "global"), PolicyAccessType.FS_READ, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "global"),
    ]);

    const persisted = logic.persistedPolicies();
    assert.deepEqual(
        persisted.map((item) => item.info[PolicyAccessType.FS_READ]?.lifetime),
        [PolicyLifetime.LOCAL, PolicyLifetime.GLOBAL],
    );
});

test("a policy on the filesystem root applies to the root and every descendant", () => {
    const logic = new PolicyEngine([
        policy("/", PolicyAccessType.FS_WRITE, PolicyLifetime.SESSION, PolicyResponse.DENIED, "root policy"),
    ]);

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
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao(), decisions.flow);

    const recorded = await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)("/", PolicyAccessType.FS_WRITE);
    assert.equal(recorded.matchedPattern, "/");
    assert.equal(recorded.matchedStatus, PolicyResponse.DENIED);

    const laterResult = await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(
        "/var/home/example/file.txt",
        PolicyAccessType.FS_WRITE,
    );
    assert.equal(laterResult.matchedPattern, "/");
    assert.equal(laterResult.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(laterResult.matchedReason, "recorded root policy");
    assert.equal(decisions.callCount(), 1);
});

test("the most-specific path policy wins", () => {
    const parent = path.join(os.tmpdir(), "pi-policy-specificity");
    const child = path.join(parent, "child");
    const logic = new PolicyEngine([
        policy(parent, PolicyAccessType.FS_READ, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "parent"),
        policy(child, PolicyAccessType.FS_READ, PolicyLifetime.SESSION, PolicyResponse.DENIED, "child"),
    ]);

    const result = logic.evaluate(path.join(child, "file.txt"), PolicyAccessType.FS_READ);
    assert.equal(result?.matchedPattern, resolvePhysicalPath(child));
    assert.equal(result?.matchedStatus, PolicyResponse.DENIED);
});

test("path policy matching preserves Linux case sensitivity", () => {
    const parent = path.join(os.tmpdir(), "pi-policy-case-sensitive");
    const upperCasePath = path.join(parent, "Target");
    const lowerCasePath = path.join(parent, "target");
    const logic = new PolicyEngine([
        policy(upperCasePath, PolicyAccessType.FS_WRITE, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "exact case"),
    ]);

    assert.equal(logic.evaluate(upperCasePath, PolicyAccessType.FS_WRITE)?.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(logic.evaluate(lowerCasePath, PolicyAccessType.FS_WRITE), null);
});

test("local and global path policies round-trip through SQLite", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-policy-dao-"));
    const database = SqliteDatabase.test(false, path.join(directory, "policies.sqlite"));

    try {
        const persistedTarget = path.join(directory, "persisted-workspace");
        const sessionTarget = path.join(directory, "session-workspace");
        const saved = new PolicyEngine([
            policy(
                persistedTarget,
                PolicyAccessType.FS_READ,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "local read",
            ),
            policy(
                persistedTarget,
                PolicyAccessType.FS_WRITE,
                PolicyLifetime.GLOBAL,
                PolicyResponse.DENIED,
                "global write",
            ),
            policy(
                sessionTarget,
                PolicyAccessType.FS_WRITE,
                PolicyLifetime.SESSION,
                PolicyResponse.DENIED,
                "session write",
            ),
        ]);
        const dao = new PolicyDao(database);
        dao.initializeSchema();
        dao.upsertPolicies(saved.persistedPolicies());

        const loaded = new PolicyEngine(dao.loadPolicies());
        assert.equal(loaded.evaluate(persistedTarget, PolicyAccessType.FS_READ)?.matchedLifetime, PolicyLifetime.LOCAL);
        assert.equal(loaded.evaluate(persistedTarget, PolicyAccessType.FS_WRITE)?.matchedLifetime, PolicyLifetime.GLOBAL);
        assert.equal(loaded.evaluate(sessionTarget, PolicyAccessType.FS_WRITE), null);
    } finally {
        database.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("runtime policy ownership follows tool-call, session, and local lifetimes", async () => {
    const target = path.join(os.tmpdir(), "pi-policy-runtime");
    const sessionTarget = path.join(target, "session");
    const localTarget = path.join(target, "local");
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
            uri: sessionTarget,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.SESSION,
            status: PolicyResponse.DENIED,
            reason: "session",
        },
        {
            uri: localTarget,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.LOCAL,
            status: PolicyResponse.ALLOWED,
            reason: "local",
        },
    ]);
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao({
        loadPolicies: () => structuredClone(persisted),
        upsertPolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    }), decisions.flow);
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.ask_user);
    const firstCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER);
    const secondCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER);

    assert.equal((await firstCall(target, PolicyAccessType.FS_READ)).matchedLifetime, PolicyLifetime.ONCE);
    assert.equal((await firstCall(target, PolicyAccessType.FS_READ)).matchedReason, "once");
    assert.equal((await secondCall(target, PolicyAccessType.FS_READ)).matchedReason, "second call");

    assert.equal((await firstCall(sessionTarget, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.SESSION);
    assert.equal((await secondCall(sessionTarget, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.SESSION);
    assert.deepEqual(persisted, []);

    assert.equal((await firstCall(localTarget, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.LOCAL);
    assert.equal(decisions.callCount(), 4);

    const nextSessionDecisions = scriptedDecisionFlow([{
        uri: sessionTarget,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "new session",
    }]);
    const nextSession = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao({
        loadPolicies: () => structuredClone(persisted),
    }), nextSessionDecisions.flow);
    assert.equal(
        (
            await nextSession.beginToolCall(TEST_AGENT_IDENTIFIER)(localTarget, PolicyAccessType.FS_WRITE)
        ).matchedLifetime,
        PolicyLifetime.LOCAL,
    );
    assert.equal(
        (
            await nextSession.beginToolCall(TEST_AGENT_IDENTIFIER)(sessionTarget, PolicyAccessType.FS_WRITE)
        ).matchedReason,
        "new session",
    );
});

test("explicit root policies override defaults at the same broad scope", async () => {
    const decisions = scriptedDecisionFlow([]);
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao({
        loadPolicies: () => [policy(
            "/",
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.DENIED,
            "explicit root denial",
        )],
    }), decisions.flow);

    const result = await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(
        path.join(os.tmpdir(), "pi-explicit-over-default"),
        PolicyAccessType.FS_READ,
    );

    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.equal(result.matchedReason, "explicit root denial");
    assert.equal(decisions.callCount(), 0);
});

test("root policy defaults and subagent capability snapshots use the same policy areas", async () => {
    const childIdentifier = "path-policy-default-snapshot-child";
    const target = path.join(os.tmpdir(), "pi-policy-default-snapshot");
    const decisions = scriptedDecisionFlow([]);
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao(), decisions.flow);

    runtime.registerPolicyPrincipal(childIdentifier, TEST_AGENT_IDENTIFIER, [PolicyArea.fs_read]);
    const result = await runtime.beginToolCall(childIdentifier)(target, PolicyAccessType.FS_READ);

    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(result.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(result.matchedReason, "Automated fallback");
    assert.equal(decisions.callCount(), 0);
    runtime.removePolicyPrincipal(childIdentifier);
});

test("subagent policy capabilities snapshot complete parent areas without becoming hard ceilings", async () => {
    const inheritedChild = "path-policy-inherited-child";
    const blankChild = "path-policy-blank-child";
    const target = path.join(os.tmpdir(), "pi-policy-agent-snapshot");
    const deniedTarget = path.join(target, "private");
    const laterTarget = path.join(os.tmpdir(), "pi-policy-later-parent-grant");
    const decisions = scriptedDecisionFlow([
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "child acquired write later",
        },
        {
            uri: laterTarget,
            accessType: PolicyAccessType.FS_READ,
            lifetime: PolicyLifetime.SESSION,
            status: PolicyResponse.ALLOWED,
            reason: "parent granted after spawn",
        },
    ]);
    const agentChoices: PolicyChoice[] = [
        {
            uri: target,
            accessType: PolicyAccessType.FS_READ,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "blank child requested read",
        },
        {
            uri: laterTarget,
            accessType: PolicyAccessType.FS_READ,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "snapshot child still requested read",
        },
    ];
    let agentCalls = 0;
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao({
        loadPolicies: () => [
            policy(
                target,
                PolicyAccessType.FS_READ,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "parent read grant",
            ),
            policy(
                deniedTarget,
                PolicyAccessType.FS_READ,
                PolicyLifetime.LOCAL,
                PolicyResponse.DENIED,
                "parent private-path denial",
            ),
        ],
    }), decisions.flow);
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.ask_user);
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            const choice = agentChoices[agentCalls++];
            assert.ok(choice, "Unexpected agent policy decision request");
            assert.equal(choice.accessType, request.accessType);
            return choice;
        },
    });
    runtime.registerPolicyPrincipal(inheritedChild, TEST_AGENT_IDENTIFIER, [PolicyArea.fs_read]);
    runtime.registerPolicyPrincipal(blankChild, TEST_AGENT_IDENTIFIER, []);

    const inheritedRead = await runtime.beginToolCall(inheritedChild)(target, PolicyAccessType.FS_READ);
    assert.equal(inheritedRead.matchedReason, "parent read grant");
    assert.equal(inheritedRead.matchedLifetime, PolicyLifetime.SESSION);
    const inheritedDenial = await runtime.beginToolCall(inheritedChild)(deniedTarget, PolicyAccessType.FS_READ);
    assert.equal(inheritedDenial.matchedReason, "parent private-path denial");
    assert.equal(inheritedDenial.matchedStatus, PolicyResponse.DENIED);

    assert.equal(
        (await runtime.beginToolCall(inheritedChild)(target, PolicyAccessType.FS_WRITE)).matchedReason,
        "child acquired write later",
    );
    assert.equal(
        (await runtime.beginToolCall(blankChild)(target, PolicyAccessType.FS_READ)).matchedReason,
        "blank child requested read",
    );

    assert.equal(
        (await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(laterTarget, PolicyAccessType.FS_READ)).matchedReason,
        "parent granted after spawn",
    );
    assert.equal(
        (await runtime.beginToolCall(inheritedChild)(laterTarget, PolicyAccessType.FS_READ)).matchedReason,
        "snapshot child still requested read",
    );
    assert.equal(decisions.callCount(), 2);
    assert.equal(agentCalls, 2);

    assert.throws(
        () => runtime.registerPolicyPrincipal(inheritedChild, TEST_AGENT_IDENTIFIER, [PolicyArea.fs_read]),
        /already registered/,
    );
    runtime.removePolicyPrincipal(blankChild);
    runtime.removePolicyPrincipal(inheritedChild);
    assert.throws(() => runtime.beginToolCall(inheritedChild), /No agent registered/);
});

test("durable decisions requested by a child remain rooted in the durable root principal", async () => {
    const childIdentifier = "path-policy-durable-child";
    const target = path.join(os.tmpdir(), "pi-policy-child-durable-grant");
    let persisted: Policy[] = [];
    const decisions = scriptedDecisionFlow([{
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.LOCAL,
        status: PolicyResponse.ALLOWED,
        reason: "durable user grant for descendant work",
    }]);
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, pathPolicyDao({
        upsertPolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    }), decisions.flow);
    runtime.registerPolicyPrincipal(childIdentifier, TEST_AGENT_IDENTIFIER, []);

    const firstChildCall = await runtime.beginToolCall(childIdentifier)(target, PolicyAccessType.FS_WRITE);
    const laterChildCall = await runtime.beginToolCall(childIdentifier)(target, PolicyAccessType.FS_WRITE);
    const rootCall = await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(target, PolicyAccessType.FS_WRITE);

    assert.equal(firstChildCall.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(laterChildCall.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(rootCall.matchedLifetime, PolicyLifetime.LOCAL);
    assert.equal(persisted[0]?.info[PolicyAccessType.FS_WRITE]?.lifetime, PolicyLifetime.LOCAL);
    assert.equal(decisions.callCount(), 1);
    runtime.removePolicyPrincipal(childIdentifier);
});

test("policy principals must be removed from the leaves of the authority tree", () => {
    const runtime = new PolicyRuntime(
        TEST_AGENT_IDENTIFIER,
        pathPolicyDao(),
        scriptedDecisionFlow([]).flow,
    );
    runtime.registerPolicyPrincipal("principal-parent", TEST_AGENT_IDENTIFIER, []);
    runtime.registerPolicyPrincipal("principal-child", "principal-parent", []);

    assert.throws(
        () => runtime.removePolicyPrincipal("principal-parent"),
        /still has registered children/,
    );
    runtime.removePolicyPrincipal("principal-child");
    runtime.removePolicyPrincipal("principal-parent");
});

test("path approval uses the decision flow manager and records session policy", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-path-policy-flow-"));
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
        TEST_AGENT_IDENTIFIER,
        pathPolicyDao(),
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );

    try {
        const result = await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(
            target,
            PolicyAccessType.FS_WRITE,
        );

        assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
        assert.equal(promptTitles.length, 3);
        assert.equal(promptTitles.every((title) => title.includes(target)), true);
        assert.equal(
            (
                await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(target, PolicyAccessType.FS_WRITE)
            ).matchedLifetime,
            PolicyLifetime.SESSION,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("queued approvals recheck policies after the preceding decision is installed", async () => {
    const scenarios = [
        {
            name: "an ONCE approval covers only another request in the same tool call",
            lifetime: PolicyLifetime.ONCE,
            sharedToolCall: true,
            expectedPrompts: 1,
        },
        {
            name: "an ONCE approval does not cover a different tool call",
            lifetime: PolicyLifetime.ONCE,
            sharedToolCall: false,
            expectedPrompts: 2,
        },
        {
            name: "a SESSION approval covers a request from a different tool call",
            lifetime: PolicyLifetime.SESSION,
            sharedToolCall: false,
            expectedPrompts: 1,
        },
        {
            name: "a LOCAL approval covers a request from a different tool call",
            lifetime: PolicyLifetime.LOCAL,
            sharedToolCall: false,
            expectedPrompts: 1,
        },
    ] as const;

    for (const scenario of scenarios) {
        const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-queued-policy-flow-"));
        const firstTarget = path.join(workspace, "a.txt");
        const secondTarget = path.join(workspace, "b.txt");
        const approvalRecords: unknown[] = [];
        let scopePrompts = 0;
        let releaseFirstScope!: () => void;
        let markFirstScopeStarted!: () => void;
        const firstScopeStarted = new Promise<void>((resolve) => {
            markFirstScopeStarted = resolve;
        });
        const firstScopeRelease = new Promise<void>((resolve) => {
            releaseFirstScope = resolve;
        });
        const ctx = {
            cwd: workspace,
            hasUI: true,
            mode: "rpc",
            ui: {
                async select(title: string, options: string[]): Promise<string | undefined> {
                    if (title.startsWith("Path policy scope")) {
                        scopePrompts++;
                        if (scopePrompts === 1) {
                            markFirstScopeStarted();
                            await firstScopeRelease;
                        }
                        return options.find((option) => option === workspace);
                    }
                    if (title.startsWith("Path policy decision")) return "Allow";
                    if (title.startsWith("Path policy lifetime")) {
                        if (scenario.lifetime === PolicyLifetime.ONCE) return "Once";
                        if (scenario.lifetime === PolicyLifetime.SESSION) return "This session";
                        return "Always on this computer";
                    }
                    return undefined;
                },
                async input(): Promise<never> {
                    assert.fail("allowing a queued path must not ask for a denial reason");
                },
            },
        } as unknown as ExtensionContext;
        const runtime = new PolicyRuntime(
            TEST_AGENT_IDENTIFIER,
            pathPolicyDao(),
            new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
            undefined,
            undefined,
            {append: (record) => approvalRecords.push(structuredClone(record))},
        );
        const firstToolCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER, {toolCallId: "first"});
        const secondToolCall = scenario.sharedToolCall
            ? firstToolCall
            : runtime.beginToolCall(TEST_AGENT_IDENTIFIER, {toolCallId: "second"});

        try {
            const first = firstToolCall(firstTarget, PolicyAccessType.FS_WRITE);
            await firstScopeStarted;
            const second = secondToolCall(secondTarget, PolicyAccessType.FS_WRITE);
            await new Promise((resolve) => setImmediate(resolve));
            releaseFirstScope();

            const [firstResult, secondResult] = await Promise.all([first, second]);
            assert.equal(firstResult.matchedStatus, PolicyResponse.ALLOWED, scenario.name);
            assert.equal(secondResult.matchedStatus, PolicyResponse.ALLOWED, scenario.name);
            assert.equal(scopePrompts, scenario.expectedPrompts, scenario.name);
            assert.equal(approvalRecords.length, scenario.expectedPrompts, scenario.name);
            assert.equal(
                secondResult.resolutionSource,
                scenario.expectedPrompts === 1
                    ? PolicyResolutionSource.EXISTING_USER_POLICY
                    : PolicyResolutionSource.NEW_USER_DECISION,
                scenario.name,
            );
        } finally {
            rmSync(workspace, {recursive: true, force: true});
        }
    }
});

test("path denial records the optional reason collected by the decision flow", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-path-policy-denial-"));
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
        TEST_AGENT_IDENTIFIER,
        pathPolicyDao(),
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
    const toolCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER);

    try {
        const result = await toolCall(target, PolicyAccessType.FS_WRITE);

        assert.equal(result.matchedStatus, PolicyResponse.DENIED);
        assert.equal(reasonPrompts, 1);
        assert.match(result.toDenyMessage(), new RegExp(denialReason));
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
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-path-policy-no-ui-"));
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
        TEST_AGENT_IDENTIFIER,
        pathPolicyDao(),
        new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)}),
    );
    const toolCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER);

    try {
        const result = await toolCall(target, PolicyAccessType.FS_WRITE);

        assert.equal(result.matchedStatus, PolicyResponse.DENIED);
        assert.equal(prompts, 0);
        assert.match(result.toDenyMessage(), /No uri policy scope selected/);
        assert.equal((await toolCall(target, PolicyAccessType.FS_WRITE)).matchedLifetime, PolicyLifetime.ONCE);
        assert.equal(
            (
                await runtime.beginToolCall(TEST_AGENT_IDENTIFIER)(target, PolicyAccessType.FS_WRITE)
            ).matchedStatus,
            PolicyResponse.DENIED,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});
