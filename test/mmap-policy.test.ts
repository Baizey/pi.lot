import assert from "node:assert/strict";
import test from "node:test";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {policyScopeHierarchy} from "../src/policy/PolicyScope.js";
import {PolicyAccessType, PolicyArea, PolicyFallbackResponse, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";
import {scriptedPolicyApproval} from "./fixtures/QueuedPolicyApproval.js";

const access = PolicyAccessType.FS_MMAP;
const root = "root";
const directory = "/go-checkout";
const target = `${directory}/test-binary`;

test("one-time mmap approval does not carry forward; local directory grants apply to its files", async (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    const dao = new PolicyDao(db);
    let prompts = 0;
    const create = () => new PolicyRuntime(root, dao, scriptedPolicyApproval((uri, accessType) => {
        assert.equal(accessType, access);
        assert.equal(policyScopeHierarchy(uri, accessType)[0], uri);
        const status = uri === target ? PolicyResponse.ALLOWED : PolicyResponse.DENIED;
        const lifetime = ++prompts === 1 ? PolicyLifetime.ONCE : PolicyLifetime.LOCAL;
        return {uri: lifetime === PolicyLifetime.LOCAL && uri === target ? directory : uri,
            accessType, status, lifetime, reason: "test decision"};
    }));
    const first = create();
    assert.equal((await first.once(root, target, access)).matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(dao.loadPolicies().length, 0);
    assert.equal((await first.once(root, target, access)).matchedLifetime, PolicyLifetime.LOCAL);
    const reopened = create();
    assert.equal((await reopened.once(root, `${directory}/subdir/output`, access)).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(prompts, 2);
    const outside = `${directory}-other/output`;
    assert.equal((await reopened.once(root, outside, access)).matchedStatus, PolicyResponse.DENIED);
    assert.equal(prompts, 3);
    reopened.setDefaultResponse(PolicyArea.fs_mmap, PolicyFallbackResponse.allow);
    assert.equal((await reopened.once(root, outside, access)).matchedStatus, PolicyResponse.DENIED);
    assert.equal(prompts, 3);
});

test("invalid user decisions cannot install a different directory or synchronized mmap grant", async (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    const dao = new PolicyDao(db);
    for (const {uri, lifetime} of [
        {uri: "/other", lifetime: PolicyLifetime.LOCAL},
        {uri: directory, lifetime: PolicyLifetime.GLOBAL},
    ]) {
        const runtime = new PolicyRuntime(root, dao, scriptedPolicyApproval(() => ({
            uri, lifetime, accessType: access, status: PolicyResponse.ALLOWED, reason: "invalid choice",
        })));
        const result = await runtime.once(root, directory, access);
        assert.equal(result.matchedStatus, PolicyResponse.DENIED);
        assert.match(result.matchedReason, /Invalid filesystem approval/);
        assert.deepEqual(dao.loadPolicies(), []);
    }
});

test("mmap ask_llm uses normal path scopes and nonpersistent lifetimes", async (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    const dao = new PolicyDao(db);
    const runtime = new PolicyRuntime(root, dao, scriptedPolicyApproval(() => assert.fail("Unexpected user prompt")));
    runtime.setDefaultResponse(PolicyArea.fs_mmap, PolicyFallbackResponse.ask_llm);
    let choice = PolicyLifetime.LOCAL;
    runtime.setAgentDecisionFlow({async askForPolicy(request) {
        assert.deepEqual(request.allowedScopes, [directory, "/"]);
        assert.deepEqual(request.allowedLifetimes, [PolicyLifetime.ONCE, PolicyLifetime.SESSION]);
        assert.equal(request.toolCall.command, "go build");
        return {uri: request.uri, accessType: request.accessType, lifetime: choice, status: PolicyResponse.ALLOWED, reason: "test decision"};
    }});
    const run = () => runtime.once(root, directory, access, undefined, {toolName: "bash", command: "go build"});
    assert.equal((await run()).matchedStatus, PolicyResponse.DENIED);
    choice = PolicyLifetime.ONCE;
    assert.equal((await run()).matchedStatus, PolicyResponse.ALLOWED);
    assert.deepEqual(dao.loadPolicies(), []);
});
