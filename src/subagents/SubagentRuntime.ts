import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {PolicyRuntime} from "../policy/PolicyRuntime.js";
import {SdkSubagentSessionFactory} from "./SdkSubagentSession.js";
import {SubagentCoordinator, type SubagentCoordinatorOptions} from "./SubagentCoordinator.js";
import {SubagentToolCatalog, type SubagentToolProviders} from "./SubagentToolCatalog.js";
import type {SubagentModelPerformanceRanker} from "./SubagentModelResolver.js";

export type SubagentRuntimeOptions = {
    coordinator?: SubagentCoordinatorOptions;
    modelRanker?: SubagentModelPerformanceRanker;
};

export class SubagentRuntime {
    readonly tools: SubagentToolCatalog;

    private activeCoordinator: SubagentCoordinator | undefined;

    private readonly coordinatorOptions: SubagentCoordinatorOptions;
    private readonly modelRanker: SubagentModelPerformanceRanker | undefined;

    constructor(
        providers: SubagentToolProviders,
        options: SubagentRuntimeOptions = {},
    ) {
        this.tools = new SubagentToolCatalog(providers);
        this.coordinatorOptions = options.coordinator ?? {};
        this.modelRanker = options.modelRanker;
    }

    async startSession(ctx: ExtensionContext, policyRuntime: PolicyRuntime): Promise<void> {
        if (this.activeCoordinator) throw new Error("Subagent session is already started");
        this.activeCoordinator = new SubagentCoordinator(
            new SdkSubagentSessionFactory(ctx, this.modelRanker),
            this.tools,
            policyRuntime,
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
