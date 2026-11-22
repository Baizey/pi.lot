import type {EventBus} from "@earendil-works/pi-coding-agent";

// A fixed kind and lifetime only: never pass message text, request data, or credentials.
export const PILOT_HUMAN_WAIT = "pi.lot:human-wait";
export type PilotHumanWait = {kind: "policy" | "server-auth"; signal: AbortSignal};

export class PilotHumanWaits {
    private readonly session = new AbortController();
    private finishPolicy: (() => void) | undefined;

    constructor(private readonly events: EventBus) {}

    setPolicyWaiting(active: boolean): void {
        if (active) {
            this.finishPolicy ??= this.begin("policy");
        } else {
            this.finishPolicy?.();
            this.finishPolicy = undefined;
        }
    }

    begin(kind: PilotHumanWait["kind"], request?: AbortSignal): (() => void) | undefined {
        if (this.session.signal.aborted || request?.aborted) return;
        const span = new AbortController();
        const signals = [this.session.signal, span.signal];
        if (request) signals.push(request);
        const event: PilotHumanWait = {kind, signal: AbortSignal.any(signals)};
        this.events.emit(PILOT_HUMAN_WAIT, event);
        return () => span.abort();
    }

    close(): void {
        this.session.abort();
        this.finishPolicy = undefined;
    }
}
