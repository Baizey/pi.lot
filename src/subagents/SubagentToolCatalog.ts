import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {AgentCapabilitySet, AgentMechanismCapability} from "./AgentCapability.js";
import type {SubagentToolProvider} from "./types.js";

export type SubagentToolProviders = {
    builtins: SubagentToolProvider;
    mcp: SubagentToolProvider;
    delegate: SubagentToolProvider;
};

export class SubagentToolCatalog {
    constructor(private readonly providers: SubagentToolProviders) {
    }

    resolve(capabilities: AgentCapabilitySet): ToolDefinition<any, any>[] {
        const definitions = new Map<string, ToolDefinition<any, any>>();
        this.addDefinitions(definitions, this.providers.builtins());
        if (capabilities.hasMechanism(AgentMechanismCapability.mcp)) {
            this.addDefinitions(definitions, this.providers.mcp());
        }
        if (capabilities.hasMechanism(AgentMechanismCapability.delegate)) {
            this.addDefinitions(definitions, this.providers.delegate());
        }
        return [...definitions.values()];
    }

    private addDefinitions(
        definitions: Map<string, ToolDefinition<any, any>>,
        additions: readonly ToolDefinition<any, any>[],
    ): void {
        for (const definition of additions) {
            const existing = definitions.get(definition.name);
            if (existing && existing !== definition) {
                throw new Error(`Subagent tool providers returned conflicting definitions: ${definition.name}`);
            }
            definitions.set(definition.name, definition);
        }
    }
}
