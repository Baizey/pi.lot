import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import PolicyRuntime from "../policy/PolicyRuntime";
import {PolicyDao} from "../storage/PolicyDao";
import {SqliteDatabase} from "../storage/sqlite.js";
import {UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";
import {UiDecisionFlowQueue} from "../tui/UiDecisionFlowQueue.js";
import {ToolDisplayController} from "../tui/tool/ToolDisplayController.js";
import {PolicyDecisionFlow} from "../policy/PolicyDecisionFlow";

export type PilotSessionRuntimeOptions = {
    openDatabase?: () => SqliteDatabase;
};

export type PilotSessionRuntimeInterface = {
    readonly policyRuntime: PolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;
    readonly toolDisplay: ToolDisplayController;
    close(): void
}

export class PilotSessionRuntime implements PilotSessionRuntimeInterface {
    readonly policyRuntime: PolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;
    readonly toolDisplay: ToolDisplayController;

    private readonly decisionFlowQueue: UiDecisionFlowQueue;
    private database: SqliteDatabase | null;

    constructor(ctx: ExtensionContext, options: PilotSessionRuntimeOptions = {}) {
        this.decisionFlowQueue = new UiDecisionFlowQueue();
        const database = (options.openDatabase ?? (() => SqliteDatabase.readwrite("pilot")))();
        try {
            const policyDao = new PolicyDao(database);
            policyDao.initializeSchema();

            const uiManager = new UiDecisionFlowManager(ctx, this.decisionFlowQueue)
            const pathDecisionFlow = new PolicyDecisionFlow({decisionFlows: uiManager})

            this.policyRuntime = new PolicyRuntime(policyDao, pathDecisionFlow);
            this.decisionFlows = uiManager;
            this.toolDisplay = new ToolDisplayController(ctx);
            this.database = database;
        } catch (error) {
            database.close();
            throw error;
        }
    }

    close(): void {
        this.decisionFlowQueue.close();
        const database = this.database;
        this.database = null;
        database?.close();
    }
}
