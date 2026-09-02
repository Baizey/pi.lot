import type {Readable, Writable} from "node:stream";
import {PolicyAccessType, PolicyResponse} from "../../types.js";
import {
    decodeNativeFilesystemControlFrames,
    decodeNativeFilesystemPolicyMiss,
    encodeNativeFilesystemOnceSnapshotMessage,
    encodeNativeFilesystemResolutionMessage,
    NativeFilesystemAccess,
    NativeFilesystemDecision,
    NativeFilesystemRequestMessage,
} from "./NativeFilesystemPolicyProtocol.js";
import type {
    NativeFilesystemPolicyEvaluation,
    NativeFilesystemPolicySnapshot,
    NativeFilesystemPolicyView,
} from "./NativeFilesystemPolicyView.js";

const PARTIAL_FRAME_TIMEOUT_MILLISECONDS = 5_000;
const WRITE_TIMEOUT_MILLISECONDS = 5_000;

export class NativeFilesystemPolicyBridge {
    private remainder = Buffer.alloc(0);
    private writeQueue = Promise.resolve();
    private snapshotPublishQueue = Promise.resolve();
    private requestQueue = Promise.resolve();
    private lastPublishedOnceRevision = -1;
    private synchronizedOnceRevision: number | undefined;
    private readonly unsubscribeOnceSnapshot: () => void;
    private readonly unsubscribeViewClose: () => void;
    private partialFrameTimer: NodeJS.Timeout | undefined;
    private closed = false;
    private reportedError = false;

    constructor(
        private readonly view: NativeFilesystemPolicyView,
        private readonly requests: Readable,
        private readonly responses: Writable,
        private readonly onError: (error: Error) => void,
        private readonly signal?: AbortSignal,
        private readonly onDeny?: (message: string) => void,
        private readonly onReady?: (baseRevision: bigint, onceRevision: bigint) => void,
    ) {
        this.unsubscribeOnceSnapshot = view.onOnceSnapshotChanged(async (snapshot) => {
            try {
                await this.publishOnceSnapshot(snapshot);
            } catch (error) {
                this.reportError(error);
                throw error;
            }
        });
        this.unsubscribeViewClose = view.onClosed(() => {
            this.reportError(new Error("Native filesystem policy view closed"));
        });
        requests.on("data", this.handleData);
        requests.on("error", this.handleStreamError);
        requests.on("end", this.handleStreamClose);
        requests.on("close", this.handleStreamClose);
        responses.on("error", this.handleStreamError);
        responses.on("close", this.handleStreamClose);
    }

    synchronizeSnapshot(): Promise<void> {
        const snapshot = this.view.onceSnapshot();
        this.synchronizedOnceRevision ??= snapshot.revision;
        return this.publishOnceSnapshot(snapshot);
    }

    fail(error: unknown): void {
        this.reportError(error);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribeOnceSnapshot();
        this.unsubscribeViewClose();
        this.clearPartialFrameTimeout();
        this.requests.off("data", this.handleData);
        this.requests.off("error", this.handleStreamError);
        this.requests.off("end", this.handleStreamClose);
        this.requests.off("close", this.handleStreamClose);
        this.responses.off("error", this.handleStreamError);
        this.responses.off("close", this.handleStreamClose);
    }

    private readonly handleData = (chunk: Buffer): void => {
        if (this.closed) return;
        try {
            const decoded = decodeNativeFilesystemControlFrames(Buffer.concat([this.remainder, chunk]));
            this.remainder = Buffer.from(decoded.remainder);
            if (this.remainder.length > 0) this.armPartialFrameTimeout();
            else this.clearPartialFrameTimeout();
            for (const frame of decoded.frames) {
                if (frame.type === NativeFilesystemRequestMessage.READY) {
                    if (frame.payload.length !== 16) {
                        throw new Error("Native filesystem ready message has an unexpected payload");
                    }
                    const baseRevision = frame.payload.readBigUInt64LE(0);
                    const onceRevision = frame.payload.readBigUInt64LE(8);
                    if (baseRevision > BigInt(this.view.baseRevision)
                        || this.synchronizedOnceRevision === undefined
                        || onceRevision !== BigInt(this.synchronizedOnceRevision)) {
                        throw new Error(
                            `Native filesystem ready revisions are not synchronized: `
                            + `base=${baseRevision} once=${onceRevision}`,
                        );
                    }
                    this.onReady?.(baseRevision, onceRevision);
                    continue;
                }
                const event = decodeNativeFilesystemPolicyMiss(frame.payload);
                if (frame.type === NativeFilesystemRequestMessage.MISS) {
                    this.requestQueue = this.requestQueue
                        .then(() => this.resolveMiss(event))
                        .catch((error: unknown) => this.reportError(error));
                    continue;
                }
                if (frame.type === NativeFilesystemRequestMessage.DENIAL) {
                    this.requestQueue = this.requestQueue
                        .then(() => this.reportKnownDenial(event))
                        .catch((error: unknown) => this.reportError(error));
                    continue;
                }
                throw new Error(`Unexpected native filesystem request message: ${frame.type}`);
            }
        } catch (error) {
            this.reportError(error);
        }
    };

    private readonly handleStreamError = (error: Error): void => {
        if (!this.closed) this.reportError(error);
    };

    private readonly handleStreamClose = (): void => {
        if (!this.closed) this.reportError(new Error("Native filesystem control channel closed"));
    };

    private armPartialFrameTimeout(): void {
        if (this.partialFrameTimer) return;
        this.partialFrameTimer = setTimeout(() => {
            this.partialFrameTimer = undefined;
            this.reportError(new Error("Native filesystem control frame timed out before completion"));
        }, PARTIAL_FRAME_TIMEOUT_MILLISECONDS);
        this.partialFrameTimer.unref();
    }

    private clearPartialFrameTimeout(): void {
        if (!this.partialFrameTimer) return;
        clearTimeout(this.partialFrameTimer);
        this.partialFrameTimer = undefined;
    }

    private async resolveMiss(miss: ReturnType<typeof decodeNativeFilesystemPolicyMiss>): Promise<void> {
        let decision = NativeFilesystemDecision.DENY;
        let evaluatedState: NativeFilesystemPolicyEvaluation | undefined;
        try {
            if (miss.baseRevision > BigInt(this.view.baseRevision)) {
                throw new Error(
                    `Native filesystem base revision ${miss.baseRevision} `
                    + `is ahead of JavaScript revision ${this.view.baseRevision}`,
                );
            }
            const onceSnapshot = this.view.onceSnapshot();
            if (miss.onceRevision > BigInt(onceSnapshot.revision)) {
                throw new Error(
                    `Native filesystem ONCE revision ${miss.onceRevision} `
                    + `is ahead of JavaScript revision ${onceSnapshot.revision}`,
                );
            }
            const accessType = miss.access === NativeFilesystemAccess.READ
                ? PolicyAccessType.FS_READ
                : PolicyAccessType.FS_WRITE;
            const evaluation = await this.evaluateUntilAborted(miss.path, accessType);
            if (evaluation) {
                evaluatedState = evaluation;
                decision = evaluation.result.matchedStatus === PolicyResponse.ALLOWED
                    ? NativeFilesystemDecision.ALLOW
                    : NativeFilesystemDecision.DENY;
                if (decision === NativeFilesystemDecision.DENY) {
                    this.notifyDeny(evaluation.result.toDenyMessage());
                }
            }
        } catch (error) {
            this.notifyError(error);
        }

        const baseRevision = evaluatedState?.baseRevision ?? this.view.baseRevision;
        const onceSnapshot = evaluatedState?.onceSnapshot ?? this.view.onceSnapshot();
        await this.publishOnceSnapshot(onceSnapshot);
        await this.enqueueWrite(encodeNativeFilesystemResolutionMessage(
            miss.requestId,
            baseRevision,
            onceSnapshot.revision,
            decision,
        ));
    }

    private reportKnownDenial(event: ReturnType<typeof decodeNativeFilesystemPolicyMiss>): void {
        const accessType = event.access === NativeFilesystemAccess.READ
            ? PolicyAccessType.FS_READ
            : PolicyAccessType.FS_WRITE;
        const onceSnapshot = this.view.onceSnapshot();
        if (event.baseRevision === BigInt(this.view.baseRevision)
            && event.onceRevision === BigInt(onceSnapshot.revision)) {
            const result = this.view.currentPolicyResult(event.path, accessType);
            if (result?.matchedStatus === PolicyResponse.DENIED) {
                this.notifyDeny(result.toDenyMessage());
                return;
            }
        }
        this.notifyDeny([
            "ACCESS DENIED",
            `The uri '${event.path}' had an attempted access of type ${accessType}`,
            "The native filesystem policy state denied the operation.",
        ].join("\n"));
    }

    private evaluateUntilAborted(
        path: string,
        accessType: PolicyAccessType,
    ): Promise<NativeFilesystemPolicyEvaluation | undefined> {
        const signal = this.signal;
        if (!signal) return this.view.evaluate(path, accessType);
        if (signal.aborted) return Promise.resolve(undefined);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (evaluation: NativeFilesystemPolicyEvaluation | undefined) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                resolve(evaluation);
            };
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                reject(error);
            };
            const onAbort = () => finish(undefined);
            signal.addEventListener("abort", onAbort, {once: true});
            if (signal.aborted) {
                onAbort();
                return;
            }
            void this.view.evaluate(path, accessType, signal).then(finish, fail);
        });
    }

    private publishOnceSnapshot(snapshot: NativeFilesystemPolicySnapshot): Promise<void> {
        const publish = this.snapshotPublishQueue.then(async () => {
            if (snapshot.revision < this.lastPublishedOnceRevision) {
                throw new Error(
                    `Native filesystem ONCE revision moved backward from `
                    + `${this.lastPublishedOnceRevision} to ${snapshot.revision}`,
                );
            }
            if (snapshot.revision === this.lastPublishedOnceRevision) return;
            await this.enqueueWrite(encodeNativeFilesystemOnceSnapshotMessage(snapshot));
            this.lastPublishedOnceRevision = snapshot.revision;
        });
        this.snapshotPublishQueue = publish.catch(() => undefined);
        return publish;
    }

    private enqueueWrite(bytes: Buffer): Promise<void> {
        if (this.closed) return Promise.reject(new Error("Native filesystem policy bridge is closed"));
        const write = this.writeQueue.then(() => new Promise<void>((resolve, reject) => {
            let settled = false;
            let timeout: NodeJS.Timeout | undefined;
            const finish = (error?: Error | null) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                if (error) reject(error);
                else resolve();
            };
            timeout = setTimeout(
                () => finish(new Error("Native filesystem control write timed out")),
                WRITE_TIMEOUT_MILLISECONDS,
            );
            timeout.unref();
            try {
                this.responses.write(bytes, finish);
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        }));
        this.writeQueue = write.catch(() => undefined);
        return write;
    }

    private notifyError(error: unknown): void {
        try {
            this.onError(error instanceof Error ? error : new Error(String(error)));
        } catch {
            // Reporting must never strand a native policy request.
        }
    }

    private notifyDeny(message: string): void {
        try {
            this.onDeny?.(message);
        } catch {
            // Reporting must never change or strand a native policy decision.
        }
    }

    private reportError(error: unknown): void {
        if (this.reportedError || this.closed) return;
        this.reportedError = true;
        this.clearPartialFrameTimeout();
        this.notifyError(error);
        try {
            this.requests.destroy();
        } catch {
            // Continue closing the response stream.
        }
        try {
            this.responses.destroy();
        } catch {
            // Both control directions have now been given a chance to close.
        }
    }
}
