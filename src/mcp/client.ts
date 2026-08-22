import path from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {getDefaultEnvironment, StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CallToolResultSchema, type Tool} from "@modelcontextprotocol/sdk/types.js";
import type {RequestOptions} from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
    McpClientFactory,
    McpClientRequestOptions,
    McpConfigSnapshot,
    McpProgress,
    McpServerClient,
    McpServerConfig,
    McpStdioServerConfig,
    McpTool,
    McpToolCallResult,
} from "./types.js";
import {McpTransportKind} from "./types.js";

export enum McpConnectionState {
    DISCONNECTED = "disconnected",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    ERROR = "error",
}

export type McpServerRuntimeState = {
    serverName: string;
    state: McpConnectionState;
    toolCount: number;
    error?: string;
};

export class McpManager {
    private readonly clients = new Map<string, McpServerClient>();
    private readonly tools = new Map<string, McpTool[]>();
    private readonly states = new Map<string, McpServerRuntimeState>();
    private readonly pendingCloses = new Set<Promise<void>>();
    private config: McpConfigSnapshot;
    private baseCwd = process.cwd();

    constructor(
        initialConfig: McpConfigSnapshot,
        private readonly clientFactory: McpClientFactory = createSdkMcpClient,
    ) {
        this.config = initialConfig;
        for (const serverName of Object.keys(initialConfig.servers)) {
            this.setState(serverName, McpConnectionState.DISCONNECTED);
        }
    }

    setBaseCwd(cwd: string): void {
        this.baseCwd = cwd;
    }

    updateConfig(config: McpConfigSnapshot): void {
        const previous = this.config;
        this.config = config;
        for (const [serverName, client] of this.clients) {
            const previousServer = previous.servers[serverName];
            const nextServer = config.servers[serverName];
            if (!nextServer || !nextServer.enabled || !sameMcpConnectionConfig(previousServer, nextServer)) {
                this.clients.delete(serverName);
                this.tools.delete(serverName);
                this.setState(serverName, McpConnectionState.DISCONNECTED);
                this.scheduleClose(client);
            }
        }
        for (const serverName of Object.keys(config.servers)) {
            if (!this.states.has(serverName)) this.setState(serverName, McpConnectionState.DISCONNECTED);
        }
    }

    snapshot(): {config: McpConfigSnapshot; states: McpServerRuntimeState[]} {
        return {
            config: this.config,
            states: Object.keys(this.config.servers).map((serverName) => this.stateFor(serverName)),
        };
    }

    toolsFor(serverName: string): McpTool[] {
        return [...(this.tools.get(serverName) ?? [])];
    }

    async connect(serverName: string, signal?: AbortSignal): Promise<McpTool[]> {
        const server = this.requireEnabledServer(serverName);
        const existing = this.clients.get(serverName);
        if (existing && this.stateFor(serverName).state === McpConnectionState.CONNECTED) {
            return this.toolsFor(serverName);
        }

        const client = existing ?? this.clientFactory(serverName, resolveServerConfig(server, this.baseCwd));
        this.clients.set(serverName, client);
        this.setState(serverName, McpConnectionState.CONNECTING);
        try {
            await withTimeout(
                client.connect(signal),
                server.connectTimeoutMs,
                signal,
                `MCP connect timed out after ${server.connectTimeoutMs}ms for ${serverName}.`,
            );
            const tools = await withTimeout(
                client.listTools(signal),
                server.listToolsTimeoutMs,
                signal,
                `MCP tools/list timed out after ${server.listToolsTimeoutMs}ms for ${serverName}.`,
            );
            this.tools.set(serverName, tools);
            this.setState(serverName, McpConnectionState.CONNECTED, tools.length);
            return tools;
        } catch (error) {
            this.setState(serverName, McpConnectionState.ERROR, 0, errorMessage(error));
            await client.close().catch(() => undefined);
            this.clients.delete(serverName);
            this.tools.delete(serverName);
            throw error;
        }
    }

    async connectAuto(signal?: AbortSignal): Promise<void> {
        for (const [serverName, server] of Object.entries(this.config.servers)) {
            if (!server.enabled || !server.autoConnect) continue;
            await this.connect(serverName, signal).catch((error) => {
                this.setState(serverName, McpConnectionState.ERROR, 0, errorMessage(error));
            });
        }
    }

    async refresh(serverName: string, signal?: AbortSignal): Promise<McpTool[]> {
        const server = this.requireEnabledServer(serverName);
        const client = this.clients.get(serverName);
        if (!client || this.stateFor(serverName).state !== McpConnectionState.CONNECTED) {
            return await this.connect(serverName, signal);
        }
        try {
            const tools = await withTimeout(
                client.listTools(signal),
                server.listToolsTimeoutMs,
                signal,
                `MCP tools/list timed out after ${server.listToolsTimeoutMs}ms for ${serverName}.`,
            );
            this.tools.set(serverName, tools);
            this.setState(serverName, McpConnectionState.CONNECTED, tools.length);
            return tools;
        } catch (error) {
            this.setState(serverName, McpConnectionState.ERROR, 0, errorMessage(error));
            await client.close().catch(() => undefined);
            this.clients.delete(serverName);
            this.tools.delete(serverName);
            throw error;
        }
    }

    async disconnect(serverName: string): Promise<void> {
        const client = this.clients.get(serverName);
        this.clients.delete(serverName);
        this.tools.delete(serverName);
        this.setState(serverName, McpConnectionState.DISCONNECTED);
        if (client) await client.close();
    }

    async disconnectAll(): Promise<void> {
        await Promise.all([...this.clients.keys()].map((serverName) => this.disconnect(serverName).catch(() => undefined)));
        await Promise.all([...this.pendingCloses]);
    }

    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>,
        options: Omit<McpClientRequestOptions, "timeout" | "maxTotalTimeout"> & {
            timeout?: number;
            maxTotalTimeout?: number;
        } = {},
    ): Promise<McpToolCallResult> {
        const server = this.requireEnabledServer(serverName);
        const client = this.clients.get(serverName) ?? await this.connectAndReturnClient(serverName, options.signal);
        return await client.callTool(toolName, args, {
            signal: options.signal,
            timeout: options.timeout ?? server.toolTimeoutMs,
            maxTotalTimeout: options.maxTotalTimeout ?? server.toolMaxTotalTimeoutMs,
            resetTimeoutOnProgress: options.resetTimeoutOnProgress ?? true,
            onprogress: options.onprogress,
        });
    }

    private scheduleClose(client: McpServerClient): void {
        const closing = client.close().catch(() => undefined).finally(() => {
            this.pendingCloses.delete(closing);
        });
        this.pendingCloses.add(closing);
    }

    private requireEnabledServer(serverName: string): McpServerConfig {
        const server = this.config.servers[serverName];
        if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
        if (!server.enabled) throw new Error(`MCP server is disabled: ${serverName}`);
        return server;
    }

    private async connectAndReturnClient(serverName: string, signal?: AbortSignal): Promise<McpServerClient> {
        await this.connect(serverName, signal);
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`MCP server did not connect: ${serverName}`);
        return client;
    }

    private stateFor(serverName: string): McpServerRuntimeState {
        return this.states.get(serverName) ?? {
            serverName,
            state: McpConnectionState.DISCONNECTED,
            toolCount: 0,
        };
    }

    private setState(
        serverName: string,
        state: McpConnectionState,
        toolCount = this.tools.get(serverName)?.length ?? 0,
        error?: string,
    ): void {
        this.states.set(serverName, {serverName, state, toolCount, ...(error ? {error} : {})});
    }
}

export function createSdkMcpClient(_serverName: string, config: McpServerConfig): McpServerClient {
    const client = new Client({name: "pilot", version: "0.1.0"}, {capabilities: {}});
    const transport = config.transport === McpTransportKind.STDIO
        ? new StdioClientTransport(stdioTransportParams(config))
        : new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: {headers: resolveStringRecord(config.headers)},
        });

    return {
        async connect(signal?: AbortSignal): Promise<void> {
            await client.connect(transport, {signal, timeout: config.connectTimeoutMs});
        },
        async listTools(signal?: AbortSignal): Promise<McpTool[]> {
            const tools: McpTool[] = [];
            let cursor: string | undefined;
            do {
                const page = await client.listTools(cursor ? {cursor} : undefined, {
                    signal,
                    timeout: config.listToolsTimeoutMs,
                });
                tools.push(...page.tools.map(normalizeSdkTool));
                cursor = page.nextCursor;
            } while (cursor);
            return tools;
        },
        async callTool(
            toolName: string,
            args: Record<string, unknown>,
            options: McpClientRequestOptions,
        ): Promise<McpToolCallResult> {
            return await client.callTool(
                {name: toolName, arguments: args},
                CallToolResultSchema,
                requestOptions(options),
            ) as McpToolCallResult;
        },
        async close(): Promise<void> {
            await client.close();
        },
    };
}

function requestOptions(options: McpClientRequestOptions): RequestOptions {
    return {
        signal: options.signal,
        timeout: options.timeout,
        maxTotalTimeout: options.maxTotalTimeout,
        resetTimeoutOnProgress: options.resetTimeoutOnProgress,
        onprogress: options.onprogress as (progress: McpProgress) => void,
    };
}

function stdioTransportParams(config: McpStdioServerConfig): ConstructorParameters<typeof StdioClientTransport>[0] {
    return {
        command: config.command,
        args: config.args,
        cwd: config.cwd ? path.resolve(config.cwd) : undefined,
        env: {...getDefaultEnvironment(), ...resolveStringRecord(config.env)},
        // The SDK pipes stderr into an unread PassThrough whose source pipe has no error listener.
        // Ignoring it preserves the existing quiet behavior without leaving ECONNRESET unhandled.
        stderr: "ignore",
    };
}

function sameMcpConnectionConfig(left: McpServerConfig | undefined, right: McpServerConfig): boolean {
    if (!left) return false;
    return JSON.stringify(mcpConnectionConfig(left)) === JSON.stringify(mcpConnectionConfig(right));
}

function mcpConnectionConfig(config: McpServerConfig): Omit<McpServerConfig, "tools" | "autoConnect"> {
    const {tools: _tools, autoConnect: _autoConnect, ...connection} = config;
    return connection;
}

function normalizeSdkTool(tool: Tool): McpTool {
    return {
        name: tool.name,
        ...(tool.title ? {title: tool.title} : {}),
        ...(tool.description ? {description: tool.description} : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        ...(tool.annotations ? {annotations: tool.annotations} : {}),
    };
}

function resolveServerConfig(config: McpServerConfig, cwd: string): McpServerConfig {
    if (config.transport === McpTransportKind.STDIO && config.cwd) {
        return {...config, cwd: path.resolve(cwd, config.cwd)};
    }
    return config;
}

function resolveStringRecord(input: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, resolveConfigValue(value)]));
}

function resolveConfigValue(value: string): string {
    return value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_match, braced: string | undefined, bare: string | undefined) => {
            const key = braced ?? bare;
            return key ? process.env[key] ?? "" : "";
        },
    );
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    message: string,
): Promise<T> {
    if (signal?.aborted) throw abortSignalReason(signal);
    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = () => settle(() => reject(signal ? abortSignalReason(signal) : new Error("Operation aborted.")));
        timer = setTimeout(() => settle(() => reject(new Error(message))), timeoutMs);
        signal?.addEventListener("abort", onAbort, {once: true});
        promise.then(
            (value) => settle(() => resolve(value)),
            (error) => settle(() => reject(error)),
        );
    });
}

function abortSignalReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason ?? "Operation aborted."));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
