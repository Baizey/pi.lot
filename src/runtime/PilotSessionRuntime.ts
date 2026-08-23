import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import PolicyRuntime from "../policy/PolicyRuntime";
import {PolicyDao} from "../storage/PolicyDao";
import {SqliteDatabase} from "../storage/sqlite.js";
import {UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";
import {UiDecisionFlowQueue} from "../tui/UiDecisionFlowQueue.js";
import {PolicyDecisionFlow} from "../policy/PolicyDecisionFlow";
import {PolicyDefaultJsonStorage, PolicyDefaultJsonStorageInterface} from "../policy/defaults";
import type {HostCredentialIpcOptions} from "../policy/network/ipc/HostCredentialIpc.js";
import {
    HostCredentialIpcConfigStore,
    type HostCredentialIpcConfigStoreInterface,
} from "../policy/network/ipc/HostCredentialIpcConfig.js";

export type PilotSessionRuntimeOptions = {
    openDatabase?: () => SqliteDatabase;
    policyDefaultsStore?: PolicyDefaultJsonStorageInterface;
    credentialIpcConfigStore?: HostCredentialIpcConfigStoreInterface;
};

export type PilotSessionRuntimeInterface = {
    readonly policyRuntime: PolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;
    readonly fullNetworkInspection: boolean;
    readonly hostCredentialIpc?: HostCredentialIpcOptions;
    setFullNetworkInspection(enabled: boolean): void;
    close(): void
}

export class PilotSessionRuntime implements PilotSessionRuntimeInterface {
    readonly policyRuntime: PolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;
    readonly hostCredentialIpc: HostCredentialIpcOptions;

    private readonly decisionFlowQueue: UiDecisionFlowQueue;
    private database: SqliteDatabase | null;
    private fullNetworkInspectionEnabled = true;

    constructor(ctx: ExtensionContext, options: PilotSessionRuntimeOptions = {}) {
        this.decisionFlowQueue = new UiDecisionFlowQueue();
        const database = (options.openDatabase ?? (() => SqliteDatabase.readwrite("pilot")))();
        try {
            const policyDao = new PolicyDao(database);
            policyDao.initializeSchema();

            const uiManager = new UiDecisionFlowManager(ctx, this.decisionFlowQueue)
            const pathDecisionFlow = new PolicyDecisionFlow({decisionFlows: uiManager})

            const defaultsStore = options.policyDefaultsStore ?? new PolicyDefaultJsonStorage();
            this.policyRuntime = new PolicyRuntime(
                ctx.sessionManager.getSessionId(),
                policyDao,
                pathDecisionFlow,
                defaultsStore,
            );
            this.decisionFlows = uiManager;
            this.hostCredentialIpc = (
                options.credentialIpcConfigStore ?? new HostCredentialIpcConfigStore()
            ).load(process.env);
            this.database = database;
        } catch (error) {
            database.close();
            throw error;
        }
    }

    get fullNetworkInspection(): boolean {
        return this.fullNetworkInspectionEnabled;
    }

    setFullNetworkInspection(enabled: boolean): void {
        this.fullNetworkInspectionEnabled = enabled;
    }

    close(): void {
        this.decisionFlowQueue.close();
        const database = this.database;
        this.database = null;
        database?.close();
    }
}
