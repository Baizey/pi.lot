import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {McpConnectionState, McpManager, type McpServerRuntimeState} from "./client.js";
import {McpConfigStore, shouldExposeMcpTool} from "./config.js";
import {McpToolRegistry} from "./tools.js";
import {
    McpCommandAction,
    McpCommandMessageKind,
    type McpCommandResult,
    McpCommandTarget,
    type McpConfigSnapshot,
    type McpServerConfig,
    type McpTool,
    McpToolExposureStatus,
    McpToolExposureToken,
} from "./types.js";

export const MCP_COMMAND_NAME = "mcp";

type McpCommandServices = {
    store: McpConfigStore;
    manager: McpManager;
    registry: McpToolRegistry;
};

export function registerMcpCommand(pi: ExtensionAPI, services: McpCommandServices): void {
    pi.registerCommand(MCP_COMMAND_NAME, {
        description: "Manage MCP servers and persisted MCP tool exposure",
        getArgumentCompletions(prefix) {
            return mcpCommandCompletions(
                prefix,
                services.store.load(),
                (serverName) => services.manager.toolsFor(serverName).map((tool) => tool.name),
            );
        },
        async handler(args, ctx) {
            const result = await handleMcpCommand(services, args, ctx.signal);
            ctx.ui.notify(result.message, result.kind);
        },
    });
}

export async function handleMcpCommand(
    services: McpCommandServices,
    args: string,
    signal?: AbortSignal,
): Promise<McpCommandResult> {
    const tokens = tokenizeMcpCommand(args);
    const action = firstMcpAction(tokens) ?? (tokens.length === 0 ? McpCommandAction.SHOW : null);
    if (!action) return err(`Unknown /${MCP_COMMAND_NAME} action: ${tokens[0] ?? ""}`);
    const rest = tokens.slice(1);

    switch (action) {
        case McpCommandAction.SHOW:
            return showMcp(services, rest);
        case McpCommandAction.CONNECT:
            return await connectMcp(services, rest, signal);
        case McpCommandAction.DISCONNECT:
            return await disconnectMcp(services, rest);
        case McpCommandAction.REFRESH:
            return await refreshMcp(services, rest, signal);
        case McpCommandAction.EXPOSE:
        case McpCommandAction.HIDE:
            return exposeOrHideMcp(services, rest, action);
        case McpCommandAction.RESET:
            return resetMcpExposure(services, rest);
    }
}

export type McpToolCompletionProvider = (serverName: string) => string[];

export function mcpCommandCompletions(
    prefix: string,
    config: McpConfigSnapshot,
    toolNamesForServer: McpToolCompletionProvider = () => [],
): Array<{value: string; label: string}> {
    const tokens = tokenizeMcpCommand(prefix);
    const current = prefix.endsWith(" ") ? "" : tokens[tokens.length - 1] ?? "";
    const base = prefix.slice(0, prefix.length - current.length);
    if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        return completionValues(Object.values(McpCommandAction), current, base);
    }

    const action = firstMcpAction(tokens);
    const serverNames = Object.keys(config.servers);
    if (!action) return completionValues([McpCommandTarget.ALL, ...serverNames], current, base);

    if (actionUsesToolOperands(action)) {
        if (tokens.length <= 1 || (tokens.length === 2 && !prefix.endsWith(" "))) {
            return completionValues(serverNames, current, base);
        }
        const serverName = tokens[1];
        const server = serverName ? config.servers[serverName] : undefined;
        if (!server) return [];
        const values = [
            McpToolExposureToken.ALL,
            ...toolNamesForServer(serverName),
            ...(server.tools.expose ?? []),
            ...(server.tools.hide ?? []),
        ];
        return completionValues([...new Set(values.filter(Boolean))], current, base);
    }

    if (tokens.length <= 1 || (tokens.length === 2 && !prefix.endsWith(" "))) {
        return completionValues([McpCommandTarget.ALL, ...serverNames], current, base);
    }
    return [];
}

function exposeOrHideMcp(
    services: McpCommandServices,
    tokens: string[],
    mode: McpCommandAction.EXPOSE | McpCommandAction.HIDE,
): McpCommandResult {
    const [serverName, ...tools] = tokens;
    if (!serverName) return err(`Missing MCP server name for ${mode}.`);
    if (tools.length === 0) return err(`Missing MCP tool name for ${mode}.`);
    const config = services.store.load();
    if (!config.servers[serverName]) return err(`Unknown MCP server: ${serverName}`);
    const nextConfig = services.store.setToolExposure(serverName, mode, tools);
    services.manager.updateConfig(nextConfig);
    const registration = services.registry.registerAvailableTools(nextConfig);
    return ok([
        `MCP ${mode} updated for ${serverName}: ${tools.join(", ")}`,
        registration.registered.length > 0
            ? `Registered tools: ${registration.registered.map((tool) => tool.piToolName).join(", ")}`
            : undefined,
        mode === McpCommandAction.HIDE
            ? "Already registered hidden tools remain visible until /reload, but calls are blocked immediately."
            : undefined,
        "",
        formatMcpStatus(nextConfig, services.manager, serverName),
    ].filter((line): line is string => line !== undefined).join("\n"));
}

function resetMcpExposure(services: McpCommandServices, tokens: string[]): McpCommandResult {
    const [serverName, ...tools] = tokens;
    if (!serverName) return err("Missing MCP server name for reset.");
    const config = services.store.load();
    if (!config.servers[serverName]) return err(`Unknown MCP server: ${serverName}`);
    const nextConfig = services.store.resetToolExposure(serverName, tools.length > 0 ? tools : undefined);
    services.manager.updateConfig(nextConfig);
    return ok([
        tools.length > 0
            ? `MCP exposure reset for ${serverName}: ${tools.join(", ")}`
            : `MCP exposure reset for ${serverName}.`,
        "",
        formatMcpStatus(nextConfig, services.manager, serverName),
    ].join("\n"));
}

function showMcp(services: McpCommandServices, tokens: string[]): McpCommandResult {
    const config = services.store.load();
    services.manager.updateConfig(config);
    const target = tokens[0];
    if (!target || target === McpCommandTarget.ALL) {
        return ok(formatMcpStatus(config, services.manager));
    }
    if (!config.servers[target]) return err(`Unknown MCP server: ${target}`);
    return ok(formatMcpStatus(config, services.manager, target));
}

async function connectMcp(
    services: McpCommandServices,
    tokens: string[],
    signal?: AbortSignal,
): Promise<McpCommandResult> {
    const config = services.store.load();
    services.manager.updateConfig(config);
    const targets = resolveServerTargets(config, tokens[0]);
    if ("error" in targets) return err(targets.error);
    if (targets.serverNames.length === 0) return ok("No MCP servers configured.");
    const lines: string[] = [];
    for (const serverName of targets.serverNames) {
        try {
            const tools = await services.manager.connect(serverName, signal);
            const registration = services.registry.registerAvailableTools(services.store.load());
            const newlyRegistered = registration.registered.filter((tool) => tool.serverName === serverName).length;
            lines.push(`Connected ${serverName} (${tools.length} tools, ${newlyRegistered} newly registered).`);
        } catch (error) {
            lines.push(`Failed ${serverName}: ${errorMessage(error)}`);
        }
    }
    return ok(lines.join("\n"));
}

async function disconnectMcp(
    services: McpCommandServices,
    tokens: string[],
): Promise<McpCommandResult> {
    const config = services.store.load();
    services.manager.updateConfig(config);
    const targets = resolveServerTargets(config, tokens[0]);
    if ("error" in targets) return err(targets.error);
    if (targets.serverNames.length === 0) return ok("No MCP servers configured.");
    await Promise.all(targets.serverNames.map((serverName) => services.manager.disconnect(serverName).catch(() => undefined)));
    return ok(`Disconnected MCP server${targets.serverNames.length === 1 ? "" : "s"}: ${targets.serverNames.join(", ")}`);
}

async function refreshMcp(
    services: McpCommandServices,
    tokens: string[],
    signal?: AbortSignal,
): Promise<McpCommandResult> {
    const config = services.store.load();
    services.manager.updateConfig(config);
    const targets = resolveServerTargets(config, tokens[0]);
    if ("error" in targets) return err(targets.error);
    if (targets.serverNames.length === 0) return ok("No MCP servers configured.");
    const lines: string[] = [];
    for (const serverName of targets.serverNames) {
        try {
            const tools = await services.manager.refresh(serverName, signal);
            const registration = services.registry.registerAvailableTools(config);
            const newlyRegistered = registration.registered.filter((tool) => tool.serverName === serverName).length;
            lines.push(`Refreshed ${serverName} (${tools.length} tools, ${newlyRegistered} newly registered).`);
        } catch (error) {
            lines.push(`Failed ${serverName}: ${errorMessage(error)}`);
        }
    }
    return ok(lines.join("\n"));
}

export function formatMcpStatus(
    config: McpConfigSnapshot,
    manager: McpManager,
    onlyServer?: string,
): string {
    const serverEntries = Object.entries(config.servers)
        .filter(([serverName]) => !onlyServer || serverName === onlyServer);
    if (serverEntries.length === 0) {
        return onlyServer ? `MCP server not found: ${onlyServer}` : "MCP servers\n  none";
    }
    const states = new Map(manager.snapshot().states.map((state) => [state.serverName, state]));
    return [
        onlyServer ? `MCP server ${onlyServer}` : "MCP servers",
        ...serverEntries.flatMap(([serverName, server]) => formatMcpServerStatus(
            serverName,
            server,
            manager.toolsFor(serverName),
            states.get(serverName),
        )),
    ].join("\n");
}

function formatMcpServerStatus(
    serverName: string,
    server: McpServerConfig,
    tools: McpTool[],
    state: McpServerRuntimeState = {
        serverName,
        state: McpConnectionState.DISCONNECTED,
        toolCount: 0,
    },
): string[] {
    return [
        `  ${serverName}`,
        `    transport ${server.transport}`,
        `    enabled ${server.enabled ? "yes" : "no"}`,
        `    state ${state.state}${state.toolCount > 0 ? ` (${state.toolCount} tools)` : ""}`,
        ...(state.error ? [`    error ${state.error}`] : []),
        `    expose ${formatExposureList(server.tools.expose)}`,
        `    hide ${formatExposureList(server.tools.hide)}`,
        "    tools",
        ...formatMcpToolStatuses(server, tools),
    ];
}

function formatExposureList(values: string[] | undefined): string {
    if (!values || values.length === 0) return "none";
    if (values.includes(McpToolExposureToken.ALL)) {
        return ["all", ...values.filter((value) => value !== McpToolExposureToken.ALL)].join(", ");
    }
    return values.join(", ");
}

function formatMcpToolStatuses(server: McpServerConfig, tools: McpTool[]): string[] {
    if (tools.length === 0) return ["      none discovered"];
    const exposed: string[] = [];
    const hidden: string[] = [];
    for (const tool of tools) {
        (shouldExposeMcpTool(server, tool.name) ? exposed : hidden).push(tool.name);
    }
    return [
        `      ${McpToolExposureStatus.EXPOSED}`,
        ...(exposed.length > 0 ? exposed.map((name) => `        ${name}`) : ["        none"]),
        `      ${McpToolExposureStatus.NOT_EXPOSED}`,
        ...(hidden.length > 0 ? hidden.map((name) => `        ${name}`) : ["        none"]),
    ];
}

function resolveServerTargets(
    config: McpConfigSnapshot,
    target: string | undefined,
): {serverNames: string[]} | {error: string} {
    if (!target || target === McpCommandTarget.ALL) return {serverNames: Object.keys(config.servers)};
    if (!config.servers[target]) return {error: `Unknown MCP server: ${target}`};
    return {serverNames: [target]};
}

function tokenizeMcpCommand(args: string): string[] {
    return args.trim().split(/\s+/).filter(Boolean);
}

function firstMcpAction(tokens: string[]): McpCommandAction | null {
    const action = tokens[0] as McpCommandAction | undefined;
    return action && Object.values(McpCommandAction).includes(action) ? action : null;
}

function actionUsesToolOperands(action: McpCommandAction): boolean {
    return action === McpCommandAction.EXPOSE
        || action === McpCommandAction.HIDE
        || action === McpCommandAction.RESET;
}

function completionValues(
    values: readonly string[],
    current: string,
    base: string,
): Array<{value: string; label: string}> {
    return values
        .filter((value) => value.startsWith(current))
        .map((value) => ({value: `${base}${value}`, label: value}));
}

function ok(message: string): McpCommandResult {
    return {kind: McpCommandMessageKind.INFO, message};
}

function err(message: string): McpCommandResult {
    return {kind: McpCommandMessageKind.ERROR, message};
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
