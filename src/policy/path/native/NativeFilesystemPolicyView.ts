import {isDeepStrictEqual} from "node:util";
import type {ToolCallPathPolicyEvaluator} from "../../PolicyRuntime.js";
import {policyScopeCovers} from "../../PolicyScope.js";
import {
    PolicyAccessType,
    type Policy,
    PolicyResolutionSource,
    PolicyResult,
    type PolicyStatus,
    resolveUri,
} from "../../types.js";

export type NativeFilesystemPolicyLayer = {
    policies: Policy[];
    resolutionSource: PolicyResolutionSource;
};

export type NativeFilesystemPolicySnapshot = {
    revision: number;
    layers: NativeFilesystemPolicyLayer[];
};

export type NativeFilesystemPolicyEvaluation = {
    result: PolicyResult;
    baseRevision: number;
    onceSnapshot: NativeFilesystemPolicySnapshot;
};


export class NativeFilesystemPolicyBase {
    private readonly listeners = new Set<(snapshot: NativeFilesystemPolicySnapshot) => void>();
    private readonly closeListeners = new Set<() => void>();
    private revisionValue = 0;
    private closed = false;

    constructor(
        readonly agentIdentifier: string,
        private readonly policyLayers: () => NativeFilesystemPolicyLayer[],
    ) {
    }

    get revision(): number {
        if (this.closed) throw new Error("Native filesystem policy base is closed");
        return this.revisionValue;
    }

    snapshot(): NativeFilesystemPolicySnapshot {
        if (this.closed) throw new Error("Native filesystem policy base is closed");
        return this.currentSnapshot();
    }

    currentPolicyResult(path: string, accessType: PolicyAccessType): PolicyResult | undefined {
        if (this.closed) throw new Error("Native filesystem policy base is closed");
        return evaluateLayers(this.policyLayers(), path, accessType);
    }

    onSnapshotChanged(listener: (snapshot: NativeFilesystemPolicySnapshot) => void): () => void {
        if (this.closed) throw new Error("Native filesystem policy base is closed");
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onClosed(listener: () => void): () => void {
        if (this.closed) throw new Error("Native filesystem policy base is closed");
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    policyStateChanged(): void {
        if (this.closed) return;
        this.revisionValue++;
        const snapshot = this.currentSnapshot();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch {
                // One consumer must not prevent revocation publication to the others.
            }
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.closeListeners) {
            try {
                listener();
            } catch {
                // All base owners must receive closure independently.
            }
        }
        this.listeners.clear();
        this.closeListeners.clear();
    }

    private currentSnapshot(): NativeFilesystemPolicySnapshot {
        return {
            revision: this.revisionValue,
            layers: this.policyLayers().map((layer) => ({
                policies: structuredClone(layer.policies),
                resolutionSource: layer.resolutionSource,
            })),
        };
    }
}

export class NativeFilesystemPolicyView {
    private readonly onceListeners = new Set<(
        snapshot: NativeFilesystemPolicySnapshot,
    ) => void | Promise<void>>();
    private readonly closeListeners = new Set<() => void>();
    private oncePoliciesState: Policy[] = [];
    private onceRevision = 0;
    private closed = false;

    constructor(
        readonly policyBase: NativeFilesystemPolicyBase,
        private readonly evaluator: ToolCallPathPolicyEvaluator,
        private readonly oncePolicyLayer: () => NativeFilesystemPolicyLayer,
        private readonly removeFromRuntime: (view: NativeFilesystemPolicyView) => void,
    ) {
    }

    get agentIdentifier(): string {
        return this.policyBase.agentIdentifier;
    }

    get baseRevision(): number {
        this.assertOpen();
        return this.policyBase.revision;
    }

    baseSnapshot(): NativeFilesystemPolicySnapshot {
        this.assertOpen();
        return this.policyBase.snapshot();
    }

    onceSnapshot(): NativeFilesystemPolicySnapshot {
        this.assertOpen();
        return this.currentOnceSnapshot();
    }

    onOnceSnapshotChanged(
        listener: (snapshot: NativeFilesystemPolicySnapshot) => void | Promise<void>,
    ): () => void {
        this.assertOpen();
        this.onceListeners.add(listener);
        return () => this.onceListeners.delete(listener);
    }

    async evaluate(
        path: string,
        accessType: Parameters<ToolCallPathPolicyEvaluator>[1],
        signal?: AbortSignal,
    ): Promise<NativeFilesystemPolicyEvaluation> {
        this.assertOpen();
        const result = await this.evaluator(path, accessType, signal);
        this.assertOpen();
        const baseRevision = this.policyBase.revision;
        const nextOnceLayer = this.oncePolicyLayer();
        const onceChanged = (accessType === PolicyAccessType.FS_READ || accessType === PolicyAccessType.FS_WRITE)
            && !isDeepStrictEqual(this.oncePoliciesState, nextOnceLayer.policies);
        if (onceChanged) {
            this.oncePoliciesState = structuredClone(nextOnceLayer.policies);
            this.onceRevision++;
        }
        const onceSnapshot = this.currentOnceSnapshot(nextOnceLayer);
        if (onceChanged) {
            const publications = [...this.onceListeners].map(async (listener) => listener(onceSnapshot));
            const outcomes = await Promise.allSettled(publications);
            this.assertOpen();
            const failures = outcomes.flatMap((outcome) => (
                outcome.status === "rejected" ? [outcome.reason] : []
            ));
            if (failures.length > 0) {
                throw new AggregateError(failures, "Native filesystem ONCE publication failed");
            }
        }
        return {result, baseRevision, onceSnapshot};
    }

    currentPolicyResult(path: string, accessType: PolicyAccessType): PolicyResult | undefined {
        this.assertOpen();
        return this.policyBase.currentPolicyResult(path, accessType)
            ?? evaluateLayers([this.oncePolicyLayer()], path, accessType);
    }

    onClosed(listener: () => void): () => void {
        this.assertOpen();
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.closeListeners) {
            try {
                listener();
            } catch {
                // Every native mount must receive tool-view closure independently.
            }
        }
        this.onceListeners.clear();
        this.closeListeners.clear();
        this.removeFromRuntime(this);
    }

    private currentOnceSnapshot(
        layer: NativeFilesystemPolicyLayer = {
            policies: this.oncePoliciesState,
            resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
        },
    ): NativeFilesystemPolicySnapshot {
        return {
            revision: this.onceRevision,
            layers: [{
                policies: structuredClone(layer.policies),
                resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
            }],
        };
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("Native filesystem policy view is closed");
    }
}

function evaluateLayers(
    layers: NativeFilesystemPolicyLayer[],
    path: string,
    accessType: PolicyAccessType,
): PolicyResult | undefined {
    const evaluatedUri = resolveUri(accessType, path);
    for (const layer of layers) {
        const policy = layer.policies
            .filter((candidate) => candidate.info[accessType]
                && policyScopeCovers(accessType, candidate.pattern, evaluatedUri))
            .sort((left, right) => right.pattern.length - left.pattern.length)[0];
        if (!policy) continue;
        const status = policy.info[accessType] as PolicyStatus;
        return PolicyResult.of({
            evaluatedUri,
            evaluatedAccessType: accessType,
            matchedPattern: policy.pattern,
            matchedLifetime: status.lifetime,
            matchedStatus: status.status,
            matchedReason: status.reason,
            resolutionSource: layer.resolutionSource,
        });
    }
    return undefined;
}
