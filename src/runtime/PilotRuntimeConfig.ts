export type NetworkPolicyGranularity = Readonly<{
    distinguishOperation: boolean;
    distinguishAddressFamily: boolean;
}>;

export type PilotRuntimeConfigInput = {
    networkPolicyGranularity?: Partial<NetworkPolicyGranularity>;
};

export class PilotRuntimeConfig {
    readonly networkPolicyGranularity: NetworkPolicyGranularity;

    constructor(input: PilotRuntimeConfigInput = {}) {
        const granularity = input.networkPolicyGranularity;
        this.networkPolicyGranularity = {
            distinguishOperation: granularity?.distinguishOperation ?? false,
            distinguishAddressFamily: granularity?.distinguishAddressFamily ?? false,
        };
    }
}
