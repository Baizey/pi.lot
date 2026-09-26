import type PolicyRuntime from "../../src/policy/PolicyRuntime.js";
import {
    NativeFilesystemPolicyBase,
    NativeFilesystemPolicyView,
} from "../../src/policy/path/native/NativeFilesystemPolicyView.js";
import {
    type Policy,
    PolicyAccessType,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
} from "../../src/policy/types.js";

/** Revokes just the fixture file, leaving executable/library page faults authorized. */
export class RevocableReadPolicy {
    private readonly base: NativeFilesystemPolicyBase;
    private revoked = false;

    constructor(runtime: PolicyRuntime, agentIdentifier: string, target: string) {
        const seed = runtime.beginNativeFilesystemToolCall(agentIdentifier);
        const rootLayers = seed.baseSnapshot().layers;
        seed.close();
        const denial: Policy = {
            pattern: target,
            info: {
                [PolicyAccessType.FS_READ]: {
                    accessType: PolicyAccessType.FS_READ,
                    lifetime: PolicyLifetime.SESSION,
                    status: PolicyResponse.DENIED,
                    reason: "Revoke only the cache target",
                },
            },
        };
        this.base = new NativeFilesystemPolicyBase(agentIdentifier, () => [
            {
                policies: this.revoked ? [denial] : [],
                resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY,
            },
            ...rootLayers,
        ]);
    }

    createView(): NativeFilesystemPolicyView {
        return new NativeFilesystemPolicyView(
            this.base,
            async (path, access) => {
                throw new Error(`Unexpected cache-test policy miss: ${access} ${path}`);
            },
            () => ({policies: [], resolutionSource: PolicyResolutionSource.EXISTING_USER_POLICY}),
            () => undefined,
        );
    }

    revoke(): void {
        this.revoked = true;
        this.base.policyStateChanged();
    }

    close(): void {
        this.base.close();
    }
}
