import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {SubagentToolkit, type SubagentToolkitProvider} from "./types.js";

export class SubagentToolkitRegistry {
    private readonly providers = new Map<SubagentToolkit, SubagentToolkitProvider>();

    register(toolkit: SubagentToolkit, provider: SubagentToolkitProvider): void {
        if (this.providers.has(toolkit)) throw new Error(`Subagent toolkit is already registered: ${toolkit}`);
        this.providers.set(toolkit, provider);
    }

    available(): SubagentToolkit[] {
        return [...this.providers.keys()];
    }

    resolve(toolkits: SubagentToolkit[]): ToolDefinition<any, any>[] {
        const definitions = new Map<string, ToolDefinition<any, any>>();
        for (const toolkit of uniqueToolkits(toolkits)) {
            const provider = this.providers.get(toolkit);
            if (!provider) throw new Error(`Subagent toolkit is not available: ${toolkit}`);
            for (const definition of provider()) definitions.set(definition.name, definition);
        }
        return [...definitions.values()];
    }
}

export function uniqueToolkits(toolkits: SubagentToolkit[]): SubagentToolkit[] {
    return [...new Set(toolkits)];
}
