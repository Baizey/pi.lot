import assert from "node:assert/strict";
import test from "node:test";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {SubagentToolkitRegistry} from "../src/subagents/SubagentToolkitRegistry.js";
import {
    SubagentJobStatus,
    SubagentRunMode,
    SubagentToolkit,
    type SubagentChildSession,
    type SubagentChildSessionFactory,
    type SubagentRequest,
} from "../src/subagents/types.js";

const bashTool = {
    name: "bash",
    label: "bash",
    description: "test bash",
    parameters: {type: "object", properties: {}},
    async execute() { return {content: [{type: "text", text: "ok"}], details: {}}; },
} as unknown as ToolDefinition<any, any>;

function toolkits(): SubagentToolkitRegistry {
    const registry = new SubagentToolkitRegistry();
    registry.register(SubagentToolkit.BASH, () => [bashTool]);
    registry.register(SubagentToolkit.MCP, () => []);
    registry.register(SubagentToolkit.DELEGATE, () => []);
    return registry;
}

function request(overrides: Partial<SubagentRequest> = {}): SubagentRequest {
    return {
        task: "inspect the change",
        role: "reviewer",
        mode: SubagentRunMode.SYNC,
        toolkits: [],
        cwd: process.cwd(),
        timeoutSeconds: 30,
        ...overrides,
    };
}

test("sync subagents use explicitly resolved tools and dispose after completion", async () => {
    const sessions: FakeSession[] = [];
    const factory: SubagentChildSessionFactory = {
        async create(_request, tools) {
            const session = new FakeSession(async (task) => `${task}: ${tools.map((tool) => tool.name).join(",")}`);
            sessions.push(session);
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, toolkits());

    const result = await coordinator.spawn(request({toolkits: [SubagentToolkit.BASH]}));

    assert.equal(result.job.status, SubagentJobStatus.COMPLETED);
    assert.equal(result.job.output, "inspect the change: bash");
    assert.equal(result.job.turns, 1);
    assert.equal(sessions[0]?.disposed, true);
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
    const coordinator = new SubagentCoordinator(factory, toolkits(), {maxConcurrency: 1});
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

test("conversation jobs retain one real child session across messages", async () => {
    let creations = 0;
    const prompts: string[] = [];
    const factory: SubagentChildSessionFactory = {
        async create() {
            creations++;
            return new FakeSession(async (task) => {
                prompts.push(task);
                return `answer ${prompts.length}`;
            });
        },
    };
    const coordinator = new SubagentCoordinator(factory, toolkits());
    const spawned = await coordinator.spawn(request({mode: SubagentRunMode.CONVERSATION}));
    let [job] = await coordinator.status([spawned.job.id], 2);
    assert.equal(job?.status, SubagentJobStatus.IDLE);
    assert.equal(job?.output, "answer 1");

    coordinator.message(spawned.job.id, "check one more thing");
    [job] = await coordinator.status([spawned.job.id], 2);
    assert.equal(job?.status, SubagentJobStatus.IDLE);
    assert.equal(job?.output, "answer 2");
    assert.equal(job?.turns, 2);
    assert.equal(creations, 1);
    assert.deepEqual(prompts, ["inspect the change", "check one more thing"]);

    const stopped = await coordinator.stop(spawned.job.id);
    assert.equal(stopped.status, SubagentJobStatus.CANCELLED);
    await coordinator.close();
});

test("turn deadlines abort the child and report a timed-out job", async () => {
    let session: FakeSession | undefined;
    const factory: SubagentChildSessionFactory = {
        async create() {
            session = new FakeSession((_task, signal) => abortable(new Promise<string>(() => {}), signal));
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, toolkits());
    const spawned = await coordinator.spawn(request({
        mode: SubagentRunMode.ASYNC,
        timeoutSeconds: 1,
    }));

    const [job] = await coordinator.status([spawned.job.id], 2);

    assert.equal(job?.status, SubagentJobStatus.TIMED_OUT);
    assert.equal(session?.disposed, true);
    await coordinator.close();
});

test("coordinator shutdown aborts all running children before awaiting them", async () => {
    const sessions: FakeSession[] = [];
    const factory: SubagentChildSessionFactory = {
        async create() {
            const session = new FakeSession((_task, signal) => abortable(new Promise<string>(() => {}), signal));
            sessions.push(session);
            return session;
        },
    };
    const coordinator = new SubagentCoordinator(factory, toolkits(), {maxConcurrency: 2});
    const first = await coordinator.spawn(request({mode: SubagentRunMode.ASYNC, role: "first"}));
    const second = await coordinator.spawn(request({mode: SubagentRunMode.ASYNC, role: "second"}));
    await waitUntil(() => sessions.length === 2);

    await coordinator.close();

    assert.equal(coordinator.list([first.job.id])[0]?.status, SubagentJobStatus.CANCELLED);
    assert.equal(coordinator.list([second.job.id])[0]?.status, SubagentJobStatus.CANCELLED);
    assert.equal(sessions.every((session) => session.disposed), true);
});

test("nested delegation enforces the parent toolkit ceiling and records ancestry", async () => {
    let coordinator: SubagentCoordinator;
    let nestedId = "";
    const factory: SubagentChildSessionFactory = {
        async create(childRequest) {
            return new FakeSession(async () => {
                if (childRequest.role !== "parent") return "nested result";
                await assert.rejects(
                    coordinator.spawn(request({
                        role: "denied-child",
                        toolkits: [SubagentToolkit.MCP],
                    })),
                    /parent ceiling: mcp/,
                );
                const nested = await coordinator.spawn(request({role: "child", toolkits: []}));
                nestedId = nested.job.id;
                return "parent result";
            });
        },
    };
    coordinator = new SubagentCoordinator(factory, toolkits());
    const parent = await coordinator.spawn(request({
        role: "parent",
        toolkits: [SubagentToolkit.DELEGATE],
    }));
    const nested = coordinator.list([nestedId])[0];

    assert.equal(parent.job.status, SubagentJobStatus.COMPLETED);
    assert.equal(nested?.parentId, parent.job.id);
    assert.equal(nested?.depth, 1);
    assert.equal(nested?.status, SubagentJobStatus.COMPLETED);
    await coordinator.close();
});

class FakeSession implements SubagentChildSession {
    disposed = false;

    constructor(
        private readonly respond: (task: string, signal: AbortSignal) => Promise<string>,
    ) {}

    prompt(task: string, signal: AbortSignal): Promise<string> {
        return this.respond(task, signal);
    }

    async abort() {}

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
    const promise = new Promise<T>((complete) => { resolve = complete; });
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
