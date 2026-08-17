export class UiDecisionFlowQueue {
    private readonly closeController = new AbortController();
    private tail: Promise<void> = Promise.resolve();

    get signal(): AbortSignal {
        return this.closeController.signal;
    }

    enqueue<T>(run: () => Promise<T>): Promise<T> {
        const result = this.tail.then(run, run);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    close(): void {
        this.closeController.abort();
    }
}
