import assert from "node:assert/strict";
import {once} from "node:events";
import {mkdtemp, rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setImmediate, setTimeout} from "node:timers/promises";
import {test} from "node:test";
import {createEventBus, type ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {PILOT_HUMAN_WAIT, PilotHumanWaits} from "../src/herdr/PilotHumanWaits.js";
import {HerdrReporter} from "../src/herdr/HerdrReporter.js";
import {herdrTarget, sendHerdrRequest, type HerdrRequest, type HerdrSend} from "../src/herdr/HerdrTransport.js";

const defaultEnv = {HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/not-a-real-herdr.sock"};

function harness(options: {mode?: string; hasUI?: boolean; env?: NodeJS.ProcessEnv; send?: HerdrSend} = {}) {
    const handlers = new Map<string, (event: object, ctx: object) => void>();
    const bus = createEventBus();
    let listeners = 0;
    const pi = {
        events: {...bus, on: (...args: Parameters<typeof bus.on>) => {
            listeners++;
            const unsubscribe = bus.on(...args);
            return () => { listeners--; unsubscribe(); };
        }},
        on: (name: string, handler: (event: object, ctx: object) => void) => handlers.set(name, handler),
    };
    const calls: Array<{endpoint: string; req: HerdrRequest; signal: AbortSignal}> = [];
    const reporter = new HerdrReporter(options.env ?? defaultEnv, async (endpoint, req, signal) => {
        calls.push({endpoint, req, signal});
        return options.send ? await options.send(endpoint, req, signal) : "accepted";
    });
    reporter.register(pi as unknown as ExtensionAPI);
    let idle = true;
    let file: string | undefined = "/sessions/native.jsonl";
    let id = "native-id";
    const ctx = {
        mode: options.mode ?? "tui",
        hasUI: options.hasUI ?? true,
        isIdle: () => idle,
        sessionManager: {getSessionFile: () => file, getSessionId: () => id},
    };
    return {
        bus, waits: new PilotHumanWaits(bus), calls, listeners: () => listeners,
        emit: (name: string, payload: object = {}) => handlers.get(name)?.(payload, ctx),
        setIdle: (value: boolean) => { idle = value; },
        setIdentity: (newFile: string | undefined, newId: string) => { file = newFile; id = newId; },
        states: () => calls.flatMap(({req}) => req.params.state ? [[req.params.state, req.params.message]] : []),
    };
}

const ready = ["idle", undefined];
const working = ["working", undefined];
const policy = ["blocked", "Policy approval required"];
const auth = ["blocked", "Server sign-in required"];

test("only interactive Herdr sessions use the fixed local IPC target", async () => {
    assert.deepEqual(herdrTarget(defaultEnv, "linux"), {endpoint: defaultEnv.HERDR_SOCKET_PATH, paneId: "w1:p2"});
    assert.deepEqual(herdrTarget({...defaultEnv, HERDR_SOCKET_PATH: "C:\\Users\\test\\herdr.sock"}, "win32"), {
        endpoint: "\\\\.\\pipe\\C:\\Users\\test\\herdr.sock", paneId: "w1:p2",
    });
    for (const path of ["relative.sock", "tcp://127.0.0.1:1", "/a\0b", `/${"é".repeat(55)}`]) {
        assert.equal(herdrTarget({...defaultEnv, HERDR_SOCKET_PATH: path}, "linux"), undefined);
    }
    for (const options of [{mode: "rpc"}, {mode: "print"}, {mode: "json"}, {hasUI: false},
        {env: {HERDR_ENV: "1"}}, {env: {...defaultEnv, PILOT_HERDR_REPORTING: "0"}}]) {
        const h = harness(options);
        h.emit("session_start", {reason: "startup"});
        h.emit("agent_start");
        h.waits.setPolicyWaiting(true);
        h.emit("session_shutdown", {reason: "quit"});
        assert.equal(h.listeners(), 0);
        assert.deepEqual(h.calls, []);
    }
});

test("native session registration, root working, and idle only after final settlement", async () => {
    const h = harness();
    h.emit("session_start", {reason: "startup"});
    await setImmediate();
    h.setIdle(false);
    h.emit("agent_start");
    await setImmediate();
    h.emit("agent_end");
    h.emit("agent_start"); // Retry/continuation remains working.
    h.emit("agent_settled"); // Not yet idle.
    await setImmediate();
    assert.deepEqual(h.states(), [ready, working]);
    h.setIdle(true);
    h.emit("agent_settled");
    await setImmediate();
    assert.deepEqual(h.states(), [ready, working, ready]);
    const registration = h.calls[0]!.req;
    assert.equal(registration.method, "pane.report_agent_session");
    assert.deepEqual(registration.params, {
        agent_session_path: "/sessions/native.jsonl", session_start_source: "startup",
        pane_id: "w1:p2", source: "herdr:pi", agent: "pi", seq: registration.params.seq,
    });
    for (let i = 0; i < h.calls.length; i++) {
        const {endpoint, req} = h.calls[i]!;
        assert.equal(endpoint, defaultEnv.HERDR_SOCKET_PATH);
        assert.equal(req.params.agent_session_path, "/sessions/native.jsonl");
        assert.ok(i === 0 || req.params.seq > h.calls[i - 1]!.req.params.seq);
        assert.ok(!("resume_argv" in req.params));
    }
});

test("policy has priority; settlement and overlapping auth waits restore the correct state", async () => {
    const h = harness();
    h.setIdle(false);
    h.emit("session_start", {reason: "reload"});
    await setImmediate();
    h.emit("ui_prompt_start", {kind: "custom", title: "Nonwaiting loader"});
    h.emit("ui_prompt_end");
    h.emit("ui_prompt_start", {kind: "select", title: "private request"});
    await setImmediate();
    assert.deepEqual(h.states(), [working]);
    const closeAuth = h.waits.begin("server-auth")!;
    const closeSecondAuth = h.waits.begin("server-auth")!;
    await setImmediate();
    h.waits.setPolicyWaiting(true);
    await setImmediate();
    h.setIdle(true);
    h.emit("agent_settled");
    h.emit("agent_end");
    await setImmediate();
    assert.deepEqual(h.states(), [working, auth, policy]);
    h.waits.setPolicyWaiting(false);
    await setImmediate();
    closeAuth();
    closeAuth();
    await setImmediate();
    assert.deepEqual(h.states(), [working, auth, policy, auth]);
    closeSecondAuth();
    h.emit("ui_prompt_end");
    await setImmediate();
    assert.deepEqual(h.states(), [working, auth, policy, auth, ready]);
    assert.ok(!JSON.stringify(h.calls.map(({req}) => req)).includes("private request"));
});

test("cancelled sign-in requests cannot start or retain waits", async () => {
    const h = harness();
    assert.equal(h.listeners(), 0);
    h.emit("session_start", {reason: "startup"});
    await setImmediate();
    const request = new AbortController();
    const finish = h.waits.begin("server-auth", request.signal);
    await setImmediate();
    request.abort();
    await setImmediate();
    assert.equal(h.waits.begin("server-auth", request.signal), undefined);
    finish?.();
    await setImmediate();
    assert.deepEqual(h.states(), [ready, auth, ready]);
    h.emit("session_shutdown", {reason: "quit"});
    assert.equal(h.listeners(), 0);
});

test("policy raised while the root is idle restores idle or newly started work on close", async () => {
    const h = harness();
    h.emit("session_start", {reason: "startup"});
    await setImmediate();
    h.waits.setPolicyWaiting(true);
    await setImmediate();
    h.waits.setPolicyWaiting(false);
    await setImmediate();
    h.waits.setPolicyWaiting(true);
    await setImmediate();
    h.setIdle(false);
    h.emit("agent_start");
    await setImmediate();
    h.waits.setPolicyWaiting(false);
    await setImmediate();
    assert.deepEqual(h.states(), [ready, policy, ready, policy, working]);
});

test("manual compaction counts as root work; success or failure clears it", async () => {
    const h = harness();
    h.emit("session_start", {reason: "startup"});
    await setImmediate();
    h.emit("session_before_compact", {reason: "threshold"});
    h.emit("session_compact", {reason: "threshold"});
    await setImmediate();
    h.emit("session_before_compact", {reason: "manual"});
    await setImmediate();
    h.emit("session_compact_failed", {reason: "manual", errorMessage: "private failure"});
    await setImmediate();
    h.emit("session_before_compact", {reason: "manual"});
    await setImmediate();
    h.emit("session_compact", {reason: "manual"});
    await setImmediate();
    assert.deepEqual(h.states(), [ready, working, ready, working, ready]);
});

test("shutdown aborts pending IPC without erasing resume identity; replacement orders registration first", async () => {
    let unblock: (() => void) | undefined;
    const h = harness({send: async (_endpoint, _req, signal) => {
        if (unblock) return "accepted";
        await new Promise<void>((resolve) => {
            unblock = resolve;
            signal.addEventListener("abort", () => resolve(), {once: true});
        });
        return "unavailable";
    }});
    h.emit("session_start", {reason: "startup"});
    const staleAuth = h.waits.begin("server-auth")!;
    assert.equal(h.calls.length, 1);
    assert.equal(h.listeners(), 1);
    h.emit("session_shutdown", {reason: "resume"});
    assert.ok(h.calls[0]!.signal.aborted);
    assert.equal(h.listeners(), 0);
    h.waits.close();
    h.setIdentity("relative-path-is-not-a-session-reference", "replacement-id");
    h.emit("session_start", {reason: "resume"});
    staleAuth();
    h.waits.setPolicyWaiting(true); // Late callback from Pilot's old policy runtime.
    h.bus.emit(PILOT_HUMAN_WAIT, {kind: "policy", signal: AbortSignal.abort()});
    assert.equal(h.listeners(), 1);
    await setImmediate();
    assert.deepEqual(h.calls.map(({req}) => req.method), [
        "pane.report_agent_session", "pane.report_agent_session", "pane.report_agent",
    ]);
    assert.equal(h.calls[1]!.req.params.session_start_source, "resume");
    assert.equal(h.calls[1]!.req.params.agent_session_id, "replacement-id");
    assert.equal(h.calls[2]!.req.params.agent_session_id, "replacement-id");
    assert.deepEqual(h.states(), [ready]);
    h.emit("session_shutdown", {reason: "quit"});
    h.emit("agent_start");
    h.waits.setPolicyWaiting(true);
    await setImmediate();
    assert.equal(h.calls.length, 3);
});

test("a slow or failing socket only retains the latest unsent state", async () => {
    let failed: (() => void) | undefined;
    const h = harness({send: async () => {
        if (failed) return "accepted";
        return new Promise<never>((_resolve, reject) => { failed = () => reject(new Error("unavailable")); });
    }});
    h.emit("session_start", {reason: "startup"});
    h.setIdle(false);
    h.emit("agent_start");
    h.waits.setPolicyWaiting(true);
    h.waits.setPolicyWaiting(false);
    h.waits.setPolicyWaiting(true);
    assert.equal(h.calls.length, 1);
    failed?.();
    await setTimeout(300);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.states(), [policy]);
});

test("a lost idle report gets a bounded retry without further Pi events", async () => {
    let drop = false;
    const h = harness({send: async (_endpoint, req) => {
        if (!drop || req.params.state !== "idle") return "accepted";
        drop = false;
        return "unavailable";
    }});
    h.emit("session_start", {reason: "startup"});
    await setImmediate();
    h.waits.setPolicyWaiting(true);
    await setImmediate();
    drop = true;
    h.waits.setPolicyWaiting(false);
    await setTimeout(300);
    assert.deepEqual(h.states(), [ready, policy, ready, ready]);
});

test("a failed replacement registration retains the reason on the next run", async () => {
    let failures = 2;
    const h = harness({send: async (_endpoint, req) => req.method === "pane.report_agent_session" && failures-- > 0
        ? "unavailable" : "accepted"});
    h.setIdentity("/invalid\nabsolute\u0080path", "fallback-id");
    h.emit("session_start", {reason: "fork"});
    await setTimeout(300);
    h.setIdle(false);
    h.emit("agent_start");
    await setImmediate();
    const registrations = h.calls.map(({req}) => req).filter((req) => req.method === "pane.report_agent_session");
    assert.deepEqual(registrations.map(({params}) => [params.session_start_source, params.agent_session_id]),
        [["fork", "fallback-id"], ["fork", "fallback-id"], ["fork", "fallback-id"]]);
});

test("local IPC retries an invalid response and accepts a fragmented matching reply", {timeout: 5000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilot-herdr-test-"));
    const socketName = join(directory, "api.sock");
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketName}` : socketName;
    const received: HerdrRequest[] = [];
    const server = createServer((socket) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            const input = Buffer.concat(chunks);
            if (input.at(-1) !== 10) return;
            const request = JSON.parse(input.toString("utf8")) as HerdrRequest;
            received.push(request);
            if (received.length === 1) {
                socket.end(JSON.stringify({id: "wrong-id", result: {type: "ok"}}) + "\n");
                return;
            }
            socket.write(`{"id":${JSON.stringify(request.id)},`);
            setImmediate().then(() => socket.end('"result":{"type":"ok"}}\n'));
        });
    });
    try {
        server.listen(endpoint);
        await once(server, "listening");
        const request: HerdrRequest = {
            id: "test-1", method: "pane.report_agent",
            params: {pane_id: "w1:p2", source: "herdr:pi", agent: "pi", seq: 1, state: "idle"},
        };
        assert.equal(await sendHerdrRequest(endpoint, request, new AbortController().signal), "accepted");
        assert.deepEqual(received, [request, request]);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, {recursive: true, force: true});
    }
});
