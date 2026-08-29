import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync, symlinkSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {
    PolicyApprovalReviewSource,
    type AgentPolicyApprovalRequest,
    type AgentPolicyDecisionFlow,
    type PolicyApprovalRequestContext,
} from "../src/policy/AgentPolicyDecisionFlow.js";
import {PolicyDecisionFlow, type PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import {PolicyEngine} from "../src/policy/PolicyEngine.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import type {Policy} from "../src/policy/types.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyResult,
} from "../src/policy/types.js";
import {initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {SubagentPolicyDecisionFlow} from "../src/subagents/SubagentPolicyDecisionFlow.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import type {
    SubagentChildSession,
    SubagentChildSessionFactory,
    SubagentSessionRequest,
} from "../src/subagents/types.js";

const ROOT = "approval-test-root";

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

function policyDao(initial: Policy[] = [], persisted?: (policies: Policy[]) => void) {
    return {
        initializeSchema() {
        },
        loadPolicies: () => structuredClone(initial),
        upsertPolicies: (policies: Policy[]) => persisted?.(structuredClone(policies)),
        deletePolicy() {
        },
    };
}

function noUserDecision(): any {
    return {
        async askForPolicy(): Promise<PolicyChoice> {
            assert.fail("The request must not reach the user decision flow");
        },
    };
}

function agentDecisions(
    decide: (request: AgentPolicyApprovalRequest, call: number) => PolicyChoice | Promise<PolicyChoice>,
): {flow: AgentPolicyDecisionFlow; requests: AgentPolicyApprovalRequest[]} {
    const requests: AgentPolicyApprovalRequest[] = [];
    return {
        requests,
        flow: {
            async askForPolicy(request) {
                requests.push(request);
                return decide(request, requests.length);
            },
        },
    };
}

test("the first authorized super-agent reviews a bounded request and session approval reaches its request path", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-approval-session");
    const target = path.join(workspace, "src", "file.ts");
    const approvals = agentDecisions((request) => ({
        uri: workspace,
        accessType: request.accessType,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.ALLOWED,
        reason: "The delegated inspection needs this workspace.",
    }));
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Root workspace authority",
        ),
    ]), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);
    runtime.registerPolicyPrincipal("parent", ROOT, [], {role: "Implementer", task: "Implement the feature"});
    runtime.registerPolicyPrincipal("child", "parent", [], {role: "Reviewer", task: "Review src/file.ts"});

    const result = await runtime.beginToolCall("child", {
        toolCallId: "tool-1",
        toolName: "bash",
        command: "rg TODO src/file.ts",
        purpose: "Inspect outstanding work",
    })(target, PolicyAccessType.FS_READ);

    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(result.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(result.resolutionSource, PolicyResolutionSource.NEW_AGENT_DECISION);
    assert.equal(approvals.requests.length, 1);
    assert.equal(approvals.requests[0]?.reviewSource, PolicyApprovalReviewSource.ANCESTOR_AUTHORITY);
    assert.equal(approvals.requests[0]?.approvingAgentIdentifier, ROOT);
    assert.deepEqual(
        approvals.requests[0]?.ancestry.map(({agentIdentifier, role, task}) => ({agentIdentifier, role, task})),
        [
            {agentIdentifier: ROOT, role: "Root agent", task: "Active root orchestration session"},
            {agentIdentifier: "parent", role: "Implementer", task: "Implement the feature"},
            {agentIdentifier: "child", role: "Reviewer", task: "Review src/file.ts"},
        ],
    );
    assert.equal(approvals.requests[0]?.toolCall.command, "rg TODO src/file.ts");
    assert.deepEqual(
        approvals.requests[0]?.allowedScopes,
        [target, path.dirname(target), workspace],
    );
    assert.deepEqual(
        approvals.requests[0]?.allowedLifetimes,
        [PolicyLifetime.ONCE, PolicyLifetime.SESSION],
    );

    assert.equal(
        (await runtime.beginToolCall("parent")(
            path.join(workspace, "package.json"),
            PolicyAccessType.FS_READ,
        )).matchedReason,
        "The delegated inspection needs this workspace.",
    );
    assert.equal(
        (await runtime.beginToolCall("child")(target, PolicyAccessType.FS_READ)).matchedReason,
        "The delegated inspection needs this workspace.",
    );
    assert.equal(approvals.requests.length, 1);
});

test("network approval scopes use canonical matching and stop at the super-agent authority", async () => {
    const approvals = agentDecisions((request) => ({
        uri: request.allowedScopes[0]!,
        accessType: request.accessType,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "Allow this exact request once.",
    }));
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            "api.example.com",
            PolicyAccessType.HTTP_GET,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "API read authority",
        ),
    ]), noUserDecision());
    runtime.setAgentDecisionFlow(approvals.flow);
    runtime.registerPolicyPrincipal("child", ROOT, []);

    const result = await runtime.beginToolCall("child")(
        "https://api.example.com/v1/users",
        PolicyAccessType.HTTP_GET,
    );

    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.deepEqual(approvals.requests[0]?.allowedScopes, [
        "api.example.com/v1/users/",
        "api.example.com/v1/",
        "api.example.com",
    ]);
});

test("agent approvals are revalidated and an invalid widening fails closed for only the tool call", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-approval-invalid");
    const target = path.join(workspace, "file.ts");
    const approvals = agentDecisions((request) => ({
        uri: "/",
        accessType: request.accessType,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.ALLOWED,
        reason: "Attempted widening",
    }));
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Bounded root authority",
        ),
    ]), noUserDecision());
    runtime.setAgentDecisionFlow(approvals.flow);
    runtime.registerPolicyPrincipal("parent", ROOT, []);
    runtime.registerPolicyPrincipal("child", "parent", []);
    const toolCall = runtime.beginToolCall("child");

    const denied = await toolCall(target, PolicyAccessType.FS_READ);
    assert.equal(denied.matchedStatus, PolicyResponse.DENIED);
    assert.equal(denied.matchedLifetime, PolicyLifetime.ONCE);
    assert.match(denied.matchedReason, /selected scope exceeded/);
    assert.equal(
        (await toolCall(target, PolicyAccessType.FS_READ)).matchedStatus,
        PolicyResponse.DENIED,
    );
    assert.equal(approvals.requests.length, 2);

    await runtime.beginToolCall("parent")(target, PolicyAccessType.FS_READ);
    assert.equal(approvals.requests.length, 3, "invalid approval must not install a parent session rule");
});

test("an approval cannot outlive the requesting principal or its recorded authority path", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-approval-stale");
    const target = path.join(workspace, "file.ts");
    let releaseDecision!: (choice: PolicyChoice) => void;
    const decision = new Promise<PolicyChoice>((resolve) => {
        releaseDecision = resolve;
    });
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Root authority",
        ),
    ]), noUserDecision());
    runtime.setAgentDecisionFlow({async askForPolicy() {
        return decision;
    }});
    runtime.registerPolicyPrincipal("child", ROOT, []);

    const pending = runtime.beginToolCall("child")(target, PolicyAccessType.FS_READ);
    await Promise.resolve();
    runtime.removePolicyPrincipal("child");
    releaseDecision({
        uri: target,
        accessType: PolicyAccessType.FS_READ,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.ALLOWED,
        reason: "Stale approval",
    });
    const result = await pending;

    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.equal(result.matchedLifetime, PolicyLifetime.ONCE);
    assert.match(result.matchedReason, /authority path is no longer active/);
});

test("a pending approval cannot overwrite a newer decision from a nearer super-agent", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-approval-race");
    const firstTarget = path.join(workspace, "first.ts");
    const secondTarget = path.join(workspace, "second.ts");
    let releaseFirst!: (choice: PolicyChoice) => void;
    const firstDecision = new Promise<PolicyChoice>((resolve) => {
        releaseFirst = resolve;
    });
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Root authority",
        ),
    ]), noUserDecision());
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            if (request.requestingAgentIdentifier === "first-child") return firstDecision;
            return {
                uri: workspace,
                accessType: request.accessType,
                lifetime: PolicyLifetime.SESSION,
                status: PolicyResponse.DENIED,
                reason: "Parent path denied by the newer review",
            };
        },
    });
    runtime.registerPolicyPrincipal("parent", ROOT, []);
    runtime.registerPolicyPrincipal("first-child", "parent", []);
    runtime.registerPolicyPrincipal("second-child", "parent", []);

    const pendingFirst = runtime.beginToolCall("first-child")(
        firstTarget,
        PolicyAccessType.FS_READ,
    );
    await Promise.resolve();
    const second = await runtime.beginToolCall("second-child")(
        secondTarget,
        PolicyAccessType.FS_READ,
    );
    releaseFirst({
        uri: workspace,
        accessType: PolicyAccessType.FS_READ,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.ALLOWED,
        reason: "Stale allow",
    });
    const first = await pendingFirst;

    assert.equal(second.matchedStatus, PolicyResponse.DENIED);
    assert.equal(first.matchedStatus, PolicyResponse.DENIED);
    assert.equal(first.matchedReason, "Parent path denied by the newer review");
    assert.equal(
        (await runtime.beginToolCall("parent")(firstTarget, PolicyAccessType.FS_READ)).matchedReason,
        "Parent path denied by the newer review",
    );
});

test("an explicit denial held by an immediate super-agent is terminal", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-approval-denial");
    const privatePath = path.join(workspace, "private");
    const approvals = agentDecisions(() => assert.fail("An explicit denial must not invoke an approval agent"));
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Workspace allow",
        ),
        policy(
            privatePath,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.DENIED,
            "Private files stay private",
        ),
    ]), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);
    runtime.registerPolicyPrincipal("parent", ROOT, [PolicyArea.fs_read]);
    runtime.registerPolicyPrincipal("child", "parent", []);

    const result = await runtime.beginToolCall("child")(
        path.join(privatePath, "secret.txt"),
        PolicyAccessType.FS_READ,
    );

    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.equal(result.matchedReason, "Private files stay private");
    assert.equal(approvals.requests.length, 0);
});

test("a user decision owns the root lifetime while every descendant on the request path gets at most session", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-user-descendant-approval");
    const target = path.join(workspace, "generated.txt");
    let userCalls = 0;
    let userContext: PolicyApprovalRequestContext | undefined;
    let persisted: Policy[] = [];
    const runtime = new PolicyRuntime(ROOT, policyDao([], (policies) => {
        persisted = policies;
    }), {
        async askForPolicy(
            _uri: string,
            accessType: PolicyAccessType,
            _signal?: AbortSignal,
            context?: PolicyApprovalRequestContext,
        ): Promise<PolicyChoice> {
            userCalls++;
            userContext = context;
            return {
                uri: workspace,
                accessType,
                lifetime: PolicyLifetime.LOCAL,
                status: PolicyResponse.ALLOWED,
                reason: "User approved descendant output",
            };
        },
    } as any);
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);
    let reviewerCalls = 0;
    runtime.setAgentDecisionFlow({
        async askForPolicy(): Promise<PolicyChoice> {
            reviewerCalls++;
            assert.fail("ask_user must bypass the installed LLM reviewer");
        },
    });
    runtime.registerPolicyPrincipal("parent", ROOT, []);
    runtime.registerPolicyPrincipal("child", "parent", []);

    const childResult = await runtime.beginToolCall("child", {
        toolCallId: "write-1",
        toolName: "write",
        command: `write ${target}`,
        purpose: "Create generated output",
    })(target, PolicyAccessType.FS_WRITE);
    const parentResult = await runtime.beginToolCall("parent")(target, PolicyAccessType.FS_WRITE);
    const rootResult = await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);

    assert.equal(childResult.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(parentResult.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(rootResult.matchedLifetime, PolicyLifetime.LOCAL);
    assert.equal(persisted[0]?.info[PolicyAccessType.FS_WRITE]?.lifetime, PolicyLifetime.LOCAL);
    assert.deepEqual(userContext?.ancestry.map(({agentIdentifier}) => agentIdentifier), [
        ROOT,
        "parent",
        "child",
    ]);
    assert.equal(userContext?.toolCall.command, `write ${target}`);
    assert.equal(userContext?.toolCall.purpose, "Create generated output");
    assert.equal(userCalls, 1);
    assert.equal(reviewerCalls, 0);
});

test("automated allow and deny defaults bypass both reviewer and user flows", async () => {
    const target = path.join(os.tmpdir(), "pilot-automated-policy-default", "file.ts");
    for (const [fallback, expected] of [
        [PolicyFallbackResponse.allow, PolicyResponse.ALLOWED],
        [PolicyFallbackResponse.deny, PolicyResponse.DENIED],
    ] as const) {
        const runtime = new PolicyRuntime(ROOT, policyDao(), noUserDecision());
        runtime.setAgentDecisionFlow({
            async askForPolicy(): Promise<PolicyChoice> {
                assert.fail(`${fallback} must not invoke the LLM reviewer`);
            },
        });
        runtime.setDefaultResponse(PolicyArea.fs_write, fallback);

        const result = await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);
        assert.equal(result.matchedStatus, expected);
        assert.equal(result.matchedLifetime, PolicyLifetime.SESSION);
        assert.equal(result.resolutionSource, PolicyResolutionSource.SYSTEM);
    }
});

test("ask_llm routes a root policy miss to the bounded reviewer instead of the user", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-default-llm-root");
    const target = path.join(workspace, "generated.txt");
    let persistedPolicies = 0;
    const approvals = agentDecisions((request) => ({
        uri: request.allowedScopes[0]!,
        accessType: request.accessType,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "The requested output is necessary.",
    }));
    const runtime = new PolicyRuntime(
        ROOT,
        policyDao([], () => persistedPolicies++),
        noUserDecision(),
    );
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);

    const result = await runtime.beginToolCall(ROOT, {
        toolCallId: "write-default-llm",
        toolName: "write",
        command: `write ${target}`,
        purpose: "Create the requested output",
    })(target, PolicyAccessType.FS_WRITE);

    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(result.matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(result.resolutionSource, PolicyResolutionSource.NEW_DEFAULT_LLM_DECISION);
    assert.equal(approvals.requests.length, 1);
    const request = approvals.requests[0]!;
    assert.equal(request.reviewSource, PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM);
    assert.equal(request.approvingAgentIdentifier, ROOT);
    assert.deepEqual(request.ancestry.map(({agentIdentifier}) => agentIdentifier), [ROOT]);
    assert.equal(request.toolCall.command, `write ${target}`);
    assert.deepEqual(request.allowedLifetimes, [PolicyLifetime.ONCE, PolicyLifetime.SESSION]);
    assert.equal(request.allowedScopes[0], target);
    assert.equal(request.allowedScopes.includes("/"), true);
    if (request.reviewSource === PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM) {
        assert.equal(request.policyArea, PolicyArea.fs_write);
        assert.equal(request.fallbackRevision, 1);
    }
    assert.equal(persistedPolicies, 0);
});

test("ask_llm session decisions cover the root-to-requester path but not sibling principals", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-default-llm-descendant");
    const target = path.join(workspace, "child.txt");
    const approvals = agentDecisions((request, call) => ({
        uri: call === 1 ? workspace : request.allowedScopes[0]!,
        accessType: request.accessType,
        lifetime: call === 1 ? PolicyLifetime.SESSION : PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: call === 1 ? "Allow this request path for the session." : "Allow the sibling request once.",
    }));
    const runtime = new PolicyRuntime(ROOT, policyDao(), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);
    runtime.registerPolicyPrincipal("parent", ROOT, []);
    runtime.registerPolicyPrincipal("child", "parent", []);
    runtime.registerPolicyPrincipal("sibling", ROOT, []);

    const childResult = await runtime.beginToolCall("child")(target, PolicyAccessType.FS_WRITE);
    assert.equal(childResult.matchedLifetime, PolicyLifetime.SESSION);
    assert.equal(childResult.resolutionSource, PolicyResolutionSource.NEW_DEFAULT_LLM_DECISION);
    assert.equal(approvals.requests[0]?.reviewSource, PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM);
    assert.deepEqual(
        approvals.requests[0]?.ancestry.map(({agentIdentifier}) => agentIdentifier),
        [ROOT, "parent", "child"],
    );

    assert.equal(
        (await runtime.beginToolCall("parent")(target, PolicyAccessType.FS_WRITE)).matchedReason,
        "Allow this request path for the session.",
    );
    assert.equal(
        (await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE)).matchedReason,
        "Allow this request path for the session.",
    );
    assert.equal(approvals.requests.length, 1);

    const siblingResult = await runtime.beginToolCall("sibling")(target, PolicyAccessType.FS_WRITE);
    assert.equal(siblingResult.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(approvals.requests.length, 2);
    assert.equal(approvals.requests[1]?.reviewSource, PolicyApprovalReviewSource.ANCESTOR_AUTHORITY);
});

test("ask_llm fails closed without a reviewer and never falls through to the user", async () => {
    const target = path.join(os.tmpdir(), "pilot-default-llm-unavailable", "file.ts");
    const runtime = new PolicyRuntime(ROOT, policyDao(), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);

    const result = await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);

    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.equal(result.matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(result.resolutionSource, PolicyResolutionSource.SYSTEM);
    assert.match(result.matchedReason, /LLM policy review is unavailable/);
});

test("ask_llm rejects durable and out-of-scope choices without installing or persisting them", async () => {
    const target = path.join(os.tmpdir(), "pilot-default-llm-durable", "file.ts");
    let persistedPolicies = 0;
    const approvals = agentDecisions((request, call) => ({
        uri: call === 1 ? request.allowedScopes[0]! : path.join(os.tmpdir(), "outside-llm-scope"),
        accessType: request.accessType,
        lifetime: call === 1 ? PolicyLifetime.LOCAL : PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: call === 1 ? "Invalid durable model choice" : "Invalid widened model choice",
    }));
    const runtime = new PolicyRuntime(
        ROOT,
        policyDao([], () => persistedPolicies++),
        noUserDecision(),
    );
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);

    const first = await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);
    const second = await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);

    assert.equal(first.matchedStatus, PolicyResponse.DENIED);
    assert.equal(first.matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(first.resolutionSource, PolicyResolutionSource.SYSTEM);
    assert.match(first.matchedReason, /lifetime exceeded/);
    assert.equal(second.matchedStatus, PolicyResponse.DENIED);
    assert.match(second.matchedReason, /scope exceeded/);
    assert.equal(approvals.requests.length, 2);
    assert.equal(persistedPolicies, 0);
});

test("ask_llm decisions are discarded when that area's policy default changes", async () => {
    const target = path.join(os.tmpdir(), "pilot-default-llm-stale", "file.ts");
    let release!: (choice: PolicyChoice) => void;
    const pendingChoice = new Promise<PolicyChoice>((resolve) => {
        release = resolve;
    });
    const approvals = agentDecisions(() => pendingChoice);
    const runtime = new PolicyRuntime(ROOT, policyDao(), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);

    const pending = runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);
    await Promise.resolve();
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.deny);
    release({
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "Stale model allow",
    });

    const stale = await pending;
    const current = await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);
    assert.equal(stale.matchedStatus, PolicyResponse.DENIED);
    assert.equal(stale.resolutionSource, PolicyResolutionSource.SYSTEM);
    assert.match(stale.matchedReason, /changed while review was pending/);
    assert.equal(current.matchedStatus, PolicyResponse.DENIED);
    assert.equal(current.matchedReason, "Automated fallback");
    assert.equal(approvals.requests.length, 1);
});

test("an unrelated policy-default change does not stale an ask_llm review", async () => {
    const target = path.join(os.tmpdir(), "pilot-default-llm-area-revision", "file.ts");
    let release!: (choice: PolicyChoice) => void;
    const pendingChoice = new Promise<PolicyChoice>((resolve) => {
        release = resolve;
    });
    const approvals = agentDecisions(() => pendingChoice);
    const runtime = new PolicyRuntime(ROOT, policyDao(), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);

    const pending = runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE);
    await Promise.resolve();
    runtime.setDefaultResponse(PolicyArea.web_write, PolicyFallbackResponse.deny);
    release({
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "The filesystem review remains current.",
    });

    const result = await pending;
    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(result.resolutionSource, PolicyResolutionSource.NEW_DEFAULT_LLM_DECISION);
    assert.equal(approvals.requests.length, 1);
});

test("concurrent ask_llm ONCE decisions preserve the first tool-call resolution", async () => {
    const target = path.join(os.tmpdir(), "pilot-default-llm-concurrency", "file.ts");
    const releases: Array<(choice: PolicyChoice) => void> = [];
    const approvals = agentDecisions(() => new Promise<PolicyChoice>((resolve) => {
        releases.push(resolve);
    }));
    const runtime = new PolicyRuntime(ROOT, policyDao(), noUserDecision());
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
    runtime.setAgentDecisionFlow(approvals.flow);
    const toolCall = runtime.beginToolCall(ROOT);

    const firstPending = toolCall(target, PolicyAccessType.FS_WRITE);
    const secondPending = toolCall(target, PolicyAccessType.FS_WRITE);
    await Promise.resolve();
    assert.equal(releases.length, 2);
    releases[0]!({
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "First LLM decision allowed the tool call.",
    });
    const first = await firstPending;
    releases[1]!({
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.DENIED,
        reason: "Late conflicting LLM denial.",
    });
    const second = await secondPending;

    assert.equal(first.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(second.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(second.matchedReason, "First LLM decision allowed the tool call.");
    assert.equal(approvals.requests.length, 2);
});

test("an unavailable super-agent reviewer fails closed instead of escalating to the user", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-approval-unavailable");
    const target = path.join(workspace, "file.ts");
    let userCalls = 0;
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Root authority",
        ),
    ]), {
        async askForPolicy(): Promise<PolicyChoice> {
            userCalls++;
            assert.fail("Known super-agent authority must not be bypassed");
        },
    } as any);
    runtime.registerPolicyPrincipal("child", ROOT, []);

    const result = await runtime.beginToolCall("child")(target, PolicyAccessType.FS_READ);

    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.match(result.matchedReason, /review is unavailable/);
    assert.equal(userCalls, 0);
});

test("user policy prompts render ancestry and triggering command context", async () => {
    const target = path.join(os.tmpdir(), "pilot-user-context", "file.ts");
    const titles: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(title: string, options: string[]) {
                titles.push(title);
                if (title.startsWith("Path policy scope")) return options[0];
                if (title.startsWith("Path policy decision")) return "Allow";
                if (title.startsWith("Path policy lifetime")) return "Once";
                return undefined;
            },
        },
    } as unknown as ExtensionContext;
    const flow = new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)});
    const runtime = new PolicyRuntime(
        ROOT,
        policyDao(),
        flow,
        undefined,
        {role: "Root agent", task: "Implement approval routing"},
    );
    runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.ask_user);
    runtime.registerPolicyPrincipal(
        "child",
        ROOT,
        [],
        {role: "Reviewer", task: "Review file.ts"},
    );

    await runtime.beginToolCall("child", {
        toolCallId: "bash-1",
        toolName: "bash",
        command: "rg TODO file.ts",
        purpose: "Inspect outstanding work",
    })(target, PolicyAccessType.FS_READ);

    assert.match(titles[0] ?? "", /Policy request:/);
    assert.match(titles[0] ?? "", /Root agent.*Implement approval routing/);
    assert.match(titles[0] ?? "", /Reviewer.*Review file\.ts/);
    assert.match(titles[0] ?? "", /rg TODO file\.ts/);
    assert.match(titles[0] ?? "", /Inspect outstanding work/);
});

test("filesystem policy containment does not retarget a stored grant after symlink replacement", (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-policy-symlink-retarget-"));
    const grantedPath = path.join(directory, "granted");
    const outsidePath = path.join(directory, "outside");
    try {
        mkdirSync(grantedPath);
        mkdirSync(outsidePath);
        const engine = new PolicyEngine([
            policy(
                grantedPath,
                PolicyAccessType.FS_READ,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "Original directory grant",
            ),
        ]);
        rmSync(grantedPath, {recursive: true});
        try {
            symlinkSync(outsidePath, grantedPath, "dir");
        } catch (error) {
            if (isNodeError(error) && error.code === "EPERM") {
                t.skip("Symlink creation is unavailable in this sandbox");
                return;
            }
            throw error;
        }

        assert.equal(
            engine.evaluate(path.join(grantedPath, "secret.txt"), PolicyAccessType.FS_READ),
            null,
        );
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

test("concurrent ONCE approvals cannot replace a successful tool-call grant with a synthetic denial", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-agent-once-concurrency");
    const target = path.join(workspace, "file.ts");
    let calls = 0;
    const runtime = new PolicyRuntime(ROOT, policyDao([
        policy(
            workspace,
            PolicyAccessType.FS_READ,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "Root authority",
        ),
    ]), noUserDecision());
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            calls++;
            await Promise.resolve();
            return {
                uri: request.uri,
                accessType: request.accessType,
                lifetime: PolicyLifetime.ONCE,
                status: PolicyResponse.ALLOWED,
                reason: "Allow this tool call once",
            };
        },
    });
    runtime.registerPolicyPrincipal("child", ROOT, []);
    const toolCall = runtime.beginToolCall("child");

    const [first, second] = await Promise.all([
        toolCall(target, PolicyAccessType.FS_READ),
        toolCall(target, PolicyAccessType.FS_READ),
    ]);

    assert.equal(first.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(second.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(
        (await toolCall(target, PolicyAccessType.FS_READ)).matchedStatus,
        PolicyResponse.ALLOWED,
    );
    assert.equal(calls, 2);
    assert.equal(
        (await runtime.beginToolCall("child")(target, PolicyAccessType.FS_READ)).matchedStatus,
        PolicyResponse.ALLOWED,
    );
    assert.equal(calls, 3, "a new tool call must not reuse the previous ONCE grant");
});

test("concurrent user ONCE decisions preserve the first tool-call resolution", async () => {
    const workspace = path.join(os.tmpdir(), "pilot-user-once-concurrency");
    const target = path.join(workspace, "file.ts");
    let calls = 0;
    const runtime = new PolicyRuntime(ROOT, policyDao(), {
        async askForPolicy(_uri: string, accessType: PolicyAccessType): Promise<PolicyChoice> {
            const call = ++calls;
            await Promise.resolve();
            return {
                uri: target,
                accessType,
                lifetime: PolicyLifetime.ONCE,
                status: call === 1 ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                reason: call === 1 ? "First decision denied" : "Late decision allowed",
            };
        },
    } as any);
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);
    const toolCall = runtime.beginToolCall(ROOT);

    const [first, second] = await Promise.all([
        toolCall(target, PolicyAccessType.FS_WRITE),
        toolCall(target, PolicyAccessType.FS_WRITE),
    ]);

    assert.equal(first.matchedStatus, PolicyResponse.DENIED);
    assert.equal(second.matchedStatus, PolicyResponse.DENIED);
    assert.equal(
        (await toolCall(target, PolicyAccessType.FS_WRITE)).matchedStatus,
        PolicyResponse.DENIED,
    );
    assert.equal(calls, 2);
    assert.equal(
        (await runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE)).matchedStatus,
        PolicyResponse.ALLOWED,
    );
    assert.equal(calls, 3, "a new tool call must not reuse the previous user ONCE denial");
});

test("the specialized approval subagent can decide only through its bounded structured tool", async () => {
    let createdRequest: SubagentSessionRequest | undefined;
    let createdTools: ToolDefinition<any, any>[] = [];
    let approvalPrompt = "";
    let disposed = false;
    const factory: SubagentChildSessionFactory = {
        async create(request, tools) {
            createdRequest = request;
            createdTools = tools;
            return {
                async prompt(task, signal) {
                    approvalPrompt = task;
                    await tools[0]!.execute(
                        "decision-call",
                        {
                            scope: "/workspace/file.ts",
                            status: PolicyResponse.ALLOWED,
                            lifetime: PolicyLifetime.ONCE,
                            reason: "The exact read is relevant.",
                        },
                        signal,
                        undefined,
                        {} as any,
                    );
                    return "submitted";
                },
                async steer() {
                    return false;
                },
                async abort() {
                },
                dispose() {
                    disposed = true;
                },
            } satisfies SubagentChildSession;
        },
    };
    const flow = new SubagentPolicyDecisionFlow(factory, () => initialSubagentDefaults);
    const request: AgentPolicyApprovalRequest = {
        requestId: "policy-request-1",
        reviewSource: PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM,
        policyArea: PolicyArea.fs_read,
        fallbackRevision: 3,
        requestingAgentIdentifier: "child",
        approvingAgentIdentifier: "parent",
        ancestry: [
            {agentIdentifier: "parent", role: "Implementer", task: "Implement a change"},
            {agentIdentifier: "child", role: "Reviewer", task: "Review the change"},
        ],
        uri: "/workspace/file.ts",
        accessType: PolicyAccessType.FS_READ,
        allowedScopes: ["/workspace/file.ts", "/workspace"],
        allowedLifetimes: [PolicyLifetime.ONCE, PolicyLifetime.SESSION],
        toolCall: {toolName: "read", command: "read /workspace/file.ts"},
    };

    const choice = await flow.askForPolicy(request);

    assert.equal(createdRequest?.parentAgentIdentifier, "parent");
    assert.equal(createdRequest?.role, "Policy approval reviewer");
    assert.match(createdRequest?.systemPrompt ?? "", /ask_llm policy default/);
    assert.match(createdRequest?.systemPrompt ?? "", /indirect execution dependency/);
    assert.match(createdRequest?.systemPrompt ?? "", /cache writes/);
    assert.deepEqual(createdRequest?.capabilities, []);
    assert.deepEqual(createdTools.map((tool) => tool.name), ["policy_decision"]);
    assert.match(approvalPrompt, /POLICY_DEFAULT_ASK_LLM/);
    assert.match(approvalPrompt, /Implementer/);
    assert.match(approvalPrompt, /read \/workspace\/file\.ts/);
    assert.deepEqual(choice, {
        uri: "/workspace/file.ts",
        accessType: PolicyAccessType.FS_READ,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "The exact read is relevant.",
    });
    assert.equal(disposed, true);
    await flow.close();
});

test("approval timeout settles and disposes even when prompt abort never cooperates", async () => {
    let disposed = false;
    const factory: SubagentChildSessionFactory = {
        async create() {
            return {
                prompt() {
                    return new Promise<string>(() => undefined);
                },
                async steer() {
                    return false;
                },
                abort() {
                    return new Promise<void>(() => undefined);
                },
                dispose() {
                    disposed = true;
                },
            } satisfies SubagentChildSession;
        },
    };
    const flow = new SubagentPolicyDecisionFlow(
        factory,
        () => initialSubagentDefaults,
        {timeoutMilliseconds: 10},
    );
    const request: AgentPolicyApprovalRequest = {
        requestId: "policy-timeout-1",
        reviewSource: PolicyApprovalReviewSource.ANCESTOR_AUTHORITY,
        requestingAgentIdentifier: "child",
        approvingAgentIdentifier: "parent",
        ancestry: [
            {agentIdentifier: "parent", role: "Implementer", task: "Implement a change"},
            {agentIdentifier: "child", role: "Reviewer", task: "Review the change"},
        ],
        uri: "/workspace/file.ts",
        accessType: PolicyAccessType.FS_READ,
        authority: PolicyResult.of({
            evaluatedUri: "/workspace/file.ts",
            evaluatedAccessType: PolicyAccessType.FS_READ,
            matchedPattern: "/workspace",
            matchedLifetime: PolicyLifetime.SESSION,
            matchedStatus: PolicyResponse.ALLOWED,
            matchedReason: "Workspace read authority",
            resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
        }),
        allowedScopes: ["/workspace/file.ts", "/workspace"],
        allowedLifetimes: [PolicyLifetime.ONCE, PolicyLifetime.SESSION],
        toolCall: {toolName: "read", command: "read /workspace/file.ts"},
    };

    await assert.rejects(flow.askForPolicy(request), /aborted/);
    assert.equal(disposed, true);
    await flow.close();
});
