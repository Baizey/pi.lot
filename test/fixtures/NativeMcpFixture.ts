import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionEvent,
    ExtensionHandler,
    McpServerConfig,
    McpTransportFactory,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

export class NativeMcpFixture {
    readonly tools = new Map<string, ToolDefinition>();
    readonly commands = new Map<string, Command>();
    readonly notifications: Array<{message: string; type?: string}> = [];
    readonly handlers = new Map<string, Set<ExtensionHandler<ExtensionEvent, unknown>>>();
    readonly calls: Array<{method: string; params: unknown}> = [];
    readonly registeredServers = new Map<string, McpServerConfig>();
    active: string[] = [];
    closes = 0;
    startWait: Promise<void> | undefined;
    callResult: unknown = {content: [{type: "text", text: "fixture result"}], structuredContent: {ok: true}};
    private transports: Transport[] = [];
    private toolList = [
        {name: "echo", description: "Echo", inputSchema: {type: "object", properties: {}}, annotations: {readOnlyHint: true}},
        {name: "blocked", inputSchema: {type: "object", properties: {}}},
    ];
    private notifyToolsChanged: (() => void) | undefined;

    readonly ctx = {
        cwd: process.cwd(),
        mode: "print",
        hasUI: false,
        isProjectTrusted: () => false,
        ui: {
            notify: (message: string, type?: string) => { this.notifications.push({message, type}); },
        },
    } as unknown as ExtensionContext;

    readonly pi = {
        on: (name: string, handler: ExtensionHandler<ExtensionEvent, unknown>) => {
            const handlers = this.handlers.get(name) ?? new Set();
            this.handlers.set(name, handlers);
            handlers.add(handler);
            return () => { handlers.delete(handler); };
        },
        registerTool: (tool: ToolDefinition) => {
            this.tools.set(tool.name, tool);
            if ((tool.exposure === undefined || tool.exposure === "direct") && tool.defaultActive !== false) {
                this.active = [...new Set([...this.active, tool.name])];
            }
        },
        registerCommand: (name: string, command: Command) => { this.commands.set(name, command); },
        getMcpServers: () => [...this.registeredServers].map(([name, config]) => ({name, config, extensionPath: "fixture-extension"})),
        getAllTools: () => [...this.tools.values()],
        getActiveTools: () => this.active,
        setActiveTools: (tools: string[]) => { this.active = tools; },
    } as unknown as ExtensionAPI;

    readonly createTransport: McpTransportFactory = (entry) => {
        const listeners = new Set<Parameters<Transport["onMessage"]>[0]>();
        const closes = new Set<Parameters<Transport["onClose"]>[0]>();
        let closed = false;
        const deliver = (message: Message) => {
            if (!closed) for (const listener of listeners) listener(message);
        };
        if (entry.name === "demo") {
            this.notifyToolsChanged = () => deliver({jsonrpc: "2.0", method: "notifications/tools/list_changed"});
        }
        const transport: Transport = {
            start: async () => {
                if (entry.name === "offline") throw new Error("fixture offline");
                await this.startWait;
            },
            onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
            onError() { return () => {}; },
            onClose(listener) { closes.add(listener); return () => { closes.delete(listener); }; },
            close: async () => {
                if (closed) return;
                closed = true;
                this.closes++;
                for (const listener of closes) listener();
            },
            send: async (message) => {
                if (!("method" in message) || !("id" in message)) return;
                this.calls.push({method: message.method, params: message.params});
                let result: unknown;
                switch (message.method) {
                    case "initialize":
                        result = {
                            protocolVersion: "2025-11-25", capabilities: {tools: {}, resources: {}},
                            serverInfo: {name: "fixture", version: "1"}, instructions: "Fixture namespace instructions",
                        };
                        break;
                    case "tools/list":
                        result = {tools: this.toolList};
                        break;
                    case "tools/call":
                        result = this.callResult;
                        break;
                    case "resources/list":
                        result = {resources: [{name: "note", uri: "fixture://note"}]};
                        break;
                    case "resources/templates/list":
                        result = {resourceTemplates: []};
                        break;
                    case "resources/read":
                        result = {contents: [{uri: "fixture://note", text: "fixture resource"}]};
                        break;
                    default:
                        throw new Error(`Unexpected fixture request: ${message.method}`);
                }
                queueMicrotask(() => deliver({jsonrpc: "2.0", id: message.id, result}));
            },
        };
        this.transports.push(transport);
        return transport;
    };

    async emit(name: string): Promise<void> {
        const event = {type: name} as ExtensionEvent;
        for (const handler of this.handlers.get(name) ?? []) await handler(event, this.ctx);
    }

    async changeTools(names: string[]): Promise<void> {
        this.toolList = this.toolList.filter((tool) => names.includes(tool.name));
        this.notifyToolsChanged?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    async close(): Promise<void> {
        await Promise.all(this.transports.map((transport) => transport.close()));
    }
}
