import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import test, {type TestContext} from "node:test";
import {ApprovalWaitScope} from "../src/runtime/ApprovalWaitScope.js";
import {PausableTimeout} from "../src/runtime/PausableTimeout.js";

class FakeClock {
    private time = 0;
    readonly now = () => this.time;

    constructor(private readonly context: TestContext) {
        context.mock.timers.enable({apis: ["setTimeout"]});
    }

    advance(milliseconds: number): void {
        this.elapse(milliseconds);
        this.context.mock.timers.tick(milliseconds);
    }

    // Move the monotonic clock without letting queued timer callbacks execute.
    elapse(milliseconds: number): void {
        this.time += milliseconds;
    }
}

test("pausable timeout preserves remaining budget across the union of overlapping pauses", (t) => {
    const clock = new FakeClock(t);
    let calls = 0;
    const timeout = new PausableTimeout(100, () => calls++, {now: clock.now});
    clock.advance(30);
    const first = timeout.pause();
    clock.advance(200);
    const second = timeout.pause();
    first();
    first();
    clock.advance(300);
    assert.equal(calls, 0);
    second();
    second();
    clock.advance(69);
    assert.equal(timeout.expired, false);
    clock.advance(1);
    assert.equal(calls, 1);
    assert.equal(timeout.expired, true);
    timeout.pause()();
    timeout.dispose();
    clock.advance(1000);
    assert.equal(calls, 1);
});

test("default clock uses monotonic performance.now rather than Date.now", (t) => {
    const clock = new FakeClock(t);
    t.mock.method(performance, "now", clock.now);
    t.mock.method(Date, "now", () => -1_000_000);
    let calls = 0;
    const timeout = new PausableTimeout(10, () => calls++);
    clock.advance(4);
    const resume = timeout.pause();
    clock.advance(100);
    resume();
    clock.advance(5);
    assert.equal(calls, 0);
    clock.advance(1);
    assert.equal(calls, 1);
});

test("an exhausted budget expires when paused before the queued callback runs", (t) => {
    const clock = new FakeClock(t);
    let calls = 0;
    const timeout = new PausableTimeout(20, () => calls++, {now: clock.now});
    clock.elapse(20);
    const resume = timeout.pause();
    assert.equal(timeout.expired, true);
    assert.equal(calls, 1);
    resume();
    clock.advance(100);
    assert.equal(calls, 1);
});

test("zero budget expires asynchronously unless pause observes its exhaustion", (t) => {
    const clock = new FakeClock(t);
    let calls = 0;
    const timeout = new PausableTimeout(0, () => calls++, {now: clock.now});
    assert.equal(calls, 0);
    clock.advance(1);
    assert.equal(timeout.expired, true);
    assert.equal(calls, 1);
});

test("dispose permanently cancels active and paused timers without marking them expired", (t) => {
    const clock = new FakeClock(t);
    let calls = 0;
    const active = new PausableTimeout(10, () => calls++, {now: clock.now});
    const paused = new PausableTimeout(10, () => calls++, {now: clock.now});
    const first = paused.pause();
    const second = paused.pause();
    active.dispose();
    paused.dispose();
    paused.dispose();
    first();
    second();
    paused.pause()();
    clock.advance(100);
    assert.equal(calls, 0);
    assert.equal(active.expired, false);
    assert.equal(paused.expired, false);
});

test("stale callbacks cannot expire paused, resumed, disposed, or already expired timers", (t) => {
    const clock = new FakeClock(t);
    const schedule = globalThis.setTimeout;
    const callbacks: Array<() => void> = [];
    t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds: number) => {
        callbacks.push(callback);
        return schedule(callback, milliseconds);
    });
    let calls = 0;
    const timeout = new PausableTimeout(10, () => calls++, {now: clock.now});
    clock.advance(3);
    const resume = timeout.pause();
    clock.advance(100);
    callbacks[0]!();
    assert.equal(calls, 0);
    resume();
    callbacks[0]!();
    assert.equal(calls, 0);
    clock.advance(7);
    assert.equal(calls, 1);
    callbacks[1]!();
    assert.equal(calls, 1);
    const disposed = new PausableTimeout(10, () => calls++, {now: clock.now});
    disposed.dispose();
    clock.advance(10);
    callbacks[2]!();
    assert.equal(calls, 1);
});

test("early timer delivery re-arms instead of prematurely expiring", (t) => {
    const clock = new FakeClock(t);
    let calls = 0;
    const timeout = new PausableTimeout(10, () => calls++, {now: clock.now});
    t.mock.timers.tick(10);
    assert.equal(calls, 0);
    clock.advance(10);
    assert.equal(calls, 1);
    assert.equal(timeout.expired, true);
});

test("long budgets are chunked instead of suffering Node delay overflow", (t) => {
    const clock = new FakeClock(t);
    let calls = 0;
    const maximumDelay = 2_147_483_647;
    new PausableTimeout(maximumDelay + 10, () => calls++, {now: clock.now});
    clock.advance(maximumDelay);
    assert.equal(calls, 0);
    clock.advance(9);
    assert.equal(calls, 0);
    clock.advance(1);
    assert.equal(calls, 1);
});

test("unref is applied to both the initial and resumed timer", (t) => {
    const clock = new FakeClock(t);
    const schedule = globalThis.setTimeout;
    let unrefs = 0;
    t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds: number) => {
        const handle = schedule(callback, milliseconds);
        t.mock.method(handle, "unref", () => { unrefs++; return handle; });
        return handle;
    });
    const timeout = new PausableTimeout(10, () => {}, {now: clock.now, unref: true});
    assert.equal(unrefs, 1);
    timeout.pause()();
    assert.equal(unrefs, 2);
    timeout.dispose();
});

test("invalid execution budgets are rejected", () => {
    for (const budget of [-1, NaN, Infinity, -Infinity]) {
        assert.throws(() => new PausableTimeout(budget, () => {}), RangeError);
    }
});

test("scope subscriptions report initial state and only union transitions", () => {
    const scope = new ApprovalWaitScope();
    const states: boolean[] = [];
    const unsubscribe = scope.subscribe((waiting) => states.push(waiting));
    const first = scope.beginWait();
    const second = scope.beginWait();
    assert.equal(scope.waiting, true);
    first();
    first();
    assert.equal(scope.waiting, true);
    second();
    second();
    assert.equal(scope.waiting, false);
    assert.deepEqual(states, [false, true, false]);
    unsubscribe();
    unsubscribe();
    scope.beginWait()();
    assert.deepEqual(states, [false, true, false]);
    scope.close();
});

test("same listener can have independently owned subscriptions", () => {
    const scope = new ApprovalWaitScope();
    const states: boolean[] = [];
    const listener = (waiting: boolean) => states.push(waiting);
    const first = scope.subscribe(listener);
    const second = scope.subscribe(listener);
    first();
    scope.beginWait()();
    second();
    assert.deepEqual(states, [false, false, true, false]);
    scope.close();
});

test("waiting pauses tracked timers, including new timers, but not ordinary watchdogs", (t) => {
    const clock = new FakeClock(t);
    const scope = new ApprovalWaitScope();
    const calls: string[] = [];
    scope.setTimeout(() => calls.push("existing"), 100, {now: clock.now});
    clock.advance(30);
    const first = scope.beginWait();
    scope.setTimeout(() => calls.push("new"), 50, {now: clock.now});
    setTimeout(() => calls.push("watchdog"), 10);
    clock.advance(10);
    assert.deepEqual(calls, ["watchdog"]);
    const second = scope.beginWait();
    first();
    clock.advance(1000);
    assert.deepEqual(calls, ["watchdog"]);
    second();
    clock.advance(49);
    assert.deepEqual(calls, ["watchdog"]);
    clock.advance(1);
    assert.deepEqual(calls, ["watchdog", "new"]);
    clock.advance(20);
    assert.deepEqual(calls, ["watchdog", "new", "existing"]);
    scope.close();
});

test("child waits cascade to ancestors, but parent waits do not pause child timers", (t) => {
    const clock = new FakeClock(t);
    const parent = new ApprovalWaitScope();
    const child = new ApprovalWaitScope(parent);
    const grandchild = new ApprovalWaitScope(child);
    const calls: string[] = [];
    parent.setTimeout(() => calls.push("parent"), 10, {now: clock.now});
    child.setTimeout(() => calls.push("child"), 10, {now: clock.now});
    const childWait = grandchild.beginWait();
    assert.equal(parent.waiting, true);
    assert.equal(child.waiting, true);
    clock.advance(100);
    assert.deepEqual(calls, []);
    const parentWait = parent.beginWait();
    childWait();
    assert.equal(parent.waiting, true);
    assert.equal(child.waiting, false);
    clock.advance(10);
    assert.deepEqual(calls, ["child"]);
    parentWait();
    clock.advance(10);
    assert.deepEqual(calls, ["child", "parent"]);
    grandchild.close();
    child.close();
    parent.close();
});

test("detached children do not implicitly inherit the active ALS scope", (t) => {
    const clock = new FakeClock(t);
    const parent = new ApprovalWaitScope();
    parent.setTimeout(() => {}, 10, {now: clock.now});
    const detached = parent.run(() => new ApprovalWaitScope());
    const release = detached.beginWait();
    assert.equal(parent.waiting, false);
    assert.equal(detached.waiting, true);
    release();
    detached.close();
    parent.close();
});

test("run captures scope across async continuations and restores nested/outside contexts", async () => {
    const parent = new ApprovalWaitScope();
    const child = new ApprovalWaitScope(parent);
    assert.equal(ApprovalWaitScope.current(), undefined);
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    const pending = parent.run(async () => {
        assert.equal(ApprovalWaitScope.current(), parent);
        await child.run(async () => {
            assert.equal(ApprovalWaitScope.current(), child);
            await gate;
            assert.equal(ApprovalWaitScope.current(), child);
        });
        assert.equal(ApprovalWaitScope.current(), parent);
        return 42;
    });
    assert.equal(ApprovalWaitScope.current(), undefined);
    complete();
    assert.equal(await pending, 42);
    assert.equal(ApprovalWaitScope.current(), undefined);
    assert.equal(parent.run(() => "synchronous value"), "synchronous value");
    assert.throws(() => parent.run(() => { throw new Error("operation failed"); }), /operation failed/);
    assert.equal(ApprovalWaitScope.current(), undefined);
    child.close();
    parent.close();
});

test("closing a child releases all ancestor tokens but leaves unrelated parent waits", (t) => {
    const clock = new FakeClock(t);
    const ancestor = new ApprovalWaitScope();
    const parent = new ApprovalWaitScope(ancestor);
    const child = new ApprovalWaitScope(parent);
    let calls = 0;
    ancestor.setTimeout(() => calls++, 10, {now: clock.now});
    const unrelated = parent.beginWait();
    const first = child.beginWait();
    const second = child.beginWait();
    child.setTimeout(() => assert.fail("closed timer fired"), 10, {now: clock.now});
    child.close();
    child.close();
    first();
    second();
    assert.equal(child.waiting, false);
    assert.equal(parent.waiting, true);
    assert.equal(ancestor.waiting, true);
    clock.advance(100);
    assert.equal(calls, 0);
    unrelated();
    assert.equal(parent.waiting, false);
    assert.equal(ancestor.waiting, false);
    clock.advance(10);
    assert.equal(calls, 1);
    parent.close();
    ancestor.close();
});

test("closed scopes ignore late waits, dispose active timers, and reject new timers", (t) => {
    const clock = new FakeClock(t);
    const scope = new ApprovalWaitScope();
    scope.setTimeout(() => assert.fail("closed timer fired"), 10, {now: clock.now});
    scope.close();
    scope.beginWait()();
    const states: boolean[] = [];
    scope.subscribe((waiting) => states.push(waiting))();
    assert.deepEqual(states, [false]);
    assert.throws(() => scope.setTimeout(() => {}, 10), /closed/);
    clock.advance(100);
    assert.equal(scope.waiting, false);
});

test("expired and disposed timers detach instead of accumulating in their scope", (t) => {
    const clock = new FakeClock(t);
    const scope = new ApprovalWaitScope();
    const pause = PausableTimeout.prototype.pause;
    let pauses = 0;
    t.mock.method(PausableTimeout.prototype, "pause", function (this: PausableTimeout) {
        pauses++;
        return pause.call(this);
    });
    for (let index = 0; index < 100; index++) {
        scope.setTimeout(() => {}, 1, {now: clock.now});
        const disposed = scope.setTimeout(() => assert.fail("disposed timer fired"), 100, {now: clock.now});
        disposed.dispose();
        disposed.dispose();
        clock.advance(1);
    }
    const wait = scope.beginWait();
    assert.equal(pauses, 0);
    const disposedWhileWaiting = scope.setTimeout(() => assert.fail("disposed timer fired"), 10, {now: clock.now});
    assert.equal(pauses, 1);
    disposedWhileWaiting.dispose();
    wait();
    scope.beginWait()();
    assert.equal(pauses, 1);
    clock.advance(100);
    scope.close();
});

test("expiry detaches before a callback starts another wait", (t) => {
    const clock = new FakeClock(t);
    const scope = new ApprovalWaitScope();
    let release: (() => void) | undefined;
    let calls = 0;
    scope.setTimeout(() => {
        calls++;
        release = scope.beginWait();
    }, 10, {now: clock.now});
    clock.advance(10);
    assert.equal(calls, 1);
    assert.equal(scope.waiting, true);
    release?.();
    clock.advance(100);
    assert.equal(calls, 1);
    scope.close();
});

test("a parent listener closing the child during propagation does not leak a token", () => {
    const parent = new ApprovalWaitScope();
    const child = new ApprovalWaitScope(parent);
    parent.subscribe((waiting) => {
        if (waiting) child.close();
    });
    const release = child.beginWait();
    assert.equal(parent.waiting, false);
    assert.equal(child.waiting, false);
    release();
    parent.close();
});

test("a timeout exhausted at wait entry can close its scope without restarting other timers", (t) => {
    const clock = new FakeClock(t);
    const parent = new ApprovalWaitScope();
    const child = new ApprovalWaitScope(parent);
    child.setTimeout(() => child.close(), 10, {now: clock.now});
    child.setTimeout(() => assert.fail("closed sibling timer fired"), 20, {now: clock.now});
    clock.elapse(10);
    const release = child.beginWait();
    assert.equal(child.waiting, false);
    assert.equal(parent.waiting, false);
    release();
    clock.advance(100);
    parent.close();
});

test("scope close unsubscribes listeners after reporting the final wait transition", () => {
    const scope = new ApprovalWaitScope();
    const states: boolean[] = [];
    scope.subscribe((waiting) => states.push(waiting));
    const release = scope.beginWait();
    scope.close();
    release();
    scope.beginWait()();
    assert.deepEqual(states, [false, true, false]);
});

test("close remains balanced even if a listener throws while ancestor waits release", () => {
    const parent = new ApprovalWaitScope();
    const child = new ApprovalWaitScope(parent);
    child.beginWait();
    child.beginWait();
    parent.subscribe((waiting) => {
        if (!waiting) throw new Error("listener failure");
    });
    assert.throws(() => child.close(), /close failed/);
    assert.equal(child.waiting, false);
    assert.equal(parent.waiting, false);
    child.close();
    parent.close();
});
