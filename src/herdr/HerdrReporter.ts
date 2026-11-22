import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {isAbsolute} from "node:path";
import {setTimeout} from "node:timers/promises";
import {type HerdrRequest, type HerdrSend, type HerdrTarget, herdrTarget, sendHerdrRequest} from "./HerdrTransport.js";

// Wire compatibility: Herdr v0.9.5's Pi adapter (herdr:pi, integration version 9).
// See docs/herdr.md for the source, license, and release semantics.
const sequenceKey = Symbol.for("pi.lot.herdr.sequence");
const processSequence = globalThis as typeof globalThis & {[sequenceKey]?: number};

function nextSequence(): number {
    // Keep replacement extension instances ordered even if Pi reloads this module.
    return processSequence[sequenceKey] = Math.max(Date.now() * 1000, (processSequence[sequenceKey] ?? 0) + 1);
}

type SessionRef = {agent_session_path: string} | {agent_session_id: string};
type Params = HerdrRequest["params"];
type State = NonNullable<Params["state"]>;
type Message = Params["message"];
type Report = {method: HerdrRequest["method"]; params: Partial<Params>; ref?: SessionRef; retried?: boolean};

function validReference(value: string | undefined, maxBytes: number): value is string {
    return !!value && Buffer.byteLength(value) <= maxBytes && !/\p{Cc}/u.test(value);
}

function sessionRef(manager: ExtensionContext["sessionManager"]): SessionRef | undefined {
    try {
        const file = manager.getSessionFile();
        if (validReference(file, 4096) && isAbsolute(file)) return {agent_session_path: file};
    } catch {
        // A session without a usable file can still report its native ID.
    }
    try {
        const id = manager.getSessionId();
        if (validReference(id, 512)) return {agent_session_id: id};
    } catch {
        // A session reference is optional for state reports.
    }
}

export class HerdrReporter {
    private readonly target: HerdrTarget | undefined;
    private session: {
        controller: AbortController;
        ref?: SessionRef;
        working: boolean;
        compacting: boolean;
        policy: boolean;
        auth: number;
        startReason?: Params["session_start_source"];
        registering?: SessionRef;
        lastState?: State;
        lastMessage?: Message;
        registration?: Report;
        status?: Report;
        draining: boolean;
    } | undefined;

    constructor(env: NodeJS.ProcessEnv = process.env, private readonly send: HerdrSend = sendHerdrRequest) {
        this.target = herdrTarget(env);
    }

    register(pi: ExtensionAPI): void {
        if (!this.target) return;
        pi.on("session_start", (event, ctx) => {
            this.stop();
            if (ctx.mode !== "tui" || !ctx.hasUI) return;
            const ref = sessionRef(ctx.sessionManager);
            this.session = {
                ref,
                controller: new AbortController(),
                working: !ctx.isIdle(),
                compacting: false,
                policy: false,
                auth: 0,
                draining: false,
                startReason: event.reason,
            };
            this.publish();
        });
        pi.on("agent_start", (_event, ctx) => {
            const session = this.session;
            if (!session) return;
            const changed = this.refreshSessionRef(ctx);
            // Reaffirm the reference when a new run starts, as the official adapter does.
            if (!session.working) this.queueRegistration(session);
            session.working = true;
            this.publish(changed);
        });
        pi.on("agent_settled", (_event, ctx) => {
            if (!this.session || !ctx.isIdle()) return;
            const changed = this.refreshSessionRef(ctx);
            this.session.working = false;
            this.publish(changed);
        });
        pi.on("session_before_compact", (event) => {
            if (!this.session || event.reason !== "manual") return;
            this.session.compacting = true;
            this.publish();
        });
        pi.on("session_compact", (event) => {
            if (!this.session || event.reason !== "manual") return;
            this.session.compacting = false;
            this.publish();
        });
        pi.on("session_compact_failed", (event) => {
            if (!this.session || event.reason !== "manual") return;
            this.session.compacting = false;
            this.publish();
        });
        // Pi's UI events coalesce dialogs (including custom loaders) and dispatch asynchronously.
        // They do not track individual visible waits. Observe Pilot-owned policy/auth spans instead.
        pi.on("session_shutdown", () => this.stop());
    }

    setPolicyWaiting(active: boolean): void {
        if (!this.session) return;
        this.session.policy = active;
        this.publish();
    }

    beginServerAuthWait(): () => void {
        const session = this.session;
        if (!session) return () => {};
        session.auth++;
        this.publish();
        let ended = false;
        return () => {
            if (ended || session !== this.session) return;
            ended = true;
            session.auth--;
            this.publish();
        };
    }

    private stop(): void {
        // Herdr uses process exit to release Pi, and release_agent would clear its
        // persisted resume reference. Session replacement re-registers in the same pane.
        const session = this.session;
        this.session = undefined;
        session?.controller.abort();
    }

    private refreshSessionRef(ctx: ExtensionContext): boolean {
        const session = this.session!;
        const ref = sessionRef(ctx.sessionManager);
        if (!ref || JSON.stringify(ref) === JSON.stringify(session.ref)) return false;
        session.ref = ref;
        this.queueRegistration(session);
        return true;
    }

    private queueRegistration(session: NonNullable<HerdrReporter["session"]>): void {
        const {ref} = session;
        if (!ref || session.registering === ref || session.registration?.ref === ref) return;
        session.registration = {
            method: "pane.report_agent_session", ref,
            params: {...ref, session_start_source: session.startReason},
        };
    }

    private publish(force = false): void {
        const session = this.session!;
        // A missed replacement registration must carry its reason when next reaffirming it.
        if (session.startReason) this.queueRegistration(session);
        const message: Message = session.policy ? "Policy approval required"
            : session.auth ? "Server sign-in required"
            : undefined;
        const state: State = message ? "blocked" : session.working || session.compacting ? "working" : "idle";
        if (force || session.lastState !== state || session.lastMessage !== message) {
            session.lastState = state;
            session.lastMessage = message;
            session.status = {method: "pane.report_agent", params: {...session.ref, state, message}};
        }
        if (!session.draining && (session.registration || session.status)) void this.drain(session);
    }

    private async drain(session: NonNullable<HerdrReporter["session"]>): Promise<void> {
        const target = this.target!;
        const {signal} = session.controller;
        session.draining = true;
        // Bound backlog to the latest session registration and status. Serialize their
        // delivery because Herdr rejects out-of-order sequences for the same source.
        while (!signal.aborted) {
            const report = session.registration ?? session.status;
            if (!report) break;
            const registration = report.method === "pane.report_agent_session";
            if (registration) {
                session.registration = undefined;
                session.registering = report.ref;
            } else session.status = undefined;
            const seq = nextSequence();
            const request: HerdrRequest = {
                id: `herdr:pi:${seq}`,
                method: report.method,
                params: {...report.params, pane_id: target.paneId, source: "herdr:pi", agent: "pi", seq},
            };
            let delivery: Awaited<ReturnType<HerdrSend>>;
            try {
                delivery = await this.send(target.endpoint, request, signal);
            } catch {
                delivery = "unavailable";
            }
            if (registration) {
                session.registering = undefined;
                if (delivery === "accepted" && report.ref === session.ref) session.startReason = undefined;
            }
            if (signal.aborted || delivery !== "unavailable" || report.retried) continue;
            // Give the latest unsent state one extra bounded chance to clear a delivered
            // blocker (or register a replacement) without requiring another Pi event.
            const slot = registration ? "registration" : "status";
            if (session[slot]) continue;
            session[slot] = {...report, retried: true};
            await setTimeout(250, undefined, {signal, ref: false}).catch(() => {});
        }
        session.draining = false;
    }
}
