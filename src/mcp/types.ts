export enum McpTransportKind {
    STDIO = "stdio",
    HTTP = "http",
}

export enum McpCommandAction {
    SHOW = "show",
    CONNECT = "connect",
    DISCONNECT = "disconnect",
    REFRESH = "refresh",
    EXPOSE = "expose",
    HIDE = "hide",
    RESET = "reset",
}

export enum McpCommandTarget {
    ALL = "all",
}

export enum McpCommandMessageKind {
    INFO = "info",
    ERROR = "error",
}

export enum McpToolExposureToken {
    ALL = "*",
}

export enum McpToolExposureStatus {
    EXPOSED = "exposed",
    NOT_EXPOSED = "not exposed",
}

export const defaultMcpConnectTimeoutMs = 15_000;
export const defaultMcpListToolsTimeoutMs = 15_000;
export const defaultMcpToolTimeoutMs = 60_000;
export const defaultMcpToolMaxTotalTimeoutMs = 5 * 60_000;

export type McpConfigSnapshot = {
    servers: Record<string, McpServerConfig>;
};

export type McpServerToolExposure = {
    expose?: string[];
    hide?: string[];
};

export type McpBaseServerConfig = {
    enabled: boolean;
    autoConnect: boolean;
    tools: McpServerToolExposure;
    connectTimeoutMs: number;
    listToolsTimeoutMs: number;
    toolTimeoutMs: number;
    toolMaxTotalTimeoutMs: number;
};

export type McpStdioServerConfig = McpBaseServerConfig & {
    transport: McpTransportKind.STDIO;
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
};

export type McpHttpServerConfig = McpBaseServerConfig & {
    transport: McpTransportKind.HTTP;
    url: string;
    headers: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpCommandResult = {
    kind: McpCommandMessageKind;
    message: string;
};

export type McpTool = {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
};

export type McpToolCallResult = {
    content?: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    toolResult?: unknown;
    [key: string]: unknown;
};

export type McpProgress = {
    progress: number;
    total?: number;
    message?: string;
};

export type McpClientRequestOptions = {
    signal?: AbortSignal;
    timeout: number;
    maxTotalTimeout?: number;
    resetTimeoutOnProgress?: boolean;
    onprogress?: (progress: McpProgress) => void;
};

export type McpServerClient = {
    connect(signal?: AbortSignal): Promise<void>;
    listTools(signal?: AbortSignal): Promise<McpTool[]>;
    callTool(toolName: string, args: Record<string, unknown>, options: McpClientRequestOptions): Promise<McpToolCallResult>;
    close(): Promise<void>;
};

export type McpClientFactory = (serverName: string, config: McpServerConfig) => McpServerClient;

export type McpToolDetails = {
    server: string;
    tool: string;
    piTool: string;
    structuredContent?: Record<string, unknown>;
    contentTypes: string[];
};
