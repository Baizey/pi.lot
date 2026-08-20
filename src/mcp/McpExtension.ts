import type {ExtensionAPI, ExtensionContext, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {McpManager} from "./client.js";
import {registerMcpCommand} from "./commands.js";
import {McpConfigStore} from "./config.js";
import {McpToolRegistry} from "./tools.js";
import {ToolDisplayRows} from "../tui/tool/ToolDisplayRows.js";

export type McpExtensionServices = {
    store?: McpConfigStore;
    manager?: McpManager;
    registry?: McpToolRegistry;
    displayRows?: ToolDisplayRows;
};

export interface McpExtensionInterface {
    register(): void;
    startSession(ctx: ExtensionContext): Promise<void>;
    stopSession(): Promise<void>;
    toolDefinitions(): ToolDefinition<any, any>[];
}

export class McpExtension implements McpExtensionInterface {
    readonly store: McpConfigStore;
    readonly manager: McpManager;
    readonly registry: McpToolRegistry;

    private registered = false;
    private sessionStarted = false;

    constructor(
        private readonly pi: ExtensionAPI,
        services: McpExtensionServices = {},
    ) {
        this.store = services.store ?? new McpConfigStore();
        this.manager = services.manager ?? new McpManager(this.store.load());
        this.registry = services.registry ?? new McpToolRegistry(
            pi,
            this.manager,
            this.store,
            services.displayRows,
        );
    }

    register(): void {
        if (this.registered) throw new Error("MCP extension is already registered");
        this.registered = true;
        registerMcpCommand(this.pi, {
            store: this.store,
            manager: this.manager,
            registry: this.registry,
        });
    }

    async startSession(ctx: ExtensionContext): Promise<void> {
        if (!this.registered) throw new Error("MCP extension is not registered");
        if (this.sessionStarted) throw new Error("MCP session is already started");
        this.sessionStarted = true;

        try {
            this.manager.setBaseCwd(ctx.cwd ?? process.cwd());
            const config = this.store.load();
            this.manager.updateConfig(config);
            await this.manager.connectAuto(ctx.signal);
            this.registry.registerAvailableTools(config);
        } catch (error) {
            this.sessionStarted = false;
            await this.manager.disconnectAll();
            throw error;
        }
    }

    async stopSession(): Promise<void> {
        if (!this.sessionStarted) return;
        this.sessionStarted = false;
        await this.manager.disconnectAll();
    }

    toolDefinitions(): ToolDefinition<any, any>[] {
        return this.registry.registeredToolDefinitions();
    }
}
