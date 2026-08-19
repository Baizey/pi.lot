import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {SubagentRuntime} from "../src/subagents/SubagentRuntime.js";
import type {SubagentChildSessionFactory} from "../src/subagents/types.js";

test("subagent runtime owns one coordinator per root session", async () => {
    const factory: SubagentChildSessionFactory = {
        async create() {
            return {
                async prompt(task) { return `completed: ${task}`; },
                async abort() {},
                dispose() {},
            };
        },
    };
    let coordinatorCreations = 0;
    const runtime = new SubagentRuntime({
        bash: () => [],
        mcp: () => [],
        delegate: () => [],
    }, {
        createCoordinator(_ctx, toolkits) {
            coordinatorCreations++;
            return new SubagentCoordinator(factory, toolkits);
        },
    });

    assert.throws(() => runtime.coordinator(), /session is not available/);
    const ctx = {cwd: process.cwd()} as ExtensionContext;
    await runtime.startSession(ctx);
    assert.equal(coordinatorCreations, 1);
    assert.ok(runtime.coordinator());
    await assert.rejects(runtime.startSession(ctx), /already started/);

    await runtime.stopSession();
    await runtime.stopSession();
    assert.throws(() => runtime.coordinator(), /session is not available/);
});
