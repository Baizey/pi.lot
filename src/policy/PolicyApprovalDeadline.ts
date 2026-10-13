import {performance} from "node:perf_hooks";

export const DEFAULT_POLICY_APPROVAL_TIMEOUT_MILLISECONDS = 300_000;

export class PolicyApprovalTimeoutError extends Error {
    constructor(milliseconds: number, subject: string) {
        super(`${subject} timed out after ${milliseconds / 1_000} seconds.`);
        this.name = "TimeoutError";
    }
}

/** An approval watchdog and absolute deadline, deliberately independent of source budgets. */
export class PolicyApprovalDeadline {
    private readonly controller = new AbortController();
    private readonly expiresAt: number;
    private readonly timeoutReason: PolicyApprovalTimeoutError;
    private readonly timer: ReturnType<typeof setTimeout>;
    readonly signal: AbortSignal;

    constructor(
        milliseconds = DEFAULT_POLICY_APPROVAL_TIMEOUT_MILLISECONDS,
        options: {signal?: AbortSignal; subject?: string} = {},
    ) {
        this.expiresAt = performance.now() + milliseconds;
        this.timeoutReason = new PolicyApprovalTimeoutError(milliseconds, options.subject ?? "Policy approval");
        this.signal = options.signal
            ? AbortSignal.any([options.signal, this.controller.signal])
            : this.controller.signal;
        this.timer = setTimeout(() => this.controller.abort(this.timeoutReason), milliseconds);
    }

    expireIfOverdue(): void {
        // Promise continuations can run after the deadline but before an overdue timer callback.
        if (!this.signal.aborted && performance.now() >= this.expiresAt) {
            this.controller.abort(this.timeoutReason);
        }
    }

    cancel(): void {
        this.controller.abort();
    }

    dispose(): void {
        clearTimeout(this.timer);
    }
}
