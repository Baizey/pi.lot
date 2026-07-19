import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PathPolicyRuntime} from "../policy/path/PathPolicyRuntime.js";
import {PathPolicyDao} from "../storage/PathPolicyDao.js";
import {SqliteDatabase} from "../storage/sqlite.js";
import {UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";

export type PilotSessionRuntimeOptions = {
    openDatabase?: () => SqliteDatabase;
};

export class PilotSessionRuntime {
    readonly pathPolicy: PathPolicyRuntime;
    readonly decisionFlows: UiDecisionFlowManager;

    private database: SqliteDatabase | null;

    constructor(ctx: ExtensionContext, options: PilotSessionRuntimeOptions = {}) {
        const database = (options.openDatabase ?? (() => SqliteDatabase.readwrite("pilot")))();
        try {
            const pathPolicyDao = new PathPolicyDao(database).initializeSchema();
            this.pathPolicy = new PathPolicyRuntime(pathPolicyDao);
            this.decisionFlows = new UiDecisionFlowManager(ctx);
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
