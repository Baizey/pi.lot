import assert from "node:assert/strict";
import fs, {mkdirSync, mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {createMemoryPolicyDao} from "./fixtures/MemoryPolicyDao.js";
import {scriptedPolicyApproval} from "./fixtures/QueuedPolicyApproval.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {PolicyApprovalReviewSource} from "../src/policy/AgentPolicyDecisionFlow.js";
import type {PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    type Policy,
} from "../src/policy/types.js";

function rule(pattern: string, accessType: PolicyAccessType, status: PolicyResponse): Policy {
    return {
        pattern,
        info: {
            [accessType]: {
                accessType,
                lifetime: PolicyLifetime.LOCAL,
                status,
                reason: status === PolicyResponse.DENIED ? "Denied exception" : "Authority",
            },
        },
    };
}

function noUserApproval() {
    return {
        async resolveQueuedPolicy() {
            throw new Error("Unexpected user approval");
        },
    };
}

for (const lifetime of [PolicyLifetime.ONCE, PolicyLifetime.SESSION]) {
    test(`network scope delegation cannot remove a narrower ancestor deny (${lifetime})`, async (t) => {
        const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
            rule("api.example.com", PolicyAccessType.HTTP_GET, PolicyResponse.ALLOWED),
            rule("api.example.com/private", PolicyAccessType.HTTP_GET, PolicyResponse.DENIED),
        ])), noUserApproval());
        t.after(() => runtime.beginShutdown());
        runtime.registerPolicyPrincipal("child", "root", []);
        let offered: string[] = [];
        runtime.setAgentDecisionFlow({
            async askForPolicy(request) {
                offered = [...request.allowedScopes];
                const scope = request.allowedScopes.find((value) => value.startsWith("api.example.com/public"));
                assert.ok(scope);
                return {
                    uri: scope,
                    accessType: request.accessType,
                    lifetime,
                    status: PolicyResponse.ALLOWED,
                    reason: "Bound to the public subtree",
                };
            },
        });
        const child = runtime.beginToolCall("child");
        const publicResult = await child("https://api.example.com/public/List", PolicyAccessType.HTTP_GET);
        assert.equal(publicResult.matchedStatus, PolicyResponse.ALLOWED);
        assert.ok(offered.includes("api.example.com"));
        const privateResult = await child("https://api.example.com/private/Secret", PolicyAccessType.HTTP_GET);
        assert.equal(privateResult.matchedStatus, PolicyResponse.DENIED);
        assert.equal(privateResult.matchedReason, "Denied exception");
        assert.equal(
            (await runtime.once("root", "https://api.example.com/private/Secret", PolicyAccessType.HTTP_GET)).matchedStatus,
            PolicyResponse.DENIED,
        );
    });

    test(`a broad scope grant carries the ancestor deny exception (${lifetime})`, async (t) => {
        const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
            rule("api.example.com", PolicyAccessType.GRPC_ACCESS, PolicyResponse.ALLOWED),
            rule("api.example.com/private", PolicyAccessType.GRPC_ACCESS, PolicyResponse.DENIED),
        ])), noUserApproval());
        t.after(() => runtime.beginShutdown());
        runtime.registerPolicyPrincipal("child", "root", []);
        runtime.setAgentDecisionFlow({
            async askForPolicy(request) {
                return {
                    uri: "api.example.com",
                    accessType: request.accessType,
                    lifetime,
                    status: PolicyResponse.ALLOWED,
                    reason: "Attempted to ignore the deny exception",
                };
            },
        });
        const child = runtime.beginToolCall("child");
        const result = await child("https://api.example.com/public/pkg.Service/Call", PolicyAccessType.GRPC_ACCESS);
        assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
        const privateResult = await child("https://api.example.com/private/pkg.Service/Call", PolicyAccessType.GRPC_ACCESS);
        assert.equal(privateResult.matchedStatus, PolicyResponse.DENIED);
        assert.equal(privateResult.matchedReason, "Denied exception");
    });
}

test("filesystem scope delegation cannot remove a narrower ancestor deny", async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pilot-deny-exceptions-"));
    const source = path.join(workspace, "src");
    const privateDirectory = path.join(workspace, "private");
    mkdirSync(source, {recursive: true});
    mkdirSync(privateDirectory, {recursive: true});
    t.after(() => rmSync(workspace, {recursive: true, force: true}));
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
        rule(workspace, PolicyAccessType.FS_READ, PolicyResponse.ALLOWED),
        rule(privateDirectory, PolicyAccessType.FS_READ, PolicyResponse.DENIED),
    ])), noUserApproval());
    t.after(() => runtime.beginShutdown());
    runtime.registerPolicyPrincipal("child", "root", []);
    let offered: string[] = [];
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            offered = [...request.allowedScopes];
            assert.ok(request.allowedScopes.includes(source));
            return {
                uri: source,
                accessType: request.accessType,
                lifetime: PolicyLifetime.SESSION,
                status: PolicyResponse.ALLOWED,
                reason: "Delegated source subtree",
            };
        },
    });
    const child = runtime.beginToolCall("child");
    assert.equal((await child(path.join(source, "file.ts"), PolicyAccessType.FS_READ)).matchedStatus, PolicyResponse.ALLOWED);
    assert.ok(offered.includes(workspace));
    assert.equal(
        (await child(path.join(privateDirectory, "secret.txt"), PolicyAccessType.FS_READ)).matchedStatus,
        PolicyResponse.DENIED,
    );
});

test("an unrelated session approval does not stale a queued request", async (t) => {
    let prompts = 0;
    let releaseFirst!: (choice: PolicyChoice) => void;
    const firstChoice = new Promise<PolicyChoice>((resolve) => {
        releaseFirst = resolve;
    });
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t), scriptedPolicyApproval(async (uri, accessType) => {
        prompts++;
        if (prompts === 1) return firstChoice;
        return {
            uri,
            accessType,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "The queued request still received its own prompt",
        };
    }));
    t.after(() => runtime.beginShutdown());
    runtime.setDefaultResponse(PolicyArea.web_write, PolicyFallbackResponse.ask_user);
    runtime.setDefaultResponse(PolicyArea.web_grpc, PolicyFallbackResponse.ask_user);
    const evaluate = runtime.beginToolCall("root");
    const first = evaluate("https://unrelated.example.com/output", PolicyAccessType.HTTP_POST);
    const second = evaluate("https://api.example.com/pkg.Service/Method", PolicyAccessType.GRPC_ACCESS);
    releaseFirst({
        uri: "unrelated.example.com/output",
        accessType: PolicyAccessType.HTTP_POST,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.ALLOWED,
        reason: "Approve the first unrelated request",
    });
    assert.equal((await first).matchedStatus, PolicyResponse.ALLOWED);
    const result = await second;
    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(prompts, 2);
});

test("an intermediate ancestor's narrower deny is carried into a derived grant", async (t) => {
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
        rule("api.example.com", PolicyAccessType.HTTP_GET, PolicyResponse.ALLOWED),
        rule("api.example.com/private", PolicyAccessType.HTTP_GET, PolicyResponse.DENIED),
    ])), noUserApproval());
    t.after(() => runtime.beginShutdown());
    runtime.registerPolicyPrincipal("parent", "root", [PolicyArea.web_read]);
    runtime.registerPolicyPrincipal("child", "parent", []);
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            return {
                uri: "api.example.com",
                accessType: request.accessType,
                lifetime: PolicyLifetime.SESSION,
                status: PolicyResponse.ALLOWED,
                reason: "Broad delegation through the intermediate principal",
            };
        },
    });
    const child = runtime.beginToolCall("child");
    assert.equal(
        (await child("https://api.example.com/public/List", PolicyAccessType.HTTP_GET)).matchedStatus,
        PolicyResponse.ALLOWED,
    );
    const privateResult = await child("https://api.example.com/private/Secret", PolicyAccessType.HTTP_GET);
    assert.equal(privateResult.matchedStatus, PolicyResponse.DENIED);
    assert.equal(privateResult.matchedReason, "Denied exception");
    assert.equal(
        (await runtime.beginToolCall("parent")("https://api.example.com/private/Secret", PolicyAccessType.HTTP_GET)).matchedStatus,
        PolicyResponse.DENIED,
    );
});

const approvalTargets = [
    {
        name: "network",
        scope: "api.example.com",
        target: (suffix: string) => `https://api.example.com/${suffix}`,
        accessType: PolicyAccessType.HTTP_POST,
        area: PolicyArea.web_write,
    },
    {
        name: "filesystem",
        scope: path.join(os.tmpdir(), "pilot-user-deny-exceptions"),
        target: (suffix: string) => path.join(os.tmpdir(), "pilot-user-deny-exceptions", suffix),
        accessType: PolicyAccessType.FS_WRITE,
        area: PolicyArea.fs_write,
    },
];

for (const {name, scope, target, accessType, area} of approvalTargets) {
    for (const lifetime of [PolicyLifetime.ONCE, PolicyLifetime.SESSION, PolicyLifetime.LOCAL]) {
        test(`queued broad user approval preserves root exceptions (${name}, ${lifetime})`, async (t) => {
            let prompts = 0;
            let releaseDenial!: (choice: PolicyChoice) => void;
            let promptStarted!: () => void;
            const firstPrompt = new Promise<void>((resolve) => { promptStarted = resolve; });
            const denial = new Promise<PolicyChoice>((resolve) => { releaseDenial = resolve; });
            const dao = createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
                rule(`${scope}/private/public`, accessType, PolicyResponse.ALLOWED),
            ]));
            const runtime = new PolicyRuntime("root", dao, scriptedPolicyApproval(async () => {
                prompts++;
                if (prompts === 1) {
                    promptStarted();
                    return denial;
                }
                assert.equal(prompts, 2, "only the queued public request should need another prompt");
                return {
                    uri: scope,
                    accessType,
                    lifetime,
                    status: PolicyResponse.ALLOWED,
                    reason: "Broad user approval",
                };
            }));
            t.after(() => runtime.beginShutdown());
            runtime.setDefaultResponse(area, PolicyFallbackResponse.ask_user);
            runtime.registerPolicyPrincipal("child", "root", []);
            const rootDenial = runtime.once("root", target("private/secret"), accessType);
            await firstPrompt;
            const child = runtime.beginToolCall("child");
            const publicApproval = child(target("public/output"), accessType);
            releaseDenial({
                uri: `${scope}/private`,
                accessType,
                lifetime: PolicyLifetime.SESSION,
                status: PolicyResponse.DENIED,
                reason: "Root private session denial",
            });
            assert.equal((await rootDenial).matchedStatus, PolicyResponse.DENIED);
            const publicResult = await publicApproval;
            assert.equal(publicResult.matchedStatus, PolicyResponse.ALLOWED);
            assert.equal(publicResult.resolutionSource, PolicyResolutionSource.NEW_USER_DECISION);
            assert.equal(prompts, 2);
            const rootPrivate = await runtime.once("root", target("private/secret"), accessType);
            assert.equal(rootPrivate.matchedStatus, PolicyResponse.DENIED);
            assert.equal(rootPrivate.matchedReason, "Root private session denial");
            assert.equal(rootPrivate.matchedLifetime, PolicyLifetime.SESSION);
            const childPrivate = await child(target("private/secret"), accessType);
            assert.equal(childPrivate.matchedStatus, PolicyResponse.DENIED, "the broad grant must carry the root denial");
            assert.equal(childPrivate.matchedReason, "Root private session denial");
            assert.equal((await child(target("private/public/output"), accessType)).matchedStatus, PolicyResponse.ALLOWED);

            // Disable fallback prompting to distinguish a retained grant from another approval.
            runtime.setDefaultResponse(area, PolicyFallbackResponse.deny);
            assert.equal(
                (await runtime.once("child", target("public/another"), accessType)).matchedStatus,
                lifetime === PolicyLifetime.ONCE ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                "ONCE user authority must not leak into a later tool call",
            );
            assert.equal(
                (await runtime.once("root", target("public/another"), accessType)).matchedStatus,
                lifetime === PolicyLifetime.ONCE ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
            );
            assert.equal(
                dao.loadPolicies().some((policy) => policy.info[accessType]?.status === PolicyResponse.DENIED),
                false,
                "a LOCAL broad allow must not persist an inherited SESSION denial",
            );
        });
    }
}

test("ask_llm broad session approval does not copy a child's denial into its allowing ancestors", async (t) => {
    const accessType = PolicyAccessType.HTTP_POST;
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
        rule("api.example.com/private", accessType, PolicyResponse.ALLOWED),
    ])), scriptedPolicyApproval(() => assert.fail("Unexpected user approval")));
    t.after(() => runtime.beginShutdown());
    runtime.setDefaultResponse(PolicyArea.web_write, PolicyFallbackResponse.ask_llm);
    runtime.registerPolicyPrincipal("parent", "root", [PolicyArea.web_write]);
    runtime.registerPolicyPrincipal("child", "parent", []);
    const reviews: PolicyApprovalReviewSource[] = [];
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            reviews.push(request.reviewSource);
            return {
                uri: reviews.length === 1 ? "api.example.com/private" : "api.example.com",
                accessType,
                lifetime: PolicyLifetime.SESSION,
                status: reviews.length === 1 ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                reason: reviews.length === 1 ? "Child-only private denial" : "Public fallback approval",
            };
        },
    });
    const child = runtime.beginToolCall("child");
    assert.equal((await child("https://api.example.com/private/secret", accessType)).matchedStatus, PolicyResponse.DENIED);
    assert.equal((await child("https://api.example.com/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    assert.deepEqual(reviews, [
        PolicyApprovalReviewSource.ANCESTOR_AUTHORITY,
        PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM,
    ]);
    const privateResult = await runtime.once("child", "https://api.example.com/private/secret", accessType);
    assert.equal(privateResult.matchedStatus, PolicyResponse.DENIED);
    assert.equal(privateResult.matchedReason, "Child-only private denial");
    for (const principal of ["parent", "root"]) {
        const result = await runtime.once(principal, "https://api.example.com/private/secret", accessType);
        assert.equal(result.matchedStatus, PolicyResponse.ALLOWED, `${principal} must retain its own authority`);
        assert.equal(result.matchedReason, "Authority");
    }
    assert.equal(reviews.length, 2);
});

for (const lifetime of [PolicyLifetime.ONCE, PolicyLifetime.SESSION]) {
    test(`broad ancestor approval retains alternating deny and allow subtrees (${lifetime})`, async (t) => {
        const accessType = PolicyAccessType.HTTP_POST;
        const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
            rule("api.example.com", accessType, PolicyResponse.ALLOWED),
            rule("api.example.com/private", accessType, PolicyResponse.DENIED),
            rule("api.example.com/private/public", accessType, PolicyResponse.ALLOWED),
            rule("api.example.com/private/public/secret", accessType, PolicyResponse.DENIED),
        ])), scriptedPolicyApproval(() => assert.fail("Unexpected user approval")));
        t.after(() => runtime.beginShutdown());
        runtime.registerPolicyPrincipal("child", "root", []);
        let reviews = 0;
        runtime.setAgentDecisionFlow({
            async askForPolicy(request) {
                reviews++;
                return {
                    uri: "api.example.com",
                    accessType: request.accessType,
                    lifetime,
                    status: PolicyResponse.ALLOWED,
                    reason: "Broad delegated authority",
                };
            },
        });
        const child = runtime.beginToolCall("child");
        assert.equal((await child("https://api.example.com/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
        for (const [suffix, status] of [
            ["private/secret", PolicyResponse.DENIED],
            ["private/public/output", PolicyResponse.ALLOWED],
            ["private/public/secret/key", PolicyResponse.DENIED],
        ] as const) {
            const result = await child(`https://api.example.com/${suffix}`, accessType);
            assert.equal(result.matchedStatus, status, suffix);
        }
        for (const suffix of ["private/secret", "private/public/output", "private/public/secret/key"]) {
            const result = await child(`https://api.example.com/${suffix}`, accessType);
            assert.equal(result.matchedLifetime, lifetime, "inherited exceptions cannot retain durable authority");
        }
        assert.equal(reviews, 1, "all exception subtrees belong to the same approved scope");
        runtime.setAgentDecisionFlow(undefined);
        assert.equal(
            (await runtime.once("child", "https://api.example.com/private/public/output", accessType)).matchedStatus,
            lifetime === PolicyLifetime.ONCE ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
            "the inherited allow exception must not outlive the broad grant",
        );
    });
}

test("ask_llm broad approval retains allow exceptions without root broad authority", async (t) => {
    const accessType = PolicyAccessType.HTTP_POST;
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
        rule("api.example.com/private", accessType, PolicyResponse.DENIED),
        rule("api.example.com/private/public", accessType, PolicyResponse.ALLOWED),
    ])), scriptedPolicyApproval(() => assert.fail("Unexpected user approval")));
    t.after(() => runtime.beginShutdown());
    runtime.setDefaultResponse(PolicyArea.web_write, PolicyFallbackResponse.ask_llm);
    runtime.registerPolicyPrincipal("child", "root", []);
    const reviews: PolicyApprovalReviewSource[] = [];
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            reviews.push(request.reviewSource);
            return {
                uri: "api.example.com",
                accessType,
                lifetime: PolicyLifetime.SESSION,
                status: PolicyResponse.ALLOWED,
                reason: "Broad fallback approval",
            };
        },
    });
    const child = runtime.beginToolCall("child");
    assert.equal((await child("https://api.example.com/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    assert.deepEqual(reviews, [PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM]);
    assert.equal((await child("https://api.example.com/private/secret", accessType)).matchedStatus, PolicyResponse.DENIED);
    assert.equal((await child("https://api.example.com/private/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(reviews.length, 1);
});

test("farther root allow cannot reopen a nearer ancestor's denied subtree", async (t) => {
    const accessType = PolicyAccessType.HTTP_POST;
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
        rule("api.example.com", accessType, PolicyResponse.ALLOWED),
        rule("api.example.com/private/public", accessType, PolicyResponse.ALLOWED),
    ])), scriptedPolicyApproval(() => assert.fail("Unexpected user approval")));
    t.after(() => runtime.beginShutdown());
    runtime.registerPolicyPrincipal("parent", "root", []);
    runtime.registerPolicyPrincipal("child", "parent", []);
    let reviews = 0;
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            reviews++;
            return {
                uri: reviews === 1 ? "api.example.com/private" : "api.example.com",
                accessType: request.accessType,
                lifetime: PolicyLifetime.SESSION,
                status: reviews === 1 ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                reason: reviews === 1 ? "Nearer private denial" : "Root broad delegation",
            };
        },
    });
    assert.equal(
        (await runtime.once("parent", "https://api.example.com/private/secret", accessType)).matchedStatus,
        PolicyResponse.DENIED,
    );
    const child = runtime.beginToolCall("child");
    assert.equal((await child("https://api.example.com/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    const privateResult = await child("https://api.example.com/private/public/output", accessType);
    assert.equal(privateResult.matchedStatus, PolicyResponse.DENIED);
    assert.equal(privateResult.matchedReason, "Nearer private denial");
    assert.equal(
        (await runtime.once("root", "https://api.example.com/private/public/output", accessType)).matchedStatus,
        PolicyResponse.ALLOWED,
    );
    assert.equal(reviews, 2);
});

test("farther root denial does not override a nearer fixed snapshot allow", async (t) => {
    const accessType = PolicyAccessType.HTTP_POST;
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t), scriptedPolicyApproval(() => ({
        uri: "api.example.com/private",
        accessType,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.DENIED,
        reason: "Later root denial",
    })));
    t.after(() => runtime.beginShutdown());
    runtime.setDefaultResponse(PolicyArea.web_write, PolicyFallbackResponse.allow);
    runtime.registerPolicyPrincipal("parent", "root", [PolicyArea.web_write]);
    runtime.setDefaultResponse(PolicyArea.web_write, PolicyFallbackResponse.ask_user);
    // A root decision after the spawn must not mutate the parent's captured broad allow.
    assert.equal(
        (await runtime.once("root", "https://api.example.com/private/secret", accessType)).matchedStatus,
        PolicyResponse.DENIED,
    );
    runtime.registerPolicyPrincipal("child", "parent", []);
    let reviews = 0;
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            reviews++;
            return {
                uri: "api.example.com",
                accessType: request.accessType,
                lifetime: PolicyLifetime.SESSION,
                status: PolicyResponse.ALLOWED,
                reason: "Delegated fixed snapshot",
            };
        },
    });
    const child = runtime.beginToolCall("child");
    assert.equal((await child("https://api.example.com/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal((await child("https://api.example.com/private/secret", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(reviews, 1);
    assert.equal(
        (await runtime.once("parent", "https://api.example.com/private/another", accessType)).matchedStatus,
        PolicyResponse.ALLOWED,
    );
});

test("an existing ONCE denial masks farther allow exceptions during a broad ONCE approval", async (t) => {
    const accessType = PolicyAccessType.HTTP_POST;
    const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
        rule("api.example.com", accessType, PolicyResponse.ALLOWED),
        rule("api.example.com/private/public", accessType, PolicyResponse.ALLOWED),
    ])), noUserApproval());
    t.after(() => runtime.beginShutdown());
    runtime.registerPolicyPrincipal("child", "root", []);
    let reviews = 0;
    runtime.setAgentDecisionFlow({
        async askForPolicy(request) {
            reviews++;
            return {
                uri: reviews === 1 ? "api.example.com/private" : "api.example.com",
                accessType: request.accessType,
                lifetime: PolicyLifetime.ONCE,
                status: reviews === 1 ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
                reason: reviews === 1 ? "Tool-call private denial" : "Broad tool-call approval",
            };
        },
    });
    const child = runtime.beginToolCall("child");
    assert.equal((await child("https://api.example.com/private/secret", accessType)).matchedStatus, PolicyResponse.DENIED);
    assert.equal((await child("https://api.example.com/public/output", accessType)).matchedStatus, PolicyResponse.ALLOWED);
    const privateResult = await child("https://api.example.com/private/public/output", accessType);
    assert.equal(privateResult.matchedStatus, PolicyResponse.DENIED);
    assert.equal(privateResult.matchedReason, "Tool-call private denial");
    assert.equal(privateResult.matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(reviews, 2);
});

for (const lifetime of [PolicyLifetime.ONCE, PolicyLifetime.SESSION]) {
    test(`native filesystem snapshots preserve user approval exceptions (${lifetime})`, async (t) => {
        const accessType = PolicyAccessType.FS_WRITE;
        const scope = path.join(os.tmpdir(), "pilot-native-approval-exceptions");
        const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => dao.upsertPolicies([
            rule(path.join(scope, "private"), accessType, PolicyResponse.DENIED),
            rule(path.join(scope, "private", "public"), accessType, PolicyResponse.ALLOWED),
        ])), scriptedPolicyApproval(() => ({
            uri: scope,
            accessType,
            lifetime,
            status: PolicyResponse.ALLOWED,
            reason: "Native broad user approval",
        })));
        t.after(() => runtime.beginShutdown());
        runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);
        runtime.registerPolicyPrincipal("child", "root", []);
        const view = runtime.beginNativeFilesystemToolCall("child");
        t.after(() => view.close());
        const publicTarget = path.join(scope, "public", "output");
        assert.equal((await view.evaluate(publicTarget, accessType)).result.matchedStatus, PolicyResponse.ALLOWED);
        for (const [suffix, status] of [
            ["private/secret", PolicyResponse.DENIED],
            ["private/public/output", PolicyResponse.ALLOWED],
        ] as const) {
            const result = view.currentPolicyResult(path.join(scope, suffix), accessType);
            assert.equal(result?.matchedStatus, status, suffix);
            assert.equal(result?.matchedLifetime, lifetime);
        }
        const snapshot = lifetime === PolicyLifetime.ONCE ? view.onceSnapshot() : view.baseSnapshot();
        assert.equal(snapshot.layers[0]?.policies.length, 3, "the grant and both exceptions must reach native policy");
        const nextView = runtime.beginNativeFilesystemToolCall("child");
        t.after(() => nextView.close());
        assert.equal(
            nextView.currentPolicyResult(publicTarget, accessType)?.matchedStatus,
            lifetime === PolicyLifetime.ONCE ? undefined : PolicyResponse.ALLOWED,
            "ONCE snapshots must not leak into another native tool call",
        );
    });
}

for (const lifetime of [PolicyLifetime.ONCE, PolicyLifetime.SESSION]) {
    for (const status of [PolicyResponse.ALLOWED, PolicyResponse.DENIED]) {
        test(`stored ${status} exception does not retarget through a replaced symlink (${lifetime})`, async (t) => {
            const accessType = PolicyAccessType.FS_READ;
            const fixture = path.join(os.tmpdir(), `pilot-stored-exception-${lifetime}-${status}`);
            const workspace = path.join(fixture, "workspace");
            const privateDirectory = path.join(workspace, "private");
            const storedPattern = status === PolicyResponse.ALLOWED
                ? path.join(privateDirectory, "public")
                : privateDirectory;
            const outside = path.join(fixture, "outside");
            let replaced = false;
            const originalExists = fs.existsSync;
            const originalRealpath = fs.realpathSync.native;
            const isFixturePath = (target: fs.PathLike): target is string => (
                typeof target === "string" && (target === fixture || target.startsWith(`${fixture}/`))
            );
            // Model a stable directory being replaced by a symlink after policy load.
            // All nonfixture filesystem operations retain their real behavior.
            t.mock.method(fs, "existsSync", (target: fs.PathLike) => (
                isFixturePath(target) ? true : originalExists(target)
            ));
            t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof fs.realpathSync.native>) => {
                const [target] = args;
                if (!isFixturePath(target)) return originalRealpath(...args);
                if (replaced && (target === storedPattern || target.startsWith(`${storedPattern}/`))) {
                    return outside + target.slice(storedPattern.length);
                }
                return target;
            });
            const initial = [
                rule(workspace, accessType, PolicyResponse.ALLOWED),
                rule(privateDirectory, accessType, PolicyResponse.DENIED),
            ];
            if (status === PolicyResponse.ALLOWED) initial.push(rule(storedPattern, accessType, status));
            const runtime = new PolicyRuntime("root", createMemoryPolicyDao(t, (dao) => {
                dao.upsertPolicies(initial);
            }), noUserApproval());
            t.after(() => runtime.beginShutdown());
            runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.deny);
            runtime.registerPolicyPrincipal("child", "root", []);
            let reviews = 0;
            runtime.setAgentDecisionFlow({
                async askForPolicy(request) {
                    reviews++;
                    return {
                        uri: workspace,
                        accessType: request.accessType,
                        lifetime,
                        status: PolicyResponse.ALLOWED,
                        reason: "Workspace-only approval",
                    };
                },
            });

            replaced = true;
            const child = runtime.beginToolCall("child");
            assert.equal((await child(path.join(workspace, "visible"), accessType)).matchedStatus, PolicyResponse.ALLOWED);
            const outsideTarget = path.join(outside, "secret");
            assert.equal((await runtime.once("root", outsideTarget, accessType)).matchedStatus, PolicyResponse.DENIED);
            if (status === PolicyResponse.ALLOWED) {
                assert.equal(
                    (await child(outsideTarget, accessType)).matchedStatus,
                    PolicyResponse.DENIED,
                    "copying a stored allow must not grant the symlink destination outside the approved workspace",
                );
            }

            if (lifetime === PolicyLifetime.SESSION) {
                runtime.registerPolicyPrincipal("grandchild", "child", [PolicyArea.fs_read]);
                const grandchildView = runtime.beginNativeFilesystemToolCall("grandchild");
                t.after(() => grandchildView.close());
                assert.equal(
                    (await runtime.once("grandchild", outsideTarget, accessType)).matchedStatus,
                    PolicyResponse.DENIED,
                    "a nested capability snapshot must not retarget stored allow exceptions either",
                );
                assert.deepEqual(
                    grandchildView.baseSnapshot().layers[0]?.policies.map((policy) => policy.pattern).sort(),
                    initial.map((policy) => policy.pattern).sort(),
                    "inherited native snapshots must retain the original stored pathnames",
                );
            }

            // Restoring the original directory must reveal the same stored rule,
            // not a broad grant whose deny exception moved to the symlink target.
            replaced = false;
            const restoredTarget = path.join(storedPattern, "secret");
            assert.equal((await runtime.once("root", restoredTarget, accessType)).matchedStatus, status);
            const restored = await child(restoredTarget, accessType);
            assert.equal(restored.matchedStatus, status, "the copied exception must retain its original pathname");
            assert.equal(restored.matchedPattern, storedPattern);
            assert.equal(restored.matchedLifetime, lifetime);
            if (lifetime === PolicyLifetime.SESSION) {
                const inherited = await runtime.once("grandchild", restoredTarget, accessType);
                assert.equal(inherited.matchedStatus, status);
                assert.equal(inherited.matchedPattern, storedPattern);
                assert.equal(inherited.matchedLifetime, PolicyLifetime.SESSION);
            }
            assert.equal(reviews, 1, "restored exception authority belongs to the original approval");
        });
    }
}
