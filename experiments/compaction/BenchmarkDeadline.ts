export type BoundedResult<T> = {status: "ok"; value: T; cleanupComplete: true}
    | {status: "error"; error: string; cleanupComplete: boolean};

/** Cancellation is cooperative: join the operation, or stop the benchmark instead of overlapping its cleanup. */
export async function boundedOperation<T>(
    run: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number,
): Promise<BoundedResult<T>> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid operation deadline");
    const controller = new AbortController();
    let removeAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, {once: true});
        removeAbort = () => controller.signal.removeEventListener("abort", abort);
    });
    const forward = () => controller.abort(parent.reason);
    parent.addEventListener("abort", forward, {once: true});
    if (parent.aborted) forward();
    const timer = setTimeout(() => controller.abort(new Error("Benchmark operation timed out")), timeoutMs);
    let settled = false;
    // Observe before invoking even nominally async code: it may throw synchronously.
    const operation = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); });
    const cleanup = operation.then(() => { settled = true; }, () => { settled = true; });
    let outcome: {status: "ok"; value: T} | {status: "error"; error: string};
    try {
        outcome = {status: "ok", value: await Promise.race([operation, aborted])};
    } catch (error) {
        outcome = {status: "error", error: error instanceof Error ? error.message : String(error)};
    } finally {
        controller.abort(new Error("Benchmark operation finished"));
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([cleanup, new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 1000); })]);
        clearTimeout(cleanupTimer);
        clearTimeout(timer);
        removeAbort();
        parent.removeEventListener("abort", forward);
    }
    if (outcome.status === "ok") return {...outcome, cleanupComplete: true};
    return {...outcome, cleanupComplete: settled};
}
