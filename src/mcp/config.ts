import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    defaultMcpConnectTimeoutMs,
    defaultMcpListToolsTimeoutMs,
    defaultMcpToolMaxTotalTimeoutMs,
    defaultMcpToolTimeoutMs,
    McpCommandAction,
    type McpConfigSnapshot,
    type McpHttpServerConfig,
    type McpServerConfig,
    type McpServerToolExposure,
    type McpStdioServerConfig,
    McpToolExposureToken,
    McpTransportKind,
} from "./types.js";

const serverNamePattern = /^[A-Za-z0-9_-]+$/;

export class McpConfigStore {
    constructor(readonly file = defaultMcpConfigFile()) {}

    load(): McpConfigSnapshot {
        if (!fs.existsSync(this.file)) return emptyMcpConfig();
        try {
            return sanitizeMcpConfig(JSON.parse(fs.readFileSync(this.file, "utf8")));
        } catch {
            return emptyMcpConfig();
        }
    }

    save(config: McpConfigSnapshot): void {
        fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
        fs.writeFileSync(this.file, `${JSON.stringify(sanitizeMcpConfig(config), null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        fs.chmodSync(this.file, 0o600);
    }

    setToolExposure(
        serverName: string,
        mode: McpCommandAction.EXPOSE | McpCommandAction.HIDE,
        tools: string[],
    ): McpConfigSnapshot {
        return this.updateServer(serverName, (server) => setToolExposure(server, mode, tools));
    }

    resetToolExposure(serverName: string, tools?: string[]): McpConfigSnapshot {
        return this.updateServer(serverName, (server) => resetToolExposure(server, tools));
    }

    private updateServer(serverName: string, update: (server: McpServerConfig) => McpServerConfig): McpConfigSnapshot {
        const config = this.load();
        const server = config.servers[serverName];
        if (!server) return config;
        config.servers[serverName] = update(server);
        this.save(config);
        return config;
    }
}

export function defaultMcpConfigFile(): string {
    return path.join(os.homedir(), ".pilot", "mcp.json");
}

export function emptyMcpConfig(): McpConfigSnapshot {
    return {servers: {}};
}

export function sanitizeMcpConfig(value: unknown): McpConfigSnapshot {
    if (!isRecord(value)) return emptyMcpConfig();
    const rawServers = isRecord(value.servers) ? value.servers : {};
    const servers: Record<string, McpServerConfig> = {};

    for (const [rawName, rawServer] of Object.entries(rawServers)) {
        const name = rawName.trim();
        if (!serverNamePattern.test(name)) continue;
        const server = sanitizeMcpServerConfig(rawServer);
        if (server) servers[name] = server;
    }
    return {servers};
}

export function exposedMcpTools(server: McpServerConfig, tools: string[]): string[] {
    const expose = new Set(server.tools.expose ?? []);
    const hide = new Set(server.tools.hide ?? []);
    return tools.filter((tool) => {
        if (hide.has(McpToolExposureToken.ALL) || hide.has(tool)) return false;
        return expose.has(McpToolExposureToken.ALL) || expose.has(tool);
    });
}

export function shouldExposeMcpTool(server: McpServerConfig, toolName: string): boolean {
    return exposedMcpTools(server, [toolName]).length === 1;
}

export function normalizeMcpToolList(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(values
        .map((value) => typeof value === "string" ? value.trim() : "")
        .filter(Boolean))];
}

function sanitizeMcpServerConfig(value: unknown): McpServerConfig | null {
    if (!isRecord(value)) return null;
    const rawTransport = typeof value.transport === "string" ? value.transport.trim().toLowerCase() : undefined;
    const inferredTransport = typeof value.url === "string"
        ? McpTransportKind.HTTP
        : typeof value.command === "string"
            ? McpTransportKind.STDIO
            : undefined;
    const transport = normalizeMcpTransport(rawTransport) ?? inferredTransport;
    if (!transport) return null;

    const base = sanitizeBaseServerConfig(value);
    if (transport === McpTransportKind.STDIO) {
        const command = typeof value.command === "string" ? value.command.trim() : "";
        if (!command) return null;
        const server: McpStdioServerConfig = {
            ...base,
            transport,
            command,
            args: normalizeStringArray(value.args),
            env: sanitizeStringRecord(value.env),
        };
        const cwd = typeof value.cwd === "string" ? value.cwd.trim() : "";
        if (cwd) server.cwd = cwd;
        return server;
    }

    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (!isHttpUrl(url)) return null;
    return {
        ...base,
        transport,
        url,
        headers: sanitizeStringRecord(value.headers),
    } satisfies McpHttpServerConfig;
}

function sanitizeBaseServerConfig(value: Record<string, unknown>) {
    return {
        enabled: value.enabled !== false,
        autoConnect: value.autoConnect !== false,
        tools: sanitizeToolExposure(value.tools),
        connectTimeoutMs: positiveInt(value.connectTimeoutMs) ?? defaultMcpConnectTimeoutMs,
        listToolsTimeoutMs: positiveInt(value.listToolsTimeoutMs) ?? defaultMcpListToolsTimeoutMs,
        toolTimeoutMs: positiveInt(value.toolTimeoutMs) ?? defaultMcpToolTimeoutMs,
        toolMaxTotalTimeoutMs: positiveInt(value.toolMaxTotalTimeoutMs) ?? defaultMcpToolMaxTotalTimeoutMs,
    };
}

function sanitizeToolExposure(value: unknown): McpServerToolExposure {
    if (!isRecord(value)) return {};
    const rawHide = normalizeMcpToolList(value.hide);
    const hide = rawHide.includes(McpToolExposureToken.ALL) ? [McpToolExposureToken.ALL] : rawHide;
    const rawExpose = hide.includes(McpToolExposureToken.ALL)
        ? []
        : normalizeMcpToolList(value.expose).filter((tool) => !hide.includes(tool));
    const expose = rawExpose.includes(McpToolExposureToken.ALL) ? [McpToolExposureToken.ALL] : rawExpose;
    return {
        ...(expose.length > 0 ? {expose} : {}),
        ...(hide.length > 0 ? {hide} : {}),
    };
}

function setToolExposure(
    server: McpServerConfig,
    mode: McpCommandAction.EXPOSE | McpCommandAction.HIDE,
    tools: string[],
): McpServerConfig {
    const expose = new Set(server.tools.expose ?? []);
    const hide = new Set(server.tools.hide ?? []);
    for (const tool of normalizeMcpToolList(tools)) {
        if (mode === McpCommandAction.EXPOSE) {
            expose.add(tool);
            hide.delete(tool);
        } else {
            hide.add(tool);
            expose.delete(tool);
        }
    }
    return {...server, tools: normalizeExposureSets(expose, hide)};
}

function resetToolExposure(server: McpServerConfig, tools?: string[]): McpServerConfig {
    if (!tools || tools.length === 0 || tools.includes(McpToolExposureToken.ALL)) {
        return {...server, tools: {}};
    }
    const cleanTools = new Set(normalizeMcpToolList(tools));
    return {
        ...server,
        tools: normalizeExposureSets(
            new Set((server.tools.expose ?? []).filter((tool) => !cleanTools.has(tool))),
            new Set((server.tools.hide ?? []).filter((tool) => !cleanTools.has(tool))),
        ),
    };
}

function normalizeExposureSets(expose: Set<string>, hide: Set<string>): McpServerToolExposure {
    const rawHide = [...hide].sort();
    const hideList = rawHide.includes(McpToolExposureToken.ALL) ? [McpToolExposureToken.ALL] : rawHide;
    const rawExpose = hideList.includes(McpToolExposureToken.ALL)
        ? []
        : [...expose].filter((tool) => !hide.has(tool)).sort();
    const exposeList = rawExpose.includes(McpToolExposureToken.ALL) ? [McpToolExposureToken.ALL] : rawExpose;
    return {
        ...(exposeList.length > 0 ? {expose: exposeList} : {}),
        ...(hideList.length > 0 ? {hide: hideList} : {}),
    };
}

function normalizeMcpTransport(value: string | undefined): McpTransportKind | null {
    if (value === McpTransportKind.STDIO) return McpTransportKind.STDIO;
    if (value === McpTransportKind.HTTP) return McpTransportKind.HTTP;
    return null;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function positiveInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
