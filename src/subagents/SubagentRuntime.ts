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
import {SubagentPolicyDecisionFlow} from "./SubagentPolicyDecisionFlow.js";

export type SubagentRuntimeOptions = {
    coordinator?: SubagentCoordinatorOptions;
    modelRanker?: SubagentModelPerformanceRanker;
    defaultsStore?: SubagentDefaultsStore;
};

type ActiveSubagentSession = {
    coordinator: SubagentCoordinator;
    sessionFactory: SdkSubagentSessionFactory;
    policyApprovals: SubagentPolicyDecisionFlow;
    policyRuntime: PolicyRuntime;
    defaults: SubagentDefaultsRuntime;
    context: ExtensionContext;
};

export class SubagentRuntime {
    readonly tools: SubagentToolCatalog;

    private activeSession: ActiveSubagentSession | undefined;

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
        if (this.activeSession) throw new Error("Subagent session is already started");
        const defaults = new SubagentDefaultsRuntime(this.defaultsStore);
        const sessionFactory = new SdkSubagentSessionFactory(ctx, this.modelRanker);
        const coordinator = new SubagentCoordinator(
            sessionFactory,
            this.tools,
            policyRuntime,
            this.coordinatorOptions,
        );
        const policyApprovals = new SubagentPolicyDecisionFlow(sessionFactory, () => defaults.values);
        policyRuntime.setAgentDecisionFlow(policyApprovals);
        this.activeSession = {coordinator, sessionFactory, policyApprovals, policyRuntime, defaults, context: ctx};
    }

    async stopSession(): Promise<void> {
        const activeSession = this.activeSession;
        this.activeSession = undefined;
        activeSession?.policyRuntime.beginShutdown();
        let firstError: unknown;
        try {
            await activeSession?.policyApprovals.close();
        } catch (error) {
            firstError = error;
        }
        try {
            await activeSession?.coordinator.close();
        } catch (error) {
            firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
    }

    coordinator(): SubagentCoordinator {
        return this.requireActiveSession().coordinator;
    }

    defaults(): SubagentDefaultsRuntime {
        return this.requireActiveSession().defaults;
    }

    availableModels(): string[] {
        const {context} = this.requireActiveSession();
        return [...new Set(
            context.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
        )].sort((left, right) => left.localeCompare(right));
    }

    async resolveAutomaticModel(skill: SubagentReasoningSkill): Promise<string> {
        const resolved = await this.requireActiveSession().sessionFactory.resolveModel(
            skill,
            SubagentReasoningAmount.MID,
            AUTO_SUBAGENT_MODEL,
        );
        return `${resolved.model.provider}/${resolved.model.id}`;
    }

    private requireActiveSession(): ActiveSubagentSession {
        if (!this.activeSession) throw new Error("Subagent session is not available");
        return this.activeSession;
    }
}
