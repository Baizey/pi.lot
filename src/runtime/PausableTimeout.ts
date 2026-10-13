import {performance} from "node:perf_hooks";

export type PausableTimeoutOptions = {
    unref?: boolean;
    now?: () => number;
};

/** A one-shot timeout whose budget counts only time spent without pause tokens. */
export class PausableTimeout {
    private readonly now: () => number;
    private readonly unref: boolean;
    private onTimeout: (() => void) | undefined;
    private remaining: number;
    private startedAt: number | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private pauses = 0;
    private disposed = false;
    private didExpire = false;

    constructor(
        milliseconds: number,
        onTimeout: () => void,
        options: PausableTimeoutOptions = {},
    ) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
            throw new RangeError("Pausable timeout must be a non-negative finite number");
        }
        this.remaining = milliseconds;
        this.onTimeout = onTimeout;
        this.now = options.now ?? (() => performance.now());
        this.unref = options.unref === true;
        this.arm();
    }

    get expired(): boolean {
        return this.didExpire;
    }

    /**
     * Releases are idempotent; overlapping pauses resume only after the last release.
     * If the budget is already exhausted, pause invokes the timeout synchronously.
     */
    pause(): () => void {
        if (this.disposed || this.didExpire) return () => {};
        if (this.pauses === 0) {
            this.consumeElapsed();
            this.cancelTimer();
            // A wait cannot rescue a budget already exhausted before it began.
            if (this.remaining <= 0) {
                this.expire();
                return () => {};
            }
        }
        this.pauses++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.pauses--;
            if (this.pauses === 0 && !this.disposed && !this.didExpire) this.arm();
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.onTimeout = undefined;
        this.cancelTimer();
        this.startedAt = undefined;
    }

    private arm(): void {
        this.startedAt = this.now();
        // Node clamps larger delays to 1ms. Long budgets must instead run in chunks.
        const delay = Math.min(this.remaining, 2_147_483_647);
        this.timer = setTimeout(() => {
            this.consumeElapsed();
            this.cancelTimer();
            if (this.remaining <= 0) this.expire();
            else this.arm();
        }, delay);
        if (this.unref) this.timer.unref();
    }

    private expire(): void {
        this.didExpire = true;
        const callback = this.onTimeout;
        this.onTimeout = undefined;
        callback?.();
    }

    private consumeElapsed(): void {
        if (this.startedAt === undefined) return;
        this.remaining = Math.max(0, this.remaining - Math.max(0, this.now() - this.startedAt));
        this.startedAt = undefined;
    }

    private cancelTimer(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }
}
