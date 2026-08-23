import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {PolicyRuntime} from "../policy/PolicyRuntime.js";
import {SdkSubagentSessionFactory} from "./SdkSubagentSession.js";
import {SubagentCoordinator, type SubagentCoordinatorOptions} from "./SubagentCoordinator.js";
import {SubagentToolkitRegistry} from "./SubagentToolkitRegistry.js";
import {SubagentToolkit, type SubagentToolkitProvider} from "./types.js";

export type SubagentCapabilities = {
    bash: SubagentToolkitProvider;
    mcp: SubagentToolkitProvider;
    delegate: SubagentToolkitProvider;
};

export class SubagentRuntime {
    readonly toolkits = new SubagentToolkitRegistry();

    private activeCoordinator: SubagentCoordinator | undefined;

    constructor(
        capabilities: SubagentCapabilities,
        private readonly coordinatorOptions: SubagentCoordinatorOptions = {},
    ) {
        this.toolkits.register(SubagentToolkit.BASH, capabilities.bash);
        this.toolkits.register(SubagentToolkit.MCP, capabilities.mcp);
        this.toolkits.register(SubagentToolkit.DELEGATE, capabilities.delegate);
    }

    async startSession(ctx: ExtensionContext, policyRuntime: PolicyRuntime): Promise<void> {
        if (this.activeCoordinator) throw new Error("Subagent session is already started");
        this.activeCoordinator = new SubagentCoordinator(
            new SdkSubagentSessionFactory(ctx, policyRuntime),
            this.toolkits,
            this.coordinatorOptions,
        );
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
