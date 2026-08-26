import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {PolicyRuntime} from "../policy/PolicyRuntime.js";
import {SdkSubagentSessionFactory} from "./SdkSubagentSession.js";
import {SubagentCoordinator, type SubagentCoordinatorOptions} from "./SubagentCoordinator.js";
import {SubagentToolCatalog, type SubagentToolProviders} from "./SubagentToolCatalog.js";
import type {SubagentModelPerformanceRanker} from "./SubagentModelResolver.js";
import {
    AUTO_SUBAGENT_MODEL,
    SubagentDefaultsRuntime,
    SubagentDefaultsJsonStore,
    type SubagentDefaultsStore,
} from "./SubagentDefaults.js";
import {
    SubagentReasoningAmount,
    type SubagentReasoningSkill,
} from "./SubagentReasoning.js";

export type SubagentRuntimeOptions = {
    coordinator?: SubagentCoordinatorOptions;
    modelRanker?: SubagentModelPerformanceRanker;
    defaultsStore?: SubagentDefaultsStore;
};

export class SubagentRuntime {
    readonly tools: SubagentToolCatalog;

    private activeCoordinator: SubagentCoordinator | undefined;
    private activeSessionFactory: SdkSubagentSessionFactory | undefined;
    private activeDefaults: SubagentDefaultsRuntime | undefined;
    private activeContext: ExtensionContext | undefined;

    private readonly coordinatorOptions: SubagentCoordinatorOptions;
    private readonly modelRanker: SubagentModelPerformanceRanker | undefined;
    private readonly defaultsStore: SubagentDefaultsStore;

    constructor(
        providers: SubagentToolProviders,
        options: SubagentRuntimeOptions = {},
    ) {
        this.tools = new SubagentToolCatalog(providers);
        this.coordinatorOptions = options.coordinator ?? {};
        this.modelRanker = options.modelRanker;
        this.defaultsStore = options.defaultsStore ?? new SubagentDefaultsJsonStore();
    }

    async startSession(ctx: ExtensionContext, policyRuntime: PolicyRuntime): Promise<void> {
        if (this.activeCoordinator) throw new Error("Subagent session is already started");
        const defaults = new SubagentDefaultsRuntime(this.defaultsStore);
        const sessionFactory = new SdkSubagentSessionFactory(ctx, this.modelRanker);
        const coordinator = new SubagentCoordinator(
            sessionFactory,
            this.tools,
            policyRuntime,
            this.coordinatorOptions,
        );
        this.activeDefaults = defaults;
        this.activeContext = ctx;
        this.activeSessionFactory = sessionFactory;
        this.activeCoordinator = coordinator;
    }

    async stopSession(): Promise<void> {
        const coordinator = this.activeCoordinator;
        this.activeCoordinator = undefined;
        this.activeSessionFactory = undefined;
        this.activeDefaults = undefined;
        this.activeContext = undefined;
        await coordinator?.close();
    }

    coordinator(): SubagentCoordinator {
        if (!this.activeCoordinator) throw new Error("Subagent session is not available");
        return this.activeCoordinator;
    }

    defaults(): SubagentDefaultsRuntime {
        if (!this.activeDefaults) throw new Error("Subagent session is not available");
        return this.activeDefaults;
    }

    availableModels(): string[] {
        if (!this.activeContext) throw new Error("Subagent session is not available");
        return [...new Set(
            this.activeContext.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
        )].sort((left, right) => left.localeCompare(right));
    }

    async resolveAutomaticModel(skill: SubagentReasoningSkill): Promise<string> {
        if (!this.activeSessionFactory) throw new Error("Subagent session is not available");
        const resolved = await this.activeSessionFactory.resolveModel(
            skill,
            SubagentReasoningAmount.MID,
            AUTO_SUBAGENT_MODEL,
        );
        return `${resolved.model.provider}/${resolved.model.id}`;
    }
}
