import assert from "node:assert/strict";
import test from "node:test";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import type {PolicyPrincipalRegistry} from "../src/policy/PolicyRuntime.js";
import {PolicyArea} from "../src/policy/types.js";
import {ApprovalWaitScope} from "../src/runtime/ApprovalWaitScope.js";
import {AgentMechanismCapability} from "../src/subagents/AgentCapability.js";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {SubagentToolCatalog} from "../src/subagents/SubagentToolCatalog.js";
import {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "../src/subagents/SubagentReasoning.js";
import {AUTO_SUBAGENT_MODEL} from "../src/subagents/SubagentDefaults.js";
import {
    SubagentJobStatus,
    type SubagentChildSession,
    type SubagentChildSessionFactory,
    type SubagentRequest,
} from "../src/subagents/types.js";

const bashTool = tool("bash");
const mcpTool = tool("mcp__test__echo");
const delegateTool = tool("subagent_spawn");

function tool(name: string): ToolDefinition<any, any> {
    return {
        name,
        label: name,
        description: `test ${name}`,
        parameters: {type: "object", properties: {}},
        async execute() {
            return {content: [{type: "text", text: "ok"}], details: {}};
        },
    } as unknown as ToolDefinition<any, any>;
}

function tools(): SubagentToolCatalog {
    return new SubagentToolCatalog({
        builtins: () => [bashTool],
        mcp: () => [mcpTool],
        delegate: () => [delegateTool],
    });
}

function request(overrides: Partial<SubagentRequest> = {}): SubagentRequest {
    return {
        parentAgentIdentifier: "subagent-coordinator-test-root",
        task: "inspect the change",
        role: "reviewer",
        capabilities: [],
        cwd: process.cwd(),
        timeoutSeconds: 30,
        reasoningSkill: SubagentReasoningSkill.MID,
        reasoningAmount: SubagentReasoningAmount.MID,
        modelPreference: AUTO_SUBAGENT_MODEL,
        ...overrides,
    };
}

test("coordinator rejects unsupported reasoning capabilities before creating a job", async () => {
    const coordinator = new SubagentCoordinator(
        {
            async create() {
                return new FakeSession(async () => "unused");
            },
        },
        tools(),
        new FakePolicyPrincipals(),
    );

    await assert.rejects(
        coordinator.spawn(request({reasoningSkill: "ultra" as SubagentReasoningSkill})),
        /Unsupported subagent reasoning skill: ultra/,
    );
    assert.deepEqual(coordinator.list(), []);
    await coordinator.close();
});

test("coordinator publishes immutable job changes for activity frontends", async () => {
    const coordinator = new SubagentCoordinator(
        {
            async create() {
                return new FakeSession(async () => "observed output");
            },
        },
        tools(),
        new FakePolicyPrincipals(),
    );
    const changes: Array<{kind: string; status?: SubagentJobStatus}> = [];
    const unsubscribe = coordinator.subscribe((change) => {
        changes.push({
            kind: change.kind,
            status: change.kind === "upsert" ? change.job.status : undefined,
        });
    });

    const spawned = await coordinator.spawn(request());
    const [settled] = await coordinator.status([spawned.job.id], 2);

    assert.equal(typeof spawned.job.createdAt, "number");
    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(changes.some((change) => change.status === SubagentJobStatus.QUEUED), true);
    assert.equal(changes.some((change) => change.status === SubagentJobStatus.RUNNING), true);
    assert.equal(changes.some((change) => change.status === SubagentJobStatus.IDLE), true);

    unsubscribe();
    const countAfterUnsubscribe = changes.length;
    await coordinator.message(spawned.job.id, "one more turn");
    await coordinator.status([spawned.job.id], 2);
    assert.equal(changes.length, countAfterUnsubscribe);
    await coordinator.close();
});

test("subagents receive mediated builtins and retain snapshotted policy areas", async () => {
    const sessions: FakeSession[] = [];
    const principals = new FakePolicyPrincipals();
    const factory: SubagentChildSessionFactory = {
        async create(childRequest, definitions) {
            assert.equal(principals.active.has(childRequest.agentIdentifier), true);
            const session = new FakeSession(
                async (task) => `${task}: ${definitions.map((item) => item.name).join(",")}`,
                {
                    model: "provider/resolved-model",
                    thinkingLevel: "medium",
                    source: "test-ranker",
                },
            );
            sessions.push(session);
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), principals);

    const spawned = await coordinator.spawn(request({capabilities: [PolicyArea.fs_read]}));
    const [result] = await coordinator.status([spawned.job.id], 2);

    assert.equal(result?.status, SubagentJobStatus.IDLE);
    assert.equal(result?.output, "inspect the change: bash");
    assert.deepEqual(result?.capabilities, [PolicyArea.fs_read]);
    assert.deepEqual(principals.registrations[0]?.areas, [PolicyArea.fs_read]);
    assert.equal(result?.reasoningSkill, SubagentReasoningSkill.MID);
    assert.equal(result?.reasoningAmount, SubagentReasoningAmount.MID);
    assert.equal(result?.resolvedModel, "provider/resolved-model");
    assert.equal(result?.resolvedThinkingLevel, "medium");
    assert.equal(result?.modelSelectionSource, "test-ranker");
    assert.equal(result?.turns, 1);
    assert.equal(sessions[0]?.disposed, false);
    assert.equal(principals.active.size, 1);
    await coordinator.close();
    assert.equal(sessions[0]?.disposed, true);
    assert.equal(principals.active.size, 0);
});

test("MCP tools are exposed only by the hard MCP capability", async () => {
    const observed: string[][] = [];
    const factory: SubagentChildSessionFactory = {
        async create(_request, definitions) {
            observed.push(definitions.map((definition) => definition.name));
            return new FakeSession(async () => "done");
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), new FakePolicyPrincipals());

    await coordinator.spawn(request());
    await coordinator.spawn(request({capabilities: [AgentMechanismCapability.mcp]}));
    await coordinator.spawn(request({capabilities: [AgentMechanismCapability.delegate]}));

    assert.deepEqual(observed, [
        ["bash"],
        ["bash", "mcp__test__echo"],
        ["bash", "subagent_spawn"],
    ]);
    await coordinator.close();
});

test("jobs obey the concurrency bound and status waits on state changes", async () => {
    const gates: Array<Deferred<string>> = [];
    let active = 0;
    let maximumActive = 0;
    const factory: SubagentChildSessionFactory = {
        async create() {
            const gate = deferred<string>();
            gates.push(gate);
            return new FakeSession(async (_task, signal) => {
                active++;
                maximumActive = Math.max(maximumActive, active);
                try {
                    return await abortable(gate.promise, signal);
                } finally {
                    active--;
                }
            });
        },
    };
    const coordinator = new SubagentCoordinator(
        factory,
        tools(),
        new FakePolicyPrincipals(),
        {maxConcurrency: 1},
    );
    const first = await coordinator.spawn(request({role: "first"}));
    const second = await coordinator.spawn(request({role: "second"}));

    assert.equal(coordinator.list([first.job.id])[0]?.status, SubagentJobStatus.RUNNING);
    assert.equal(coordinator.list([second.job.id])[0]?.status, SubagentJobStatus.QUEUED);
    gates[0]?.resolve("first done");
    const settledFirst = await coordinator.status([first.job.id], 2);
    assert.equal(settledFirst[0]?.status, SubagentJobStatus.IDLE);
    await waitUntil(() => gates.length === 2);
    gates[1]?.resolve("second done");
    const settledSecond = await coordinator.status([second.job.id], 2);
    assert.equal(settledSecond[0]?.status, SubagentJobStatus.IDLE);
    assert.equal(maximumActive, 1);
    await coordinator.close();
});

test("retained conversations keep their session and principal but receive fresh, cleared scopes per turn", async () => {
    let creations = 0;
    const prompts: string[] = [];
    const turnScopes: ApprovalWaitScope[] = [];
    const lateReleases: Array<() => void> = [];
    const principals = new FakePolicyPrincipals();
    const factory: SubagentChildSessionFactory = {
        async create(childRequest) {
            creations++;
            assert.equal(
                principals.approvalWaitScopes.get(childRequest.agentIdentifier),
                ApprovalWaitScope.current(),
            );
            return new FakeSession(async (task) => {
                const scope = ApprovalWaitScope.current();
                assert.ok(scope);
                assert.equal(principals.approvalWaitScopes.get(childRequest.agentIdentifier), scope);
                assert.equal(scope.waiting, false);
                for (const previous of turnScopes) {
                    assert.notEqual(scope, previous);
                    previous.beginWait()();
                    assert.equal(previous.waiting, false);
                    assert.throws(() => previous.setTimeout(() => {}, 10), /closed/);
                }
                turnScopes.push(scope);
                // Turn cleanup must release an outstanding wait, even in a retained session.
                lateReleases.push(scope.beginWait());
                prompts.push(task);
                return `answer ${prompts.length}`;
            });
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), principals);
    const spawned = await coordinator.spawn(request());
    let [job] = await coordinator.status([spawned.job.id], 2);
    assert.equal(job?.status, SubagentJobStatus.IDLE);
    assert.equal(job?.output, "answer 1");
    assert.equal(principals.active.size, 1);
    assert.equal(principals.approvalWaitScopes.size, 0);
    assert.equal(turnScopes[0]?.waiting, false);

    await coordinator.message(spawned.job.id, "check one more thing");
    [job] = await coordinator.status([spawned.job.id], 2);
    assert.equal(job?.status, SubagentJobStatus.IDLE);
    assert.equal(job?.output, "answer 2");
    assert.equal(job?.turns, 2);
    assert.equal(creations, 1);
    assert.deepEqual(prompts, ["inspect the change", "check one more thing"]);
    assert.equal(turnScopes.length, 2);
    assert.equal(principals.approvalWaitScopes.size, 0);
    for (const scope of turnScopes) {
        scope.beginWait()();
        assert.equal(scope.waiting, false);
        assert.throws(() => scope.setTimeout(() => {}, 10), /closed/);
    }
    for (const release of lateReleases) release();

    const stopped = await coordinator.stop(spawned.job.id);
    assert.equal(stopped.status, SubagentJobStatus.CANCELLED);
    assert.equal(principals.active.size, 0);
    await coordinator.close();
});

test("idle follow-ups clear output from the previous task before the next answer", async () => {
    const second = deferred<string>();
    let prompts = 0;
    const coordinator = new SubagentCoordinator(
        {
            async create() {
                return new FakeSession(async (_task, signal) => {
                    prompts++;
                    return prompts === 1 ? "first answer" : abortable(second.promise, signal);
                });
            },
        },
        tools(),
        new FakePolicyPrincipals(),
    );
    const spawned = await coordinator.spawn(request());
    const [first] = await coordinator.status([spawned.job.id], 2);
    assert.equal(first?.status, SubagentJobStatus.IDLE);
    assert.equal(first?.output, "first answer");

    const active = await coordinator.message(spawned.job.id, "second task");
    assert.equal(active.status, SubagentJobStatus.RUNNING);
    assert.equal(active.task, "second task");
    assert.equal(active.output, undefined);
    assert.equal(coordinator.list([spawned.job.id])[0]?.output, undefined);

    second.resolve("second answer");
    const [settled] = await coordinator.status([spawned.job.id], 2);
    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(settled?.output, "second answer");
    await coordinator.close();
});

test("queued follow-ups clear completed output when promoted to the displayed task", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let prompts = 0;
    const coordinator = new SubagentCoordinator(
        {
            async create() {
                return new FakeSession(
                    async (_task, signal) => {
                        prompts++;
                        return abortable(prompts === 1 ? first.promise : second.promise, signal);
                    },
                    undefined,
                    async () => false,
                );
            },
        },
        tools(),
        new FakePolicyPrincipals(),
    );
    const spawned = await coordinator.spawn(request());
    await waitUntil(() => prompts === 1);
    const promoted: Array<{status: SubagentJobStatus; task: string; output?: string}> = [];
    const unsubscribe = coordinator.subscribe((change) => {
        if (change.kind === "upsert" && change.job.task === "second task") {
            promoted.push({
                status: change.job.status,
                task: change.job.task,
                output: change.job.output,
            });
        }
    });

    await coordinator.message(spawned.job.id, "second task");
    first.resolve("first answer");
    await waitUntil(() => prompts === 2);

    assert.equal(promoted.some((job) => (
        job.status === SubagentJobStatus.QUEUED && job.output === undefined
    )), true);
    const active = coordinator.list([spawned.job.id])[0];
    assert.equal(active?.status, SubagentJobStatus.RUNNING);
    assert.equal(active?.task, "second task");
    assert.equal(active?.output, undefined);

    second.resolve("second answer");
    const [settled] = await coordinator.status([spawned.job.id], 2);
    assert.equal(settled?.output, "second answer");
    assert.equal(settled?.turns, 2);
    unsubscribe();
    await coordinator.close();
});

test("idle promotion updates policy context, publishes the queue, then prompts the retained session", async (t) => {
    const events: string[] = [];
    const second = deferred<string>();
    const principals = new FakePolicyPrincipals();
    const updateContext = principals.updatePolicyPrincipalContext.bind(principals);
    t.mock.method(principals, "updatePolicyPrincipalContext", (id: string, context: {task?: string}) => {
        updateContext(id, context);
        events.push(`context:${context.task}`);
    });
    let firstScope: ApprovalWaitScope | undefined;
    const coordinator = new SubagentCoordinator({
        async create() {
            return new FakeSession(async (task, signal) => {
                if (task === "inspect the change") {
                    firstScope = ApprovalWaitScope.current();
                    return "first answer";
                }
                events.push(`prompt:${task}`);
                assert.equal(principals.contextUpdates.at(-1)?.task, task);
                const previousScope = firstScope;
                assert.ok(previousScope);
                assert.throws(() => previousScope.setTimeout(() => {}, 10), /closed/);
                assert.notEqual(ApprovalWaitScope.current(), previousScope);
                return abortable(second.promise, signal);
            });
        },
    }, tools(), principals);
    t.after(() => coordinator.close());
    const spawned = await coordinator.spawn(request());
    const [first] = await coordinator.status([spawned.job.id], 2);
    assert.equal(first?.status, SubagentJobStatus.IDLE);
    assert.equal(first?.finishedAt, undefined);
    coordinator.subscribe((change) => {
        if (change.kind === "upsert" && change.job.status === SubagentJobStatus.QUEUED) {
            events.push(`queued:${change.job.task}`);
        }
    });

    const active = await coordinator.message(spawned.job.id, "second task");
    assert.deepEqual(events, ["context:second task", "queued:second task", "prompt:second task"]);
    assert.equal(active.status, SubagentJobStatus.RUNNING);
    assert.equal(active.finishedAt, undefined);
    assert.equal(active.output, undefined);
    second.resolve("second answer");
    const [settled] = await coordinator.status([spawned.job.id], 2);
    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(settled?.finishedAt, undefined);
    assert.equal(settled?.startedAt, first?.startedAt);
    const stopped = await coordinator.stop(spawned.job.id);
    assert.equal(typeof stopped.finishedAt, "number");
    await assert.rejects(coordinator.message(spawned.job.id, "cannot resume"), /cannot receive a message/);
});

test("automatic promotion cleans the old scope before queue notification and releases its slot in FIFO order", async (t) => {
    const events: string[] = [];
    const first = deferred<string>();
    const peer = deferred<string>();
    const second = deferred<string>();
    const principals = new FakePolicyPrincipals();
    const updateContext = principals.updatePolicyPrincipalContext.bind(principals);
    t.mock.method(principals, "updatePolicyPrincipalContext", (id: string, context: {task?: string}) => {
        updateContext(id, context);
        if (context.task === "second task") events.push("context:second task");
    });
    const setScope = principals.setPolicyApprovalWaitScope.bind(principals);
    let workerId: string;
    let firstScope: ApprovalWaitScope | undefined;
    t.mock.method(principals, "setPolicyApprovalWaitScope", (id: string, scope: ApprovalWaitScope | undefined) => {
        setScope(id, scope);
        if (id === workerId && !scope) events.push("old-scope:detached");
    });
    const coordinator = new SubagentCoordinator({
        async create(childRequest) {
            if (childRequest.role === "peer") {
                return new FakeSession((_task, signal) => {
                    events.push("prompt:peer");
                    return abortable(peer.promise, signal);
                });
            }
            return new FakeSession(async (task, signal) => {
                if (task === "inspect the change") {
                    firstScope = ApprovalWaitScope.current();
                    assert.ok(firstScope);
                    firstScope.beginWait();
                    firstScope.subscribe((waiting) => {
                        if (!waiting) events.push("old-scope:closed");
                    });
                    return abortable(first.promise, signal);
                }
                events.push(`prompt:${task}`);
                assert.equal(principals.contextUpdates.at(-1)?.task, task);
                const previousScope = firstScope;
                assert.ok(previousScope);
                assert.equal(previousScope.waiting, false);
                assert.throws(() => previousScope.setTimeout(() => {}, 10), /closed/);
                assert.notEqual(ApprovalWaitScope.current(), previousScope);
                return abortable(second.promise, signal);
            }, undefined, async () => false);
        },
    }, tools(), principals, {maxConcurrency: 1});
    t.after(() => coordinator.close());
    const spawned = await coordinator.spawn(request());
    workerId = spawned.job.id;
    await waitUntil(() => firstScope !== undefined);
    const waitingPeer = await coordinator.spawn(request({role: "peer"}));
    await coordinator.message(workerId, "second task");
    coordinator.subscribe((change) => {
        if (change.kind === "upsert" && change.job.id === workerId
            && change.job.task === "second task" && change.job.status === SubagentJobStatus.QUEUED) {
            events.push("queued:second task");
        }
    });

    first.resolve("first answer");
    await waitUntil(() => events.includes("prompt:peer"));
    assert.deepEqual(events, [
        "context:second task", "old-scope:closed", "old-scope:detached",
        "queued:second task", "prompt:peer",
    ]);
    const [queued] = coordinator.list([workerId]);
    assert.equal(queued?.status, SubagentJobStatus.QUEUED);
    assert.equal(queued?.finishedAt, undefined);
    assert.equal(queued?.output, undefined);
    assert.equal(queued?.turns, 1);
    peer.resolve("peer answer");
    await coordinator.status([waitingPeer.job.id], 2);
    await waitUntil(() => events.includes("prompt:second task"));
    assert.equal(events.at(-1), "prompt:second task");
    second.resolve("second answer");
    const [settled] = await coordinator.status([workerId], 2);
    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(settled?.finishedAt, undefined);
    assert.equal(settled?.output, "second answer");
    assert.equal(settled?.turns, 2);
    assert.equal(principals.registrations.filter((entry) => entry.id === workerId).length, 1);
});

test("messages sent to a queued job remain ordered conversation turns", async () => {
    const blocker = deferred<string>();
    const prompts: string[] = [];
    const factory: SubagentChildSessionFactory = {
        async create(childRequest) {
            if (childRequest.role === "blocker") {
                return new FakeSession((_task, signal) => abortable(blocker.promise, signal));
            }
            return new FakeSession(async (task) => {
                prompts.push(task);
                return `answered ${task}`;
            });
        },
    };
    const coordinator = new SubagentCoordinator(
        factory,
        tools(),
        new FakePolicyPrincipals(),
        {maxConcurrency: 1},
    );
    const blocking = await coordinator.spawn(request({role: "blocker"}));
    const queued = await coordinator.spawn(request({role: "worker"}));
    assert.equal(queued.job.status, SubagentJobStatus.QUEUED);

    await coordinator.message(queued.job.id, "second turn");
    await coordinator.message(queued.job.id, "third turn");
    blocker.resolve("unblocked");
    await coordinator.status([blocking.job.id], 2);
    const [settled] = await coordinator.status([queued.job.id], 2);

    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(settled?.turns, 3);
    assert.deepEqual(prompts, ["inspect the change", "second turn", "third turn"]);
    await coordinator.close();
});

test("messages steer an actively running conversation without starting another turn", async () => {
    const gate = deferred<string>();
    const prompts: string[] = [];
    const steering: string[] = [];
    const factory: SubagentChildSessionFactory = {
        async create() {
            return new FakeSession(
                async (task, signal) => {
                    prompts.push(task);
                    return abortable(gate.promise, signal);
                },
                undefined,
                async (task) => {
                    steering.push(task);
                    return true;
                },
            );
        },
    };
    const principals = new FakePolicyPrincipals();
    const coordinator = new SubagentCoordinator(factory, tools(), principals);
    const spawned = await coordinator.spawn(request());
    await waitUntil(() => prompts.length === 1);

    const steered = await coordinator.message(spawned.job.id, "focus on the failing test");
    assert.equal(steered.status, SubagentJobStatus.RUNNING);
    assert.equal(steered.latestLine, "Steering message queued");
    assert.deepEqual(steering, ["focus on the failing test"]);
    assert.match(
        principals.contextUpdates.at(-1)?.task ?? "",
        /Current steering: focus on the failing test/,
    );

    gate.resolve("steered answer");
    const [settled] = await coordinator.status([spawned.job.id], 2);
    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(settled?.turns, 1);
    assert.deepEqual(prompts, ["inspect the change"]);
    await coordinator.close();
});

test("a conversation message becomes a follow-up turn when active steering has already settled", async () => {
    const first = deferred<string>();
    const prompts: string[] = [];
    const factory: SubagentChildSessionFactory = {
        async create() {
            return new FakeSession(
                async (task, signal) => {
                    prompts.push(task);
                    return prompts.length === 1 ? abortable(first.promise, signal) : "follow-up answer";
                },
                undefined,
                async () => false,
            );
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), new FakePolicyPrincipals());
    const spawned = await coordinator.spawn(request());
    await waitUntil(() => prompts.length === 1);

    const queued = await coordinator.message(spawned.job.id, "take another turn");
    assert.equal(queued.status, SubagentJobStatus.RUNNING);
    assert.equal(queued.latestLine, "Queued follow-up");

    first.resolve("first answer");
    const [settled] = await coordinator.status([spawned.job.id], 2);
    assert.equal(settled?.status, SubagentJobStatus.IDLE);
    assert.equal(settled?.output, "follow-up answer");
    assert.equal(settled?.turns, 2);
    assert.deepEqual(prompts, ["inspect the change", "take another turn"]);
    await coordinator.close();
});

test("turn deadlines abort the child and report a timed-out job", async () => {
    let session: FakeSession | undefined;
    const factory: SubagentChildSessionFactory = {
        async create() {
            session = new FakeSession((_task, signal) => abortable(new Promise<string>(() => {
            }), signal));
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), new FakePolicyPrincipals());
    const spawned = await coordinator.spawn(request({timeoutSeconds: 1}));

    const [job] = await coordinator.status([spawned.job.id], 2);

    assert.equal(job?.status, SubagentJobStatus.TIMED_OUT);
    assert.equal(session?.disposed, true);
    await coordinator.close();
});

test("timeout abort rejection is contained and reported with job context", async () => {
    const coordinator = new SubagentCoordinator(
        {
            async create() {
                return new FakeSession(
                    (_task, signal) => abortable(new Promise<string>(() => {
                    }), signal),
                    undefined,
                    undefined,
                    async () => {
                        throw new Error("timeout abort failed");
                    },
                );
            },
        },
        tools(),
        new FakePolicyPrincipals(),
    );
    const spawned = await coordinator.spawn(request({timeoutSeconds: 1}));

    const [timedOut] = await coordinator.status([spawned.job.id], 2);

    assert.equal(timedOut?.status, SubagentJobStatus.TIMED_OUT);
    assert.match(timedOut?.error ?? "", /session abort failed: timeout abort failed/);
    assert.match(timedOut?.latestLine ?? "", /session abort failed: timeout abort failed/);
    await coordinator.close();
});

test("abort rejection is contained and reported with job context", async () => {
    const factory: SubagentChildSessionFactory = {
        async create() {
            return new FakeSession(
                (_task, signal) => abortable(new Promise<string>(() => {
                }), signal),
                undefined,
                undefined,
                async () => {
                    throw new Error("transport abort failed");
                },
            );
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), new FakePolicyPrincipals());
    const spawned = await coordinator.spawn(request());
    await waitUntil(() => coordinator.list([spawned.job.id])[0]?.status === SubagentJobStatus.RUNNING);

    const stopped = await coordinator.stop(spawned.job.id);

    assert.equal(stopped.status, SubagentJobStatus.CANCELLED);
    assert.match(stopped.error ?? "", new RegExp(`Subagent job ${spawned.job.id}`));
    assert.match(stopped.error ?? "", /session abort failed: transport abort failed/);
    assert.match(stopped.latestLine ?? "", /session abort failed: transport abort failed/);
    await coordinator.close();
});

test("synchronous cleanup failures are contained and retained on the terminal snapshot", async (t) => {
    let releaseAttempts = 0;
    const principals = new FakePolicyPrincipals();
    t.mock.method(principals, "removePolicyPrincipal", () => {
        releaseAttempts++;
        throw new Error("principal registry unavailable");
    });
    const coordinator = new SubagentCoordinator(
        {
            async create() {
                return new FakeSession(
                    async () => {
                        throw new Error("model failed");
                    },
                    undefined,
                    undefined,
                    undefined,
                    () => {
                        throw new Error("dispose failed");
                    },
                );
            },
        },
        tools(),
        principals,
    );
    const spawned = await coordinator.spawn(request());

    const [failed] = await coordinator.status([spawned.job.id], 2);

    assert.equal(failed?.status, SubagentJobStatus.FAILED);
    assert.match(failed?.error ?? "", /model failed/);
    assert.match(failed?.error ?? "", /session dispose failed: dispose failed/);
    assert.match(failed?.error ?? "", /policy-principal release failed: principal registry unavailable/);
    assert.equal(releaseAttempts >= 1, true);
    assert.equal(principals.approvalWaitScopes.size, 0);
    await coordinator.close();
});

test("coordinator shutdown aborts all running children and releases their principals", async () => {
    const sessions: FakeSession[] = [];
    const principals = new FakePolicyPrincipals();
    const factory: SubagentChildSessionFactory = {
        async create() {
            const session = new FakeSession((_task, signal) => abortable(new Promise<string>(() => {
            }), signal));
            sessions.push(session);
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), principals, {maxConcurrency: 2});
    const first = await coordinator.spawn(request({role: "first"}));
    const second = await coordinator.spawn(request({role: "second"}));
    await waitUntil(() => sessions.length === 2);

    await coordinator.close();

    assert.equal(coordinator.list([first.job.id])[0]?.status, SubagentJobStatus.CANCELLED);
    assert.equal(coordinator.list([second.job.id])[0]?.status, SubagentJobStatus.CANCELLED);
    assert.equal(sessions.every((session) => session.disposed), true);
    assert.equal(principals.active.size, 0);
    assert.equal(principals.approvalWaitScopes.size, 0);
});

test("delegating agents can manage only their own descendants", async () => {
    let coordinator: SubagentCoordinator;
    let parentJobId = "";
    let siblingJobId = "";
    const factory: SubagentChildSessionFactory = {
        async create(childRequest) {
            if (childRequest.role === "sibling") {
                return new FakeSession((_task, signal) => abortable(new Promise<string>(() => {
                }), signal));
            }
            if (childRequest.role === "inspector") {
                return new FakeSession(async () => {
                    assert.throws(() => coordinator.list([siblingJobId]), /outside the invoking agent's descendants/);
                    await assert.rejects(coordinator.stop(parentJobId), /outside the invoking agent's descendants/);
                    return "sibling remained private";
                });
            }
            return new FakeSession(async () => {
                parentJobId = childRequest.agentIdentifier;
                const sibling = await coordinator.spawn(request({
                    parentAgentIdentifier: childRequest.agentIdentifier,
                    role: "sibling",
                }));
                siblingJobId = sibling.job.id;
                await waitUntil(() => coordinator.list([siblingJobId])[0]?.status === SubagentJobStatus.RUNNING);
                const inspector = await coordinator.spawn(request({
                    parentAgentIdentifier: childRequest.agentIdentifier,
                    role: "inspector",
                }));
                await coordinator.status([inspector.job.id], 2);
                await coordinator.stop(siblingJobId);
                return "parent managed descendants";
            });
        },
    };
    coordinator = new SubagentCoordinator(factory, tools(), new FakePolicyPrincipals());
    const parent = await coordinator.spawn(request({
        role: "parent",
        capabilities: [AgentMechanismCapability.delegate],
    }));
    parentJobId = parent.job.id;
    const [settledParent] = await coordinator.status([parent.job.id], 2);

    assert.equal(settledParent?.status, SubagentJobStatus.IDLE);
    assert.equal(coordinator.list([siblingJobId])[0]?.status, SubagentJobStatus.CANCELLED);
    await coordinator.close();
});

test("nested delegation gates mechanisms but may snapshot any policy area the parent currently holds", async () => {
    let coordinator: SubagentCoordinator;
    let nestedId = "";
    const principals = new FakePolicyPrincipals();
    const factory: SubagentChildSessionFactory = {
        async create(childRequest) {
            return new FakeSession(async () => {
                if (childRequest.role !== "parent") return "nested result";
                await assert.rejects(
                    coordinator.spawn(request({
                        parentAgentIdentifier: childRequest.agentIdentifier,
                        role: "denied-child",
                        capabilities: [AgentMechanismCapability.mcp],
                    })),
                    /parent capabilities: mcp/,
                );
                const nested = await coordinator.spawn(request({
                    parentAgentIdentifier: childRequest.agentIdentifier,
                    role: "child",
                    capabilities: [PolicyArea.fs_read],
                }));
                nestedId = nested.job.id;
                assert.deepEqual(coordinator.list().map((job) => job.id), [nestedId]);
                return "parent result";
            });
        },
    };
    coordinator = new SubagentCoordinator(factory, tools(), principals);
    const parent = await coordinator.spawn(request({
        role: "parent",
        capabilities: [AgentMechanismCapability.delegate],
    }));
    const [settledParent] = await coordinator.status([parent.job.id], 2);
    const [nested] = await coordinator.status([nestedId], 2);

    assert.equal(settledParent?.status, SubagentJobStatus.IDLE);
    assert.equal(nested?.parentId, parent.job.id);
    assert.equal(nested?.depth, 1);
    assert.equal(nested?.status, SubagentJobStatus.IDLE);
    assert.deepEqual(
        principals.registrations.find((registration) => registration.id === nestedId)?.areas,
        [PolicyArea.fs_read],
    );
    await coordinator.close();
});

class FakePolicyPrincipals implements PolicyPrincipalRegistry {
    readonly active = new Set<string>();
    readonly approvalWaitScopes = new Map<string, ApprovalWaitScope>();
    readonly contextUpdates: Array<{id: string; task?: string}> = [];
    readonly registrations: Array<{
        id: string;
        parentId: string;
        areas: PolicyArea[];
    }> = [];

    registerPolicyPrincipal(id: string, parentId: string, areas: readonly PolicyArea[]): void {
        if (this.active.has(id)) throw new Error(`duplicate principal: ${id}`);
        this.active.add(id);
        this.registrations.push({id, parentId, areas: [...areas]});
    }

    updatePolicyPrincipalContext(id: string, context: {task?: string}): void {
        this.contextUpdates.push({id, ...context});
    }

    setPolicyApprovalWaitScope(id: string, scope: ApprovalWaitScope | undefined): void {
        if (scope) this.approvalWaitScopes.set(id, scope);
        else this.approvalWaitScopes.delete(id);
    }

    removePolicyPrincipal(id: string): void {
        if (!this.active.delete(id)) throw new Error(`unknown principal: ${id}`);
        this.approvalWaitScopes.delete(id);
    }
}

class FakeSession implements SubagentChildSession {
    disposed = false;

    constructor(
        private readonly respond: (task: string, signal: AbortSignal) => Promise<string>,
        readonly modelSelection?: SubagentChildSession["modelSelection"],
        private readonly steerTask: (task: string) => Promise<boolean> = async () => true,
        private readonly abortSession: () => Promise<void> = async () => undefined,
        private readonly disposeSession: () => void = () => undefined,
    ) {
    }

    prompt(task: string, signal: AbortSignal): Promise<string> {
        return this.respond(task, signal);
    }

    steer(task: string): Promise<boolean> {
        return this.steerTask(task);
    }

    abort(): Promise<void> {
        return this.abortSession();
    }

    dispose(): void {
        this.disposed = true;
        this.disposeSession();
    }
}

type Deferred<T> = {
    promise: Promise<T>;
    resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return {promise, resolve};
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener("abort", abort, {once: true});
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function abortError(): Error {
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
}
