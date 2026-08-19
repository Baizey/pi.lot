import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {SdkSubagentSessionFactory} from "./SdkSubagentSession.js";
import {SubagentCoordinator, type SubagentCoordinatorOptions} from "./SubagentCoordinator.js";
import {SubagentToolkitRegistry} from "./SubagentToolkitRegistry.js";
import {SubagentToolkit, type SubagentToolkitProvider} from "./types.js";

export type SubagentCapabilities = {
    bash: SubagentToolkitProvider;
    mcp: SubagentToolkitProvider;
    delegate: SubagentToolkitProvider;
};

export type SubagentRuntimeServices = {
    createCoordinator?: (
        ctx: ExtensionContext,
        toolkits: SubagentToolkitRegistry,
    ) => SubagentCoordinator;
    coordinatorOptions?: SubagentCoordinatorOptions;
};

export interface SubagentRuntimeInterface {
    startSession(ctx: ExtensionContext): Promise<void>;
    stopSession(): Promise<void>;
    coordinator(): SubagentCoordinator;
}

export class SubagentRuntime implements SubagentRuntimeInterface {
    readonly toolkits = new SubagentToolkitRegistry();

    private readonly createCoordinator: (
        ctx: ExtensionContext,
        toolkits: SubagentToolkitRegistry,
    ) => SubagentCoordinator;
    private activeCoordinator: SubagentCoordinator | undefined;

    constructor(
        capabilities: SubagentCapabilities,
        services: SubagentRuntimeServices = {},
    ) {
        this.createCoordinator = services.createCoordinator
            ?? ((ctx, toolkits) => new SubagentCoordinator(
                new SdkSubagentSessionFactory(ctx),
                toolkits,
                services.coordinatorOptions,
            ));
        this.toolkits.register(SubagentToolkit.BASH, capabilities.bash);
        this.toolkits.register(SubagentToolkit.MCP, capabilities.mcp);
        this.toolkits.register(SubagentToolkit.DELEGATE, capabilities.delegate);
    }

    async startSession(ctx: ExtensionContext): Promise<void> {
        if (this.activeCoordinator) throw new Error("Subagent session is already started");
        this.activeCoordinator = this.createCoordinator(ctx, this.toolkits);
    }

    async stopSession(): Promise<void> {
        const coordinator = this.activeCoordinator;
        this.activeCoordinator = undefined;
        await coordinator?.close();
    }

    coordinator(): SubagentCoordinator {
        if (!this.activeCoordinator) throw new Error("Subagent session is not available");
        return this.activeCoordinator;
    }
}
