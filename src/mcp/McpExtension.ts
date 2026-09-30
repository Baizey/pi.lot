import {
    createMcpExtension,
    type BeforeAgentStartEvent,
    type ExtensionAPI,
    type ExtensionContext,
    type McpExtensionOptions,
    type McpServersChangeEvent,
    type SessionShutdownEvent,
    type SessionStartEvent,
    type ToolDefinition,
    type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import {McpToolRegistry} from "./McpToolRegistry.js";
import {ToolDisplayRows} from "../tui/tool/ToolDisplayRows.js";

type NativeEvent = SessionStartEvent | SessionShutdownEvent | BeforeAgentStartEvent
    | TurnStartEvent | McpServersChangeEvent;
type NativeHandler = (event: NativeEvent, ctx: ExtensionContext) => void | Promise<void>;

export type McpExtensionServices = {
    nativeOptions?: McpExtensionOptions;
    displayRows?: ToolDisplayRows;
};

export interface McpExtensionInterface {
    register(): void;
    startSession(ctx: ExtensionContext): Promise<void>;
    stopSession(): Promise<void>;
    toolDefinitions(): ToolDefinition<any, any>[];
}

/** Hosts Pi's native MCP implementation with Pilot's presentation and capability boundary. */
export class McpExtension implements McpExtensionInterface {
    private readonly registry: McpToolRegistry;
    private readonly startupHandlers = new Set<NativeHandler>();
    private readonly shutdownHandlers = new Set<NativeHandler>();
    private context: ExtensionContext | undefined;
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly services: McpExtensionServices = {},
    ) {
        this.registry = new McpToolRegistry(pi, services.displayRows);
    }

    register(): void {
        if (this.registered) throw new Error("MCP extension is already registered");
        this.registered = true;
        // Pi's overloaded on() API cannot express this restricted subset. Keep the assertion at
        // this versioned boundary; unknown native hooks fail visibly rather than bypassing ownership.
        const on = ((event: NativeEvent["type"], handler: NativeHandler) => (
            this.registerNativeHandler(event, handler)
        )) as ExtensionAPI["on"];
        createMcpExtension(this.services.nativeOptions)({
            ...this.pi,
            on,
            registerTool: (definition) => this.registry.register(definition),
        });
    }

    async startSession(ctx: ExtensionContext): Promise<void> {
        if (!this.registered) throw new Error("MCP extension is not registered");
        if (this.context) throw new Error("MCP session is already started");
        this.context = quietBackgroundContext(ctx);
        this.registry.startSession();
        try {
            for (const handler of this.startupHandlers) {
                await handler({type: "session_start", reason: "startup"}, this.context);
            }
        } catch (error) {
            await this.stopSession();
            throw error;
        }
    }

    async stopSession(): Promise<void> {
        const context = this.context;
        if (!context) return;
        this.context = undefined;
        this.registry.stopSession();
        // Pilot calls this only after stopping its children, keeping shared connections alive
        // for their cancellation and cleanup. Native shutdown is not separately registered on Pi.
        for (const handler of this.shutdownHandlers) {
            await handler({type: "session_shutdown", reason: "quit"}, context);
        }
    }

    toolDefinitions(): ToolDefinition[] {
        return this.registry.toolDefinitions();
    }

    private registerNativeHandler(event: NativeEvent["type"], handler: NativeHandler): () => void {
        switch (event) {
            case "session_start":
                this.startupHandlers.add(handler);
                return () => { this.startupHandlers.delete(handler); };
            case "session_shutdown":
                this.shutdownHandlers.add(handler);
                return () => { this.shutdownHandlers.delete(handler); };
            case "before_agent_start":
                return this.pi.on(event, (event, ctx) => handler(event, quietBackgroundContext(ctx)));
            case "turn_start":
                return this.pi.on(event, (event, ctx) => handler(event, quietBackgroundContext(ctx)));
            case "mcp_servers_change":
                return this.pi.on(event, (event, ctx) => handler(event, quietBackgroundContext(ctx)));
            default:
                throw new Error(`Unsupported native MCP lifecycle event: ${event}`);
        }
    }
}

/** Only native background connection notices are quiet; commands and actual failures are untouched. */
function quietBackgroundContext(ctx: ExtensionContext): ExtensionContext {
    const ui = new Proxy(ctx.ui, {
        get(target, property) {
            if (property !== "notify") return Reflect.get(target, property, target);
            return (message: string, type?: "info" | "warning" | "error") => {
                if (message === "MCP servers are still connecting; their tools become available once connected.") return;
                if (message.startsWith("MCP servers need attention:\n")) {
                    // The native report combines connection and configuration errors. Retain the latter
                    // so quiet optional servers cannot conceal a malformed allowlist/configuration.
                    const errors = message.split("\n").filter((line) => line.startsWith("  config: "));
                    if (errors.length === 0) return;
                    target.notify(`MCP configuration errors:\n${errors.join("\n")}\nRun /mcp to fix.`, type);
                    return;
                }
                target.notify(message, type);
            };
        },
    });
    return new Proxy(ctx, {
        get(target, property) {
            return property === "ui" ? ui : Reflect.get(target, property, target);
        },
    });
}
