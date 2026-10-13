import {AsyncLocalStorage} from "node:async_hooks";
import {PausableTimeout, type PausableTimeoutOptions} from "./PausableTimeout.js";

export type ApprovalWaitTimeout = {
    dispose(): void;
};

/** Owns approval waits and execution-budget timers, without pausing unrelated timers. */
export class ApprovalWaitScope {
    private static readonly context = new AsyncLocalStorage<ApprovalWaitScope>();
    private readonly waits = new Set<() => void>();
    private readonly listeners = new Set<(waiting: boolean) => void>();
    private readonly timers = new Map<PausableTimeout, (() => void) | undefined>();
    private waitingState = false;
    private closed = false;

    /** Parentage is explicit: omitting parent creates a detached scope, even inside run(). */
    constructor(private readonly parent?: ApprovalWaitScope) {}

    static current(): ApprovalWaitScope | undefined {
        return this.context.getStore();
    }

    run<T>(operation: () => T): T {
        return ApprovalWaitScope.context.run(this, operation);
    }

    get waiting(): boolean {
        return this.waits.size > 0;
    }

    beginWait(): () => void {
        if (this.closed) return () => {};
        let releaseParent: (() => void) | undefined;
        const release = () => {
            if (!this.waits.delete(release)) return;
            try {
                releaseParent?.();
            } finally {
                this.updateWaiting();
            }
        };
        this.waits.add(release);
        try {
            releaseParent = this.parent?.beginWait();
            // A parent listener may have closed this scope during propagation.
            if (!this.waits.has(release)) releaseParent?.();
            this.updateWaiting();
        } catch (error) {
            release();
            throw error;
        }
        return release;
    }

    /** Notifies synchronously on subscription (including false after close), then on transitions. */
    subscribe(listener: (waiting: boolean) => void): () => void {
        if (this.closed) {
            listener(false);
            return () => {};
        }
        // Each subscription owns its registration, even when callbacks are identical.
        const registered = (waiting: boolean) => listener(waiting);
        this.listeners.add(registered);
        try {
            registered(this.waiting);
        } catch (error) {
            this.listeners.delete(registered);
            throw error;
        }
        return () => { this.listeners.delete(registered); };
    }

    setTimeout(
        callback: () => void,
        milliseconds: number,
        options?: PausableTimeoutOptions,
    ): ApprovalWaitTimeout {
        if (this.closed) throw new Error("Cannot register a timeout on a closed approval wait scope");
        const timeout = new PausableTimeout(milliseconds, () => {
            this.detachTimer(timeout);
            callback();
        }, options);
        this.timers.set(timeout, undefined);
        if (this.waiting) this.pauseTimer(timeout);
        return {dispose: () => this.detachTimer(timeout)};
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        // Dispose first: releasing waits must never restart this scope's timers.
        for (const timeout of this.timers.keys()) this.detachTimer(timeout);
        const errors: unknown[] = [];
        for (const release of [...this.waits]) {
            try {
                release();
            } catch (error) {
                errors.push(error);
            }
        }
        this.listeners.clear();
        if (errors.length > 0) throw new AggregateError(errors, "Approval wait scope close failed");
    }

    private updateWaiting(): void {
        const waiting = this.waiting;
        if (waiting === this.waitingState) return;
        this.waitingState = waiting;
        const errors: unknown[] = [];
        for (const [timeout, resume] of [...this.timers]) {
            if (!this.timers.has(timeout)) continue;
            try {
                if (waiting) this.pauseTimer(timeout);
                else {
                    this.timers.set(timeout, undefined);
                    resume?.();
                }
            } catch (error) {
                errors.push(error);
            }
        }
        // Expiring a budget while pausing it can synchronously close this scope.
        if (this.waitingState === waiting) {
            for (const listener of [...this.listeners]) {
                if (!this.listeners.has(listener) || this.waitingState !== waiting) continue;
                try {
                    listener(waiting);
                } catch (error) {
                    errors.push(error);
                }
            }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Approval wait scope notification failed");
    }

    private pauseTimer(timeout: PausableTimeout): void {
        const resume = timeout.pause();
        if (this.timers.has(timeout)) this.timers.set(timeout, resume);
        else resume();
    }

    private detachTimer(timeout: PausableTimeout): void {
        this.timers.delete(timeout);
        timeout.dispose();
    }
}
