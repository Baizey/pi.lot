import assert from "node:assert/strict";
import {AsyncResource} from "node:async_hooks";
import {performance} from "node:perf_hooks";
import test, {type TestContext} from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import {PolicyEngine} from "../src/policy/PolicyEngine.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    type Policy,
    type PolicyResult,
} from "../src/policy/types.js";
import {ApprovalWaitScope} from "../src/runtime/ApprovalWaitScope.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";
import {AgentMechanismCapability} from "../src/subagents/AgentCapability.js";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {AUTO_SUBAGENT_MODEL, initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {SubagentPolicyDecisionFlow} from "../src/subagents/SubagentPolicyDecisionFlow.js";
import {SubagentReasoningAmount, SubagentReasoningSkill} from "../src/subagents/SubagentReasoning.js";
import {SubagentToolCatalog} from "../src/subagents/SubagentToolCatalog.js";
import {
    SubagentJobStatus,
    type SubagentChildSession,
    type SubagentChildSessionFactory,
    type SubagentRequest,
    type SubagentSessionRequest,
} from "../src/subagents/types.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import {UiDecisionFlowQueue} from "../src/tui/UiDecisionFlowQueue.js";

const ROOT = "approval-timeout-root";
const WORKSPACE = "/tmp/pilot-approval-timeouts";
const TARGET = `${WORKSPACE}/first.txt`;
const OTHER_TARGET = `${WORKSPACE}/second.txt`;
const USER_TIMEOUT = 300_000;

// Fake timers do not advance performance.now(), which source budgets use for elapsed time.
class VirtualClock {
    constructor(private readonly context: TestContext) {
        context.mock.timers.enable({apis: ["Date", "setTimeout"], now: 0});
        context.mock.method(performance, "now", () => Date.now());
    }

    async advance(milliseconds: number): Promise<void> {
        this.context.mock.timers.tick(milliseconds);
        await flush();
    }
}

type Dialog = {
    title: string;
    options: string[];
    signal?: AbortSignal;
    answer(value: string | undefined): void;
};

class ApprovalFixture {
    readonly dialogs: Dialog[] = [];
    readonly persisted: Policy[] = [];
    readonly queue = new UiDecisionFlowQueue();
    readonly runtime: PolicyRuntime;

    constructor(context: TestContext, initialPolicies: Policy[] = []) {
        const ui = {
            select: async (title: string, options: string[], config?: {signal?: AbortSignal}) => {
                const answer = deferred<string | undefined>();
                this.dialogs.push({title, options, signal: config?.signal, answer: answer.resolve});
                // Deliberately ignore abort: a late RPC response must never resurrect authority.
                return answer.promise;
            },
        };
        const extensionContext = {hasUI: true, mode: "rpc", ui} as unknown as ExtensionContext;
        const dao: PolicyDaoInterface = {
            initializeSchema() {},
            loadPolicies: () => structuredClone(initialPolicies),
            upsertPolicies: (policies) => this.persisted.push(...structuredClone(policies)),
            deletePolicy() {},
        };
        this.runtime = new PolicyRuntime(ROOT, dao, new PolicyDecisionFlow({
            decisionFlows: new UiDecisionFlowManager(extensionContext, this.queue),
        }));
        this.runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);
        context.after(() => {
            this.runtime.beginShutdown();
            this.queue.close();
            for (const dialog of this.dialogs) dialog.answer(undefined);
        });
    }

    evaluate(target = TARGET, signal?: AbortSignal): Promise<PolicyResult> {
        return this.runtime.beginToolCall(ROOT)(target, PolicyAccessType.FS_WRITE, signal);
    }

    async allow(scope = TARGET, lifetime = "Once"): Promise<void> {
        const first = this.dialogs.at(-1)!;
        assert.match(first.title, /^Path policy scope/);
        assert.ok(first.options.includes(scope));
        first.answer(scope);
        await flush();
        const status = this.dialogs.at(-1)!;
        assert.match(status.title, /^Path policy decision/);
        status.answer("Allow");
        await flush();
        const duration = this.dialogs.at(-1)!;
        assert.match(duration.title, /^Path policy lifetime/);
        duration.answer(lifetime);
        await flush();
    }

    coordinator(
        context: TestContext,
        respond: (request: SubagentSessionRequest, task: string, signal: AbortSignal) => Promise<string>,
    ): SubagentCoordinator {
        const factory: SubagentChildSessionFactory = {
            create: async (request) => new FakeSession((task, signal) => respond(request, task, signal)),
        };
        const catalog = new SubagentToolCatalog({builtins: () => [], mcp: () => [], delegate: () => []});
        const coordinator = new SubagentCoordinator(factory, catalog, this.runtime);
        context.after(() => coordinator.close());
        return coordinator;
    }
}

test("active user approval expires at 300 seconds, aborts only its own signal, and ignores a late allow", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const caller = new AbortController();
    const scope = new ApprovalWaitScope();
    t.after(() => scope.close());
    const pending = observe(scope.run(() => fixture.evaluate(TARGET, caller.signal)));
    await flush();
    assert.equal(scope.waiting, true);
    const dialog = fixture.dialogs[0]!;

    await clock.advance(USER_TIMEOUT - 1);
    assert.equal(pending.settled, false);
    await clock.advance(1);
    assert.equal(pending.settled, true, "an uncooperative UI must not prevent timeout settlement");
    assertFailedClosed(await pending.promise);
    assert.equal(dialog.signal?.aborted, true);
    assert.equal(caller.signal.aborted, false);
    assert.equal(scope.waiting, false);

    dialog.answer(TARGET);
    await flush();
    assert.equal(fixture.dialogs.length, 1, "late responses must not advance aborted prompt steps");
    const fresh = observe(fixture.evaluate());
    await flush();
    assert.equal(fresh.settled, false, "expiry must install neither an allow nor a denial grant");
    assert.equal(fixture.dialogs.length, 2);
    await fixture.allow(TARGET, "Always on this computer");
    assert.equal((await fresh.promise).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(fixture.persisted.length, 1, "only the new, live approval may persist a rule");
});

test("queued user approval has its own entry-time deadline even behind a stuck expired prompt", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const active = observe(fixture.evaluate());
    await flush();
    await clock.advance(50_000);
    const queued = observe(fixture.evaluate(OTHER_TARGET));
    await flush();
    assert.equal(fixture.dialogs.length, 1);

    await clock.advance(250_000);
    assert.equal(active.settled, true);
    assertFailedClosed(await active.promise);
    assert.equal(queued.settled, false);
    await clock.advance(49_999);
    assert.equal(queued.settled, false);
    await clock.advance(1);
    assert.equal(queued.settled, true, "queue residence counts towards this request's 300 seconds");
    assertFailedClosed(await queued.promise);
    fixture.dialogs[0]!.answer(TARGET);
    await flush();
    assert.equal(fixture.dialogs.length, 1, "expired queued work must never open a redundant prompt");
    assert.equal(fixture.persisted.length, 0);
    const fresh = observe(fixture.evaluate(OTHER_TARGET));
    await flush();
    assert.equal(fresh.settled, false);
    assert.equal(fixture.dialogs.length, 2);
    await fixture.allow(OTHER_TARGET);
    assert.equal((await fresh.promise).matchedStatus, PolicyResponse.ALLOWED);
});

test("user prompt steps share one budget and a late lifetime selection cannot install a grant", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const pending = observe(fixture.evaluate());
    await flush();
    await clock.advance(100_000);
    fixture.dialogs.at(-1)!.answer(TARGET);
    await flush();
    await clock.advance(100_000);
    fixture.dialogs.at(-1)!.answer("Allow");
    await flush();
    const lifetime = fixture.dialogs.at(-1)!;
    assert.match(lifetime.title, /^Path policy lifetime/);
    await clock.advance(99_999);
    assert.equal(pending.settled, false);
    await clock.advance(1);
    assert.equal(pending.settled, true, "each prompt step must not reset the watchdog");
    assertFailedClosed(await pending.promise);
    lifetime.answer("Always on this computer");
    await flush();
    assert.equal(fixture.persisted.length, 0);
    const fresh = observe(fixture.evaluate());
    await flush();
    assert.equal(fresh.settled, false);
    await fixture.allow();
    assert.equal((await fresh.promise).matchedStatus, PolicyResponse.ALLOWED);
});

test("a queued request opening later receives only its remaining approval budget", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const first = observe(fixture.evaluate());
    await flush();
    await clock.advance(50_000);
    const second = observe(fixture.evaluate(OTHER_TARGET));
    await flush();
    await clock.advance(150_000);
    await fixture.allow();
    assert.equal((await first.promise).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(fixture.dialogs.length, 4);
    assert.match(fixture.dialogs.at(-1)!.title, /^Path policy scope/);
    await clock.advance(149_999);
    assert.equal(second.settled, false);
    await clock.advance(1);
    assert.equal(second.settled, true);
    assertFailedClosed(await second.promise);
});

test("a covering session grant supersedes queued review without another prompt", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const scope = new ApprovalWaitScope();
    t.after(() => scope.close());
    let sourceExpired = false;
    scope.setTimeout(() => sourceExpired = true, 10_000);
    const first = observe(scope.run(() => fixture.evaluate()));
    const second = observe(scope.run(() => fixture.evaluate(OTHER_TARGET)));
    await flush();
    await clock.advance(200_000);
    assert.equal(sourceExpired, false);
    await fixture.allow(WORKSPACE, "This session");
    assert.equal((await first.promise).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal((await second.promise).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(fixture.dialogs.length, 3, "the queue must recheck authority before opening the next scope step");
    assert.equal(scope.waiting, false);
    await clock.advance(9_999);
    assert.equal(sourceExpired, false);
    await clock.advance(1);
    assert.equal(sourceExpired, true);
});

test("tool-call evaluators capture the source scope and overlapping approvals resume only after the last wait", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const scope = new ApprovalWaitScope();
    t.after(() => scope.close());
    let expired = false;
    scope.setTimeout(() => expired = true, 10_000);
    await clock.advance(2_000);
    const evaluator = scope.run(() => fixture.runtime.beginToolCall(ROOT));
    // Invoke outside run(): policy callbacks can arrive after the original async context is gone.
    const first = observe(evaluator(TARGET, PolicyAccessType.FS_WRITE));
    const second = observe(evaluator(OTHER_TARGET, PolicyAccessType.FS_WRITE));
    await flush();
    assert.equal(scope.waiting, true);
    await clock.advance(100_000);
    await fixture.allow();
    assert.equal((await first.promise).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(second.settled, false);
    assert.equal(scope.waiting, true);
    await clock.advance(100_000);
    assert.equal(expired, false, "finishing one of two approvals must not resume the source clock");
    await fixture.allow(OTHER_TARGET);
    assert.equal((await second.promise).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(scope.waiting, false);
    assert.equal((await evaluator(TARGET, PolicyAccessType.FS_WRITE)).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(fixture.dialogs.length, 6, "an existing ONCE grant is not another approval wait");
    await clock.advance(7_999);
    assert.equal(expired, false);
    await clock.advance(1);
    assert.equal(expired, true, "approval time must not replenish the two seconds already consumed");
});

test("native policy views capture their own child scope for callbacks outside the originating async context", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const source = new ApprovalWaitScope();
    t.after(() => source.close());
    let sourceExpired = false;
    let viewExpired = false;
    source.setTimeout(() => sourceExpired = true, 10_000);
    await clock.advance(2_000);
    const view = source.run(() => fixture.runtime.beginNativeFilesystemToolCall(ROOT));
    t.after(() => view.close());
    assert.notEqual(view.approvalWaitScope, source);
    view.approvalWaitScope.setTimeout(() => viewExpired = true, 3_000);
    const pending = observe(view.evaluate(TARGET, PolicyAccessType.FS_WRITE));
    await flush();
    assert.equal(source.waiting, true);
    assert.equal(view.approvalWaitScope.waiting, true);
    await clock.advance(200_000);
    assert.equal(sourceExpired, false);
    assert.equal(viewExpired, false);
    await fixture.allow();
    assert.equal((await pending.promise).result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(view.currentPolicyResult(TARGET, PolicyAccessType.FS_WRITE)?.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(source.waiting, false);
    assert.equal(view.approvalWaitScope.waiting, false);
    view.close();
    await clock.advance(7_999);
    assert.equal(viewExpired, false, "closing a view must dispose its source watchdog");
    assert.equal(sourceExpired, false, "closing a view must not dispose its parent's watchdog");
    await clock.advance(1);
    assert.equal(sourceExpired, true);
});

test("completed user approvals clear their watchdog instead of aborting later work", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const pending = observe(fixture.evaluate());
    await flush();
    const approvalSignal = fixture.dialogs[0]!.signal!;
    await clock.advance(250_000);
    await fixture.allow();
    assert.equal((await pending.promise).matchedStatus, PolicyResponse.ALLOWED);
    await clock.advance(USER_TIMEOUT);
    assert.equal(approvalSignal.aborted, false, "the completed request's watchdog must have been cleared");
    const next = observe(fixture.evaluate(OTHER_TARGET));
    await flush();
    await clock.advance(USER_TIMEOUT - 1);
    assert.equal(next.settled, false, "a later approval owns a new watchdog, not the original deadline");
    await fixture.allow(OTHER_TARGET);
    assert.equal((await next.promise).matchedStatus, PolicyResponse.ALLOWED);
});

test("a child turn preserves its remaining source budget through a long successful user approval", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const start = deferred<void>();
    const finish = deferred<string>();
    let decision: PolicyResult | undefined;
    const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        await abortable(start.promise, signal);
        decision = await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
        return abortable(finish.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 30}));
    await flush();
    await clock.advance(10_000);
    start.resolve();
    await flush();
    await clock.advance(200_000);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await fixture.allow();
    assert.equal(decision?.matchedStatus, PolicyResponse.ALLOWED);
    await clock.advance(19_999);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(1);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.TIMED_OUT);
});

for (const callbackKind of ["direct", "native view"] as const) {
    test(`${callbackKind} callbacks captured in a closed old scope still pause the principal's fresh turn budget`, async (t) => {
        const clock = new VirtualClock(t);
        const fixture = new ApprovalFixture(t);
        const oldScope = new ApprovalWaitScope();
        oldScope.close();
        const freshScope = new ApprovalWaitScope();
        fixture.runtime.setPolicyApprovalWaitScope(ROOT, freshScope);
        t.after(() => {
            fixture.runtime.setPolicyApprovalWaitScope(ROOT, undefined);
            freshScope.close();
        });
        let sourceExpired = false;
        freshScope.setTimeout(() => sourceExpired = true, 10_000);
        await clock.advance(2_000);
        // A reused transport can retain an old turn's ALS even after a fresh turn starts.
        const evaluate = oldScope.run(() => {
            assert.equal(ApprovalWaitScope.current(), oldScope);
            if (callbackKind === "direct") {
                const evaluator = fixture.runtime.beginToolCall(ROOT);
                return () => evaluator(TARGET, PolicyAccessType.FS_WRITE);
            }
            const view = fixture.runtime.beginNativeFilesystemToolCall(ROOT);
            t.after(() => view.close());
            return async () => (await view.evaluate(TARGET, PolicyAccessType.FS_WRITE)).result;
        });
        assert.equal(ApprovalWaitScope.current(), undefined);
        const pending = observe(evaluate());
        await flush();
        assert.equal(oldScope.waiting, false, "a closed scope must not acquire a new wait");
        assert.equal(freshScope.waiting, true, "stale ambient context must not hide the active principal scope");
        await clock.advance(200_000);
        assert.equal(pending.settled, false);
        assert.equal(sourceExpired, false);
        await fixture.allow();
        assert.equal((await pending.promise).matchedStatus, PolicyResponse.ALLOWED);
        assert.equal(freshScope.waiting, false);
        await clock.advance(7_999);
        assert.equal(sourceExpired, false);
        await clock.advance(1);
        assert.equal(sourceExpired, true, "the fresh budget resumes with its original remaining time");
    });

    test(`principal-scoped ${callbackKind} callbacks outside async context still pause their child turn`, async (t) => {
        const clock = new VirtualClock(t);
        const fixture = new ApprovalFixture(t);
        const externalCallback = new AsyncResource("approval-test-external-callback");
        t.after(() => externalCallback.emitDestroy());
        const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
            const result = await externalCallback.runInAsyncScope(async () => {
                if (callbackKind === "direct") {
                    return fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
                }
                const view = fixture.runtime.beginNativeFilesystemToolCall(request.agentIdentifier);
                try {
                    return (await view.evaluate(TARGET, PolicyAccessType.FS_WRITE, signal)).result;
                } finally {
                    view.close();
                }
            });
            assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
            return "approved from external callback";
        });
        const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 1}));
        await flush();
        await clock.advance(200_000);
        assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
        await fixture.allow();
        assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.IDLE);
    });
}

test("a synchronous RUNNING observer can stop a job without failing it or leaking its turn scope", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const scopeUpdates: Array<ApprovalWaitScope | undefined> = [];
    const setScope = fixture.runtime.setPolicyApprovalWaitScope.bind(fixture.runtime);
    t.mock.method(fixture.runtime, "setPolicyApprovalWaitScope", (identifier: string, scope: ApprovalWaitScope | undefined) => {
        scopeUpdates.push(scope);
        setScope(identifier, scope);
    });
    const coordinator = fixture.coordinator(t, async (_request, _task, signal) => (
        abortable(new Promise<string>(() => {}), signal)
    ));
    let stopRequested = false;
    let stopping: Promise<SubagentJobStatus> | undefined;
    const statuses: SubagentJobStatus[] = [];
    const unsubscribe = coordinator.subscribe((change) => {
        if (change.kind !== "upsert") return;
        statuses.push(change.job.status);
        if (change.job.status === SubagentJobStatus.RUNNING && !stopRequested) {
            stopRequested = true;
            // subscribe() reports the scope's initial state synchronously during turn setup.
            stopping = coordinator.stop(change.job.id).then((job) => job.status);
        }
    });
    t.after(unsubscribe);
    const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 1}));
    await flush();
    assert.equal(stopRequested, true);
    assert.equal(await stopping, SubagentJobStatus.CANCELLED);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.CANCELLED);
    assert.equal(statuses.includes(SubagentJobStatus.FAILED), false);
    assert.deepEqual(scopeUpdates.map((scope) => scope !== undefined), [true, false]);
    const scope = scopeUpdates[0]!;
    assert.equal(scope.waiting, false);
    assert.throws(() => scope.setTimeout(() => {}, 1), /closed approval wait scope/);
    assert.throws(() => fixture.runtime.beginToolCall(job.id), /No agent registered/);
    const eventCount = statuses.length;
    await clock.advance(USER_TIMEOUT);
    assert.equal(statuses.length, eventCount, "the cancelled turn must leave no live watchdog notifications");
});

test("explicit stop and status abort remain immediate while approval clocks are paused", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    let decision: PolicyResult | undefined;
    let sourceAborted = false;
    const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        decision = await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
        sourceAborted = signal.aborted;
        return "stopped";
    });
    const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 1}));
    await flush();
    const controller = new AbortController();
    const status = coordinator.status([job.id], 5, controller.signal);
    const rejected = assert.rejects(status, {name: "AbortError"});
    await clock.advance(100_000);
    controller.abort();
    await rejected;
    const stopped = observe(coordinator.stop(job.id));
    await flush();
    assert.equal(stopped.settled, true, "explicit cancellation must not wait for an approval watchdog");
    assert.equal((await stopped.promise).status, SubagentJobStatus.CANCELLED);
    assert.equal(sourceAborted, true);
    assertFailedClosed(decision!);
    assert.equal(fixture.dialogs[0]!.signal?.aborted, true);
    fixture.dialogs[0]!.answer(TARGET);
    await flush();
    assert.equal(fixture.persisted.length, 0);
});

for (const route of ["ask_llm", "ancestor"] as const) {
    test(`${route} review pauses the source but its independent 300-second watchdog still expires`, async (t) => {
        const clock = new VirtualClock(t);
        const authority: Policy[] = route === "ancestor" ? [{
            pattern: WORKSPACE,
            info: {[PolicyAccessType.FS_WRITE]: PolicyEngine.createStatus(
                PolicyAccessType.FS_WRITE, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "Root authority",
            )},
        }] : [];
        const fixture = new ApprovalFixture(t, authority);
        if (route === "ask_llm") fixture.runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
        let reviewerSignal: AbortSignal | undefined;
        let reviewerDisposed = false;
        const reviewFlow = new SubagentPolicyDecisionFlow({
            async create(_request, tools, signal) {
                assert.deepEqual(tools.map((tool) => tool.name), ["policy_decision"]);
                reviewerSignal = signal;
                return {
                    prompt: async () => new Promise<string>(() => {}),
                    steer: async () => false,
                    abort: async () => {},
                    dispose: () => reviewerDisposed = true,
                } satisfies SubagentChildSession;
            },
        }, () => initialSubagentDefaults);
        t.after(() => reviewFlow.close());
        fixture.runtime.setAgentDecisionFlow(reviewFlow);
        let decision: PolicyResult | undefined;
        let sourceSignal: AbortSignal | undefined;
        const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
            sourceSignal = signal;
            decision = await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
            return "review failed closed";
        });
        const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 1}));
        await flush();
        assert.ok(reviewerSignal);
        await clock.advance(USER_TIMEOUT - 1);
        assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
        assert.equal(reviewerSignal.aborted, false);
        assert.equal(sourceSignal?.aborted, false);
        await clock.advance(1);
        assert.equal(reviewerSignal.aborted, true);
        assert.equal(reviewerDisposed, true);
        assert.equal(sourceSignal?.aborted, false, "review failure does not consume the paused source budget");
        assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.IDLE);
        assert.equal(decision?.matchedStatus, PolicyResponse.DENIED);
        assert.equal(decision?.matchedLifetime, PolicyLifetime.ONCE);
        assert.equal(fixture.dialogs.length, 0, "review failure must not escalate to a user prompt");
        assert.equal(fixture.persisted.length, 0);
    });
}

test("status waitSeconds pauses for selected approval jobs and resumes its remaining budget", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const start = deferred<void>();
    const finish = deferred<string>();
    const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        await abortable(start.promise, signal);
        await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
        return abortable(finish.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 30}));
    await flush();
    const pending = observe(coordinator.status([job.id], 5));
    await clock.advance(1_000);
    start.resolve();
    await flush();
    await clock.advance(200_000);
    assert.equal(pending.settled, false);
    await fixture.allow();
    await clock.advance(3_999);
    assert.equal(pending.settled, false);
    await clock.advance(1);
    assert.equal(pending.settled, true);
    assert.equal((await pending.promise)[0]!.status, SubagentJobStatus.RUNNING);
});

test("waiting on selected descendants pauses an invoking parent's source clock", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const childFinish = deferred<string>();
    const parentFinish = deferred<string>();
    let childId = "";
    let statusReturned = false;
    let coordinator!: SubagentCoordinator;
    coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        if (request.role === "child") {
            await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
            return abortable(childFinish.promise, signal);
        }
        const spawned = await coordinator.spawn(childRequest({
            parentAgentIdentifier: request.agentIdentifier, role: "child", timeoutSeconds: 30,
        }));
        childId = spawned.job.id;
        await coordinator.status([childId], 5, signal);
        statusReturned = true;
        return abortable(parentFinish.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({
        role: "parent", timeoutSeconds: 10, capabilities: [AgentMechanismCapability.delegate],
    }));
    await flush();
    await clock.advance(200_000);
    assert.equal(statusReturned, false);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await fixture.allow();
    await clock.advance(4_999);
    assert.equal(statusReturned, false);
    await clock.advance(1);
    assert.equal(statusReturned, true);
    assert.equal(coordinator.list([childId])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(4_999);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(1);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.TIMED_OUT);
});

test("status reconciles a new selected-child approval started synchronously while releasing its parent wait", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const childFinish = deferred<string>();
    const parentFinish = deferred<string>();
    let parentScope: ApprovalWaitScope | undefined;
    let childScope: ApprovalWaitScope | undefined;
    let startSecondApproval: (() => Promise<PolicyResult>) | undefined;
    let secondApproval: Promise<PolicyResult> | undefined;
    let sawParentWait = false;
    let triggered = false;
    let statusReturned = false;
    let coordinator!: SubagentCoordinator;
    coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        if (request.role === "child") {
            childScope = ApprovalWaitScope.current();
            assert.ok(childScope);
            const source = childScope;
            startSecondApproval = () => source.run(() => fixture.runtime.beginToolCall(request.agentIdentifier)(
                OTHER_TARGET, PolicyAccessType.FS_WRITE, signal,
            ));
            await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
            return abortable(childFinish.promise, signal);
        }
        parentScope = ApprovalWaitScope.current();
        assert.ok(parentScope);
        const child = await coordinator.spawn(childRequest({
            parentAgentIdentifier: request.agentIdentifier, role: "child", timeoutSeconds: 30,
        }));
        const unsubscribe = parentScope.subscribe((waiting) => {
            if (waiting) sawParentWait = true;
            else if (sawParentWait && !triggered) {
                triggered = true;
                assert.ok(startSecondApproval);
                // Reenter status's job observer before the original release has returned.
                secondApproval = startSecondApproval();
            }
        });
        t.after(unsubscribe);
        await coordinator.status([child.job.id], 5, signal);
        statusReturned = true;
        return abortable(parentFinish.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({
        role: "parent", timeoutSeconds: 10, capabilities: [AgentMechanismCapability.delegate],
    }));
    await flush();
    assert.ok(parentScope);
    assert.ok(childScope);
    assert.equal(parentScope.waiting, true);
    await clock.advance(100_000);
    await fixture.allow();
    assert.equal(triggered, true);
    assert.ok(secondApproval);
    assert.equal(parentScope.waiting, true);
    assert.equal(childScope.waiting, true);
    assert.match(fixture.dialogs.at(-1)!.title, /^Path policy scope/);
    await clock.advance(100_000);
    await fixture.allow(OTHER_TARGET);
    assert.equal((await secondApproval).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(childScope.waiting, false);
    assert.equal(parentScope.waiting, false, "reentrant acquisition must not overwrite and leak a status wait token");
    assert.equal(statusReturned, false);
    await clock.advance(4_999);
    assert.equal(statusReturned, false);
    await clock.advance(1);
    assert.equal(statusReturned, true, "the selected status wait must resume after the second approval");
    await clock.advance(4_999);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(1);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.TIMED_OUT);
});

test("status reconciles a selected child wait ended synchronously while acquiring its parent wait", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const startStatus = deferred<void>();
    const childFinish = deferred<string>();
    const parentFinish = deferred<string>();
    let parentScope: ApprovalWaitScope | undefined;
    let childScope: ApprovalWaitScope | undefined;
    let releaseChildWait: (() => void) | undefined;
    let triggered = false;
    let statusReturned = false;
    let coordinator!: SubagentCoordinator;
    coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        if (request.role === "child") {
            childScope = ApprovalWaitScope.current();
            assert.ok(childScope);
            // Hold the public approval token directly so its release can be synchronous.
            releaseChildWait = childScope.beginWait();
            return abortable(childFinish.promise, signal);
        }
        parentScope = ApprovalWaitScope.current();
        assert.ok(parentScope);
        const child = await coordinator.spawn(childRequest({
            parentAgentIdentifier: request.agentIdentifier, role: "child", timeoutSeconds: 30,
        }));
        await abortable(startStatus.promise, signal);
        const unsubscribe = parentScope.subscribe((waiting) => {
            if (!waiting || triggered) return;
            triggered = true;
            assert.ok(releaseChildWait);
            releaseChildWait();
        });
        t.after(unsubscribe);
        await coordinator.status([child.job.id], 5, signal);
        statusReturned = true;
        return abortable(parentFinish.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({
        role: "parent", timeoutSeconds: 10, capabilities: [AgentMechanismCapability.delegate],
    }));
    await flush();
    assert.ok(parentScope);
    assert.ok(childScope);
    assert.equal(childScope.waiting, true);
    assert.equal(parentScope.waiting, false);
    startStatus.resolve();
    await flush();
    assert.equal(triggered, true);
    assert.equal(childScope.waiting, false);
    assert.equal(parentScope.waiting, false, "acquisition must reconcile a reentrant child wait ending before beginWait returns");
    await clock.advance(4_999);
    assert.equal(statusReturned, false);
    await clock.advance(1);
    assert.equal(statusReturned, true);
    await clock.advance(4_999);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(1);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.TIMED_OUT);
});

test("an unrelated sibling's pending approval does not pause selected status waits", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const work = deferred<string>();
    const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        if (request.role === "approval") {
            await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
        }
        return abortable(work.promise, signal);
    });
    const selected = await coordinator.spawn(childRequest({role: "selected", timeoutSeconds: 30}));
    const sibling = await coordinator.spawn(childRequest({role: "approval", timeoutSeconds: 1}));
    await flush();
    const pending = observe(coordinator.status([selected.job.id], 5));
    await clock.advance(4_999);
    assert.equal(pending.settled, false);
    await clock.advance(1);
    assert.equal(pending.settled, true, "unselected background approvals must not extend this wait");
    assert.equal((await pending.promise)[0]!.status, SubagentJobStatus.RUNNING);
    assert.equal(coordinator.list([sibling.job.id])[0]!.status, SubagentJobStatus.RUNNING);
});

test("a background descendant does not automatically pause its ancestor's turn", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const work = deferred<string>();
    let descendantId = "";
    let coordinator!: SubagentCoordinator;
    coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        if (request.role === "parent") {
            const child = await coordinator.spawn(childRequest({
                parentAgentIdentifier: request.agentIdentifier, role: "background", timeoutSeconds: 1,
            }));
            descendantId = child.job.id;
        } else {
            await fixture.runtime.beginToolCall(request.agentIdentifier)(TARGET, PolicyAccessType.FS_WRITE, signal);
        }
        return abortable(work.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({
        role: "parent", timeoutSeconds: 10, capabilities: [AgentMechanismCapability.delegate],
    }));
    await flush();
    await clock.advance(9_999);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(1);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.TIMED_OUT);
    assert.equal(coordinator.list([descendantId])[0]!.status, SubagentJobStatus.RUNNING);
});

test("retained follow-up turns receive a fresh budget rather than the previous turn's remainder", async (t) => {
    const clock = new VirtualClock(t);
    const fixture = new ApprovalFixture(t);
    const first = deferred<string>();
    const second = deferred<string>();
    let prompts = 0;
    const coordinator = fixture.coordinator(t, async (request, _task, signal) => {
        prompts++;
        const target = prompts === 1 ? TARGET : OTHER_TARGET;
        await fixture.runtime.beginToolCall(request.agentIdentifier)(target, PolicyAccessType.FS_WRITE, signal);
        return abortable(prompts === 1 ? first.promise : second.promise, signal);
    });
    const {job} = await coordinator.spawn(childRequest({timeoutSeconds: 30}));
    await flush();
    await clock.advance(200_000);
    await fixture.allow();
    await clock.advance(25_000);
    first.resolve("first answer");
    await flush();
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.IDLE);
    await clock.advance(100_000);
    await coordinator.message(job.id, "follow-up task");
    await flush();
    assert.equal(prompts, 2);
    await clock.advance(200_000);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await fixture.allow(OTHER_TARGET);
    await clock.advance(29_999);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.RUNNING);
    await clock.advance(1);
    assert.equal(coordinator.list([job.id])[0]!.status, SubagentJobStatus.TIMED_OUT);
    assert.equal(coordinator.list([job.id])[0]!.turns, 1);
});

function childRequest(overrides: Partial<SubagentRequest> = {}): SubagentRequest {
    return {
        parentAgentIdentifier: ROOT,
        task: "inspect the requested change",
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

class FakeSession implements SubagentChildSession {
    constructor(private readonly respond: (task: string, signal: AbortSignal) => Promise<string>) {}

    prompt(task: string, signal: AbortSignal): Promise<string> {
        return this.respond(task, signal);
    }

    async steer(): Promise<boolean> {
        return false;
    }

    async abort(): Promise<void> {}

    dispose(): void {}
}

function assertFailedClosed(result: PolicyResult): void {
    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.equal(result.matchedLifetime, PolicyLifetime.ONCE);
    assert.equal(result.resolutionSource, PolicyResolutionSource.SYSTEM);
}

function deferred<T>(): {promise: Promise<T>; resolve(value: T): void} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => resolve = complete);
    return {promise, resolve};
}

function observe<T>(promise: Promise<T>): {promise: Promise<T>; settled: boolean} {
    const observed = {promise, settled: false};
    void promise.then(() => observed.settled = true, () => observed.settled = true);
    return observed;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), {name: "AbortError"}));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, {once: true});
        void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

async function flush(): Promise<void> {
    // Drain the real policy/UI/coordinator promise chain without advancing virtual time.
    for (let index = 0; index < 80; index++) await Promise.resolve();
}
