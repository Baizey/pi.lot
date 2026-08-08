import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import PolicyRuntime from "../policy/PolicyRuntime";
import {PolicyDao} from "../storage/PolicyDao";
import {SqliteDatabase} from "../storage/sqlite.js";
import {UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";
import {ToolDisplayController} from "../tui/tool/ToolDisplayController.js";
import {PolicyDecisionFlow} from "../policy/PolicyDecisionFlow";

export type PilotSessionRuntimeHandle = Pick<
    PilotSessionRuntime,
    "policyRuntime" | "decisionFlows" | "toolDisplay" | "close"
>;

export type PilotSessionRuntimeOptions = {
    openDatabase?: () => SqliteDatabase;
};

export class PilotSessionRuntime {
    readonly policyRuntime: PolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;
    readonly toolDisplay: ToolDisplayController;

    private database: SqliteDatabase | null;

    constructor(ctx: ExtensionContext, options: PilotSessionRuntimeOptions = {}) {
        const database = (options.openDatabase ?? (() => SqliteDatabase.readwrite("pilot")))();
        try {
            const policyDao = new PolicyDao(database);
            policyDao.initializeSchema();

            const uiManager = new UiDecisionFlowManager(ctx)
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
        const database = this.database;
        this.database = null;
        database?.close();
    }
}
