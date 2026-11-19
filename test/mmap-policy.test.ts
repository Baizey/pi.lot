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

test("one-time mmap approval does not carry forward; local approval survives a new session at the exact cwd", async (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    const dao = new PolicyDao(db);
    let prompts = 0;
    const create = () => new PolicyRuntime(root, dao, scriptedPolicyApproval((uri, accessType) => {
        assert.equal(accessType, access);
        assert.deepEqual(policyScopeHierarchy(uri, accessType), [uri]);
        const status = uri === directory ? PolicyResponse.ALLOWED : PolicyResponse.DENIED;
        const lifetime = ++prompts === 1 ? PolicyLifetime.ONCE : PolicyLifetime.LOCAL;
        return {uri, accessType, status, lifetime, reason: "test decision"};
    }));
    const first = create();
    assert.equal((await first.once(root, directory, access)).matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(dao.loadPolicies().length, 0);
    assert.equal((await first.once(root, directory, access)).matchedLifetime, PolicyLifetime.LOCAL);
    const reopened = create();
    assert.equal((await reopened.once(root, directory, access)).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(prompts, 2);
    assert.equal((await reopened.once(root, directory + "/src", access)).matchedStatus, PolicyResponse.DENIED);
    assert.equal(prompts, 3);
    reopened.setDefaultResponse(PolicyArea.fs_mmap, PolicyFallbackResponse.allow);
    assert.equal((await reopened.once(root, directory + "/src", access)).matchedStatus, PolicyResponse.DENIED);
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
        assert.match(result.matchedReason, /Invalid writable mmap approval/);
        assert.deepEqual(dao.loadPolicies(), []);
    }
});

test("mmap ask_llm allows only an exact scope and nonpersistent lifetimes", async (t) => {
    const db = SqliteDatabase.open(":memory:");
    t.after(() => db.close());
    const dao = new PolicyDao(db);
    const runtime = new PolicyRuntime(root, dao, scriptedPolicyApproval(() => assert.fail("Unexpected user prompt")));
    runtime.setDefaultResponse(PolicyArea.fs_mmap, PolicyFallbackResponse.ask_llm);
    let choice = PolicyLifetime.LOCAL;
    runtime.setAgentDecisionFlow({async askForPolicy(request) {
        assert.deepEqual(request.allowedScopes, [directory]);
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
