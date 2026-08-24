import assert from "node:assert/strict";
import test from "node:test";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import type {PolicyPrincipalRegistry} from "../src/policy/PolicyRuntime.js";
import {PolicyArea} from "../src/policy/types.js";
import {AgentMechanismCapability} from "../src/subagents/AgentCapability.js";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {SubagentToolCatalog} from "../src/subagents/SubagentToolCatalog.js";
import {
    SubagentJobStatus,
    SubagentRunMode,
    type SubagentChildSession,
    type SubagentChildSessionFactory,
    type SubagentRequest,
} from "../src/subagents/types.js";

const bashTool = tool("bash");
const mcpTool = tool("mcp_test");
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
        mode: SubagentRunMode.SYNC,
        capabilities: [],
        cwd: process.cwd(),
        timeoutSeconds: 30,
        ...overrides,
    };
}

test("sync subagents always receive mediated builtins and snapshot selected policy areas", async () => {
    const sessions: FakeSession[] = [];
    const principals = new FakePolicyPrincipals();
    const factory: SubagentChildSessionFactory = {
        async create(childRequest, definitions) {
            assert.equal(principals.active.has(childRequest.agentIdentifier), true);
            const session = new FakeSession(async (task) => `${task}: ${definitions.map((item) => item.name).join(",")}`);
            sessions.push(session);
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), principals);

    const result = await coordinator.spawn(request({capabilities: [PolicyArea.fs_read]}));

    assert.equal(result.job.status, SubagentJobStatus.COMPLETED);
    assert.equal(result.job.output, "inspect the change: bash");
    assert.deepEqual(result.job.capabilities, [PolicyArea.fs_read]);
    assert.deepEqual(principals.registrations[0]?.areas, [PolicyArea.fs_read]);
    assert.equal(result.job.turns, 1);
    assert.equal(sessions[0]?.disposed, true);
    assert.equal(principals.active.size, 0);
    await coordinator.close();
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
        ["bash", "mcp_test"],
        ["bash", "subagent_spawn"],
    ]);
    await coordinator.close();
});

test("async jobs obey the concurrency bound and status waits on state changes", async () => {
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
    const first = await coordinator.spawn(request({mode: SubagentRunMode.ASYNC, role: "first"}));
    const second = await coordinator.spawn(request({mode: SubagentRunMode.ASYNC, role: "second"}));

    assert.equal(coordinator.list([first.job.id])[0]?.status, SubagentJobStatus.RUNNING);
    assert.equal(coordinator.list([second.job.id])[0]?.status, SubagentJobStatus.QUEUED);
    gates[0]?.resolve("first done");
    const settledFirst = await coordinator.status([first.job.id], 2);
    assert.equal(settledFirst[0]?.status, SubagentJobStatus.COMPLETED);
    await waitUntil(() => gates.length === 2);
    gates[1]?.resolve("second done");
    const settledSecond = await coordinator.status([second.job.id], 2);
    assert.equal(settledSecond[0]?.status, SubagentJobStatus.COMPLETED);
    assert.equal(maximumActive, 1);
    await coordinator.close();
});

test("conversation jobs retain one real child session and policy principal across messages", async () => {
    let creations = 0;
    const prompts: string[] = [];
    const principals = new FakePolicyPrincipals();
    const factory: SubagentChildSessionFactory = {
        async create() {
            creations++;
            return new FakeSession(async (task) => {
                prompts.push(task);
                return `answer ${prompts.length}`;
            });
        },
    };
    const coordinator = new SubagentCoordinator(factory, tools(), principals);
    const spawned = await coordinator.spawn(request({mode: SubagentRunMode.CONVERSATION}));
    let [job] = await coordinator.status([spawned.job.id], 2);
    assert.equal(job?.status, SubagentJobStatus.IDLE);
    assert.equal(job?.output, "answer 1");
    assert.equal(principals.active.size, 1);

    coordinator.message(spawned.job.id, "check one more thing");
    [job] = await coordinator.status([spawned.job.id], 2);
    assert.equal(job?.status, SubagentJobStatus.IDLE);
    assert.equal(job?.output, "answer 2");
    assert.equal(job?.turns, 2);
    assert.equal(creations, 1);
    assert.deepEqual(prompts, ["inspect the change", "check one more thing"]);

    const stopped = await coordinator.stop(spawned.job.id);
    assert.equal(stopped.status, SubagentJobStatus.CANCELLED);
    assert.equal(principals.active.size, 0);
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
    const spawned = await coordinator.spawn(request({
        mode: SubagentRunMode.ASYNC,
        timeoutSeconds: 1,
    }));

    const [job] = await coordinator.status([spawned.job.id], 2);

    assert.equal(job?.status, SubagentJobStatus.TIMED_OUT);
    assert.equal(session?.disposed, true);
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
    const first = await coordinator.spawn(request({mode: SubagentRunMode.ASYNC, role: "first"}));
    const second = await coordinator.spawn(request({mode: SubagentRunMode.ASYNC, role: "second"}));
    await waitUntil(() => sessions.length === 2);

    await coordinator.close();

    assert.equal(coordinator.list([first.job.id])[0]?.status, SubagentJobStatus.CANCELLED);
    assert.equal(coordinator.list([second.job.id])[0]?.status, SubagentJobStatus.CANCELLED);
    assert.equal(sessions.every((session) => session.disposed), true);
    assert.equal(principals.active.size, 0);
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
                    mode: SubagentRunMode.ASYNC,
                }));
                siblingJobId = sibling.job.id;
                await waitUntil(() => coordinator.list([siblingJobId])[0]?.status === SubagentJobStatus.RUNNING);
                await coordinator.spawn(request({
                    parentAgentIdentifier: childRequest.agentIdentifier,
                    role: "inspector",
                }));
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

    assert.equal(parent.job.status, SubagentJobStatus.COMPLETED);
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
                return "parent result";
            });
        },
    };
    coordinator = new SubagentCoordinator(factory, tools(), principals);
    const parent = await coordinator.spawn(request({
        role: "parent",
        capabilities: [AgentMechanismCapability.delegate],
    }));
    const nested = coordinator.list([nestedId])[0];

    assert.equal(parent.job.status, SubagentJobStatus.COMPLETED);
    assert.equal(nested?.parentId, parent.job.id);
    assert.equal(nested?.depth, 1);
    assert.equal(nested?.status, SubagentJobStatus.COMPLETED);
    assert.deepEqual(
        principals.registrations.find((registration) => registration.id === nestedId)?.areas,
        [PolicyArea.fs_read],
    );
    await coordinator.close();
});

class FakePolicyPrincipals implements PolicyPrincipalRegistry {
    readonly active = new Set<string>();
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

    removePolicyPrincipal(id: string): void {
        if (!this.active.delete(id)) throw new Error(`unknown principal: ${id}`);
    }
}

class FakeSession implements SubagentChildSession {
    disposed = false;

    constructor(
        private readonly respond: (task: string, signal: AbortSignal) => Promise<string>,
    ) {
    }

    prompt(task: string, signal: AbortSignal): Promise<string> {
        return this.respond(task, signal);
    }

    async abort() {
    }

    dispose(): void {
        this.disposed = true;
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
