import {POLICY_AREAS, PolicyArea} from "../policy/types.js";

export enum AgentMechanismCapability {
    mcp = "mcp",
    delegate = "delegate",
}

export type AgentCapability = PolicyArea | AgentMechanismCapability;

export const AGENT_CAPABILITIES: readonly AgentCapability[] = Object.freeze([
    ...POLICY_AREAS,
    ...Object.values(AgentMechanismCapability),
]);

const KNOWN_CAPABILITIES = new Set<string>(AGENT_CAPABILITIES);
const POLICY_CAPABILITIES = new Set<string>(POLICY_AREAS);
const MECHANISM_CAPABILITIES = new Set<string>(Object.values(AgentMechanismCapability));

export class AgentCapabilitySet {
    private readonly capabilities: AgentCapability[];

    constructor(capabilities: readonly AgentCapability[]) {
        const unique = [...new Set(capabilities)];
        for (const capability of unique) {
            if (!KNOWN_CAPABILITIES.has(capability)) {
                throw new Error(`Unknown agent capability: ${String(capability)}`);
            }
        }
        this.capabilities = unique;
    }

    all(): AgentCapability[] {
        return [...this.capabilities];
    }

    policyAreas(): PolicyArea[] {
        return this.capabilities.filter(isPolicyArea);
    }

    mechanisms(): AgentMechanismCapability[] {
        return this.capabilities.filter(isMechanismCapability);
    }

    hasMechanism(capability: AgentMechanismCapability): boolean {
        return this.capabilities.includes(capability);
    }
}

export function isPolicyArea(capability: AgentCapability): capability is PolicyArea {
    return POLICY_CAPABILITIES.has(capability);
}

export function isMechanismCapability(
    capability: AgentCapability,
): capability is AgentMechanismCapability {
    return MECHANISM_CAPABILITIES.has(capability);
}
