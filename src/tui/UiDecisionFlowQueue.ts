export class UiDecisionFlowQueue {
    private readonly closeController = new AbortController();
    private tail: Promise<void> = Promise.resolve();
    private outstanding = 0;

    get signal(): AbortSignal {
        return this.closeController.signal;
    }

    /** Whether another callback is queued behind the currently running callback. */
    get hasWaitingWork(): boolean {
        return this.outstanding > 1;
    }

    enqueue<T>(run: () => Promise<T>): Promise<T> {
        this.outstanding++;
        const result = this.tail.then(run, run);
        const finish = () => { this.outstanding--; };
        this.tail = result.then(finish, finish);
        return result;
    }

    close(): void {
        this.closeController.abort();
    }
}
