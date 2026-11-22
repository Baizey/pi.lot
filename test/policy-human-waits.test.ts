import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PolicyApprovalReviewSource, type AgentPolicyApprovalRequest} from "../src/policy/AgentPolicyDecisionFlow.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import type {PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResponse,
} from "../src/policy/types.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

const ROOT = "human-policy-waits-root";
const CHILD = "human-policy-waits-child";
const TARGET = "/tmp/pilot-human-policy-waits/first.txt";
const OTHER = "/tmp/pilot-human-policy-waits/second.txt";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => { resolve = finish; });
    return {promise, resolve};
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function fixture(t: TestContext, options: {
    mode?: ExtensionContext["mode"];
    ui?: Partial<ExtensionContext["ui"]>;
    observe?: () => void;
} = {}) {
    const events: unknown[][] = [];
    const dialogs: {title: string; choices: string[]; answer: (value: string | undefined) => void}[] = [];
    const open = (title: string, choices: string[] = []) => {
        const {promise, resolve} = deferred<string | undefined>();
        dialogs.push({title, choices, answer: resolve});
        // Deliberately ignore abort to simulate a late reply: the status must still clear.
        return promise;
    };
    const mode = options.mode ?? "rpc";
    const ctx = {
        cwd: "/tmp",
        mode,
        hasUI: mode === "tui" || mode === "rpc",
        ui: {select: open, input: (title: string) => open(title), ...options.ui},
        sessionManager: {getSessionId: () => ROOT},
    } as unknown as ExtensionContext;
    const runtime = new PilotSessionRuntime(ctx, {
        openDatabase: () => SqliteDatabase.test(false, ":memory:"),
        policyDefaultsStore: {load: () => ({...initialPolicyDefaults}), save() {}},
        credentialIpcConfigStore: {load: () => ({})},
        approvalAuditLog: {append() {}},
        onHumanPolicyWaitChange: (...args) => {
            events.push(args);
            options.observe?.();
        },
    });
    t.after(async () => {
        runtime.beginShutdown();
        for (const dialog of dialogs) dialog.answer(undefined);
        await runtime.close();
    });

    function evaluate(target = TARGET, signal?: AbortSignal, agent = ROOT) {
        return runtime.policyRuntime.once(agent, target, PolicyAccessType.FS_WRITE, signal);
    }

    async function answer(title: RegExp, choice?: string): Promise<void> {
        const dialog = dialogs.at(-1)!;
        assert.match(dialog.title, title);
        dialog.answer(choice ?? dialog.choices[0]);
        await nextTurn();
    }

    return {events, dialogs, runtime, evaluate, answer};
}

test("root RPC keeps one span across steps, queued rechecks and a child's approval", async (t) => {
    const {events, dialogs, runtime, evaluate, answer} = fixture(t);
    runtime.policyRuntime.registerPolicyPrincipal(CHILD, ROOT, []);
    assert.deepEqual(events, []);

    const root = evaluate();
    const coveredByRoot = evaluate();
    const child = evaluate(OTHER, undefined, CHILD);
    assert.deepEqual(events, [], "entry into the queue alone is not a human wait");
    await nextTurn();
    assert.equal(dialogs.length, 1);
    assert.deepEqual(events, [[true]]);

    await answer(/^Path policy scope/);
    await answer(/^Path policy decision/, "Allow");
    assert.deepEqual(events, [[true]]);
    await answer(/^Path policy lifetime/, "This session");

    assert.equal(dialogs.length, 4, "one queued request was satisfied without a dialog");
    assert.match(dialogs[3]!.title, /human-policy-waits-child/);
    assert.equal((await root).matchedStatus, PolicyResponse.ALLOWED);
    assert.equal((await coveredByRoot).matchedStatus, PolicyResponse.ALLOWED);
    assert.deepEqual(events, [[true]], "the handoff must not pulse false/true");

    await answer(/^Path policy scope/);
    await answer(/^Path policy decision/, "Deny");
    await answer(/^Path policy lifetime/, "Once");
    assert.deepEqual(events, [[true]], "the free-form reason is part of the same span");
    await answer(/^Reason for denying access/, "Not needed");
    assert.equal((await child).matchedStatus, PolicyResponse.DENIED);
    assert.deepEqual(events, [[true], [false]]);
});

test("active and queued cancellations clear the span without trusting late replies", async (t) => {
    const {events, dialogs, evaluate} = fixture(t);
    const active = new AbortController();
    const queued = new AbortController();
    const first = evaluate(TARGET, active.signal);
    const second = evaluate(OTHER, queued.signal);
    await nextTurn();
    assert.deepEqual(events, [[true]]);

    queued.abort();
    assert.equal((await second).matchedStatus, PolicyResponse.DENIED);
    assert.deepEqual(events, [[true]], "cancelling a queued request does not clear the active one");
    active.abort();
    assert.equal((await first).matchedStatus, PolicyResponse.DENIED);
    await nextTurn();
    assert.deepEqual(events, [[true], [false]], "clear even when the UI has not returned");
    dialogs[0]!.answer(dialogs[0]!.choices[0]);
    await nextTurn();
    assert.equal(dialogs.length, 1);
    assert.deepEqual(events, [[true], [false]]);
});

test("the policy deadline clears an unanswered human wait", async (t) => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    const {events, evaluate} = fixture(t);
    const pending = evaluate();
    await nextTurn();
    assert.deepEqual(events, [[true]]);
    t.mock.timers.tick(300_000);
    const result = await pending;
    assert.equal(result.matchedStatus, PolicyResponse.DENIED);
    assert.match(result.matchedReason, /timed out/i);
    assert.deepEqual(events, [[true], [false]]);
});

test("session shutdown synchronously clears the aggregate and ignores late replies", async (t) => {
    const {events, dialogs, runtime, evaluate} = fixture(t);
    const active = evaluate();
    const queued = evaluate(OTHER);
    await nextTurn();
    assert.deepEqual(events, [[true]]);

    runtime.beginShutdown();
    runtime.beginShutdown();
    assert.deepEqual(events, [[true], [false]]);
    assert.equal((await active).matchedStatus, PolicyResponse.DENIED);
    assert.equal((await queued).matchedStatus, PolicyResponse.DENIED);
    dialogs[0]!.answer(dialogs[0]!.choices[0]);
    await nextTurn();
    assert.equal(dialogs.length, 1);
    assert.deepEqual(events, [[true], [false]]);
});

test("headless policy requests do not report a human wait", async (t) => {
    const {events, dialogs, evaluate} = fixture(t, {mode: "print"});
    assert.equal((await evaluate()).matchedStatus, PolicyResponse.DENIED);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(events, []);
});

for (const [fallback, requester, expected] of [
    [PolicyFallbackResponse.ask_llm, ROOT, PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM],
    [PolicyFallbackResponse.allow, CHILD, PolicyApprovalReviewSource.ANCESTOR_AUTHORITY],
] as const) {
    test(`${expected} never reports a human wait`, async (t) => {
        const {events, dialogs, runtime, evaluate} = fixture(t);
        runtime.policyRuntime.registerPolicyPrincipal(CHILD, ROOT, []);
        runtime.policyRuntime.setDefaultResponse(PolicyArea.fs_write, fallback);
        const review = deferred<PolicyChoice>();
        const requests: AgentPolicyApprovalRequest[] = [];
        runtime.policyRuntime.setAgentDecisionFlow({askForPolicy: (request) => {
            requests.push(request);
            return review.promise;
        }});

        const pending = evaluate(TARGET, undefined, requester);
        await nextTurn();
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.reviewSource, expected);
        assert.deepEqual(dialogs, []);
        assert.deepEqual(events, []);
        review.resolve({
            uri: requests[0]!.uri,
            accessType: PolicyAccessType.FS_WRITE,
            status: PolicyResponse.ALLOWED,
            lifetime: PolicyLifetime.ONCE,
            reason: "Structured review approved the request",
        });
        assert.equal((await pending).matchedStatus, PolicyResponse.ALLOWED);
        assert.deepEqual(events, []);
    });
}

test("TUI shortcut dialogs advertise a fixed permission label and ignore reporter failure", async (t) => {
    type Custom = ExtensionContext["ui"]["custom"];
    const customOptions: Parameters<Custom>[1][] = [];
    let allowOnce: (() => void) | undefined;
    const custom: Custom = (factory, options) => new Promise((resolve, reject) => {
        customOptions.push(options);
        void Promise.resolve(factory(
            {requestRender() {}} as Parameters<typeof factory>[0],
            {} as Parameters<typeof factory>[1],
            {} as Parameters<typeof factory>[2],
            resolve,
        )).then((component) => { allowOnce = () => component.handleInput?.("\x1b[C"); }, reject);
    });
    const {events, dialogs, evaluate} = fixture(t, {
        mode: "tui",
        ui: {custom},
        observe: () => { throw new Error("status sink unavailable"); },
    });
    const pending = evaluate();
    await nextTurn();
    assert.deepEqual(customOptions, [{blocked: {kind: "permission", message: "Policy approval required"}}]);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(events, [[true]]);
    assert.ok(allowOnce);
    allowOnce();
    assert.equal((await pending).matchedStatus, PolicyResponse.ALLOWED);
    assert.deepEqual(events, [[true], [false]]);
});
