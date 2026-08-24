import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {SubagentRuntime} from "../src/subagents/SubagentRuntime.js";

test("subagent runtime owns one coordinator per root session", async () => {
    const runtime = new SubagentRuntime({
        builtins: () => [],
        mcp: () => [],
        delegate: () => [],
    });

    assert.throws(() => runtime.coordinator(), /session is not available/);
    const ctx = {cwd: process.cwd()} as ExtensionContext;
    const policyRuntime = {} as PolicyRuntime;
    await runtime.startSession(ctx, policyRuntime);
    const coordinator = runtime.coordinator();
    assert.ok(coordinator);
    assert.equal(runtime.coordinator(), coordinator);
    await assert.rejects(runtime.startSession(ctx, policyRuntime), /already started/);

    await runtime.stopSession();
    await runtime.stopSession();
    assert.throws(() => runtime.coordinator(), /session is not available/);
});
