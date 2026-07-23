import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PathPolicyRuntime} from "../policy/path/PathPolicyRuntime.js";
import {PathPolicyDao} from "../storage/PathPolicyDao.js";
import {SqliteDatabase} from "../storage/sqlite.js";
import {UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";
import {ToolDisplayController} from "../tui/tool/ToolDisplayController.js";
import {PilotRuntimeConfig} from "./PilotRuntimeConfig.js";

export type PilotSessionRuntimeHandle = Pick<
    PilotSessionRuntime,
    "config" | "pathPolicy" | "decisionFlows" | "toolDisplay" | "close"
>;

export type PilotSessionRuntimeOptions = {
    config?: PilotRuntimeConfig;
    openDatabase?: () => SqliteDatabase;
};

export class PilotSessionRuntime {
    readonly config: PilotRuntimeConfig;
    readonly pathPolicy: PathPolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;
    readonly toolDisplay: ToolDisplayController;

    private database: SqliteDatabase | null;

    constructor(ctx: ExtensionContext, options: PilotSessionRuntimeOptions = {}) {
        this.config = options.config ?? new PilotRuntimeConfig();
        const database = (options.openDatabase ?? (() => SqliteDatabase.readwrite("pilot")))();
        try {
            const pathPolicyDao = new PathPolicyDao(database).initializeSchema();
            this.pathPolicy = new PathPolicyRuntime(pathPolicyDao);
            this.decisionFlows = new UiDecisionFlowManager(ctx);
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
