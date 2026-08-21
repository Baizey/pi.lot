import crypto from "node:crypto";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
    ExtensionAPI,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {McpManager} from "./client.js";
import {McpConfigStore, shouldExposeMcpTool} from "./config.js";
import type {
    McpConfigSnapshot,
    McpServerConfig,
    McpTool,
    McpToolCallResult,
    McpToolDetails,
} from "./types.js";
import type {ToolPresentationSpec} from "../tui/tool/ToolPresentation.js";
import {ToolTextDirection} from "../tui/tool/ToolPresentation.js";
import {resolveToolDisplayMode} from "../tui/tool/ToolDisplayMode.js";
import {ToolPresentationRenderer} from "../tui/tool/ToolPresentationRenderer.js";
import {ToolDisplayRows} from "../tui/tool/ToolDisplayRows.js";
import {ToolStatusRail} from "../tui/tool/ToolStatusRail.js";

const maxMcpTextOutputChars = 80_000;

type McpOutputContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

export type McpToolRegistrationResult = {
    registered: Array<{ serverName: string; mcpToolName: string; piToolName: string }>;
    skipped: Array<{ serverName: string; mcpToolName: string; reason: string }>;
};

type McpToolRegistrar = Pick<ExtensionAPI, "registerTool"> & Partial<Pick<ExtensionAPI, "getAllTools">>;

export class McpToolRegistry {
    private readonly registeredPiToolNames = new Set<string>();
    private readonly registeredByServerTool = new Map<string, string>();
    private readonly definitionsByServerTool = new Map<string, {
        serverName: string;
        mcpToolName: string;
        definition: ToolDefinition<any, any>;
    }>();

    constructor(
        private readonly pi: McpToolRegistrar,
        private readonly manager: McpManager,
        private readonly store: McpConfigStore,
        private readonly displayRows: ToolDisplayRows = new ToolDisplayRows(),
    ) {
    }

    registerAvailableTools(config: McpConfigSnapshot = this.store.load()): McpToolRegistrationResult {
        const result: McpToolRegistrationResult = {registered: [], skipped: []};
        for (const tool of this.pi.getAllTools?.() ?? []) this.registeredPiToolNames.add(tool.name);
        for (const [serverName, server] of Object.entries(config.servers)) {
            const tools = this.manager.toolsFor(serverName);
            const exposed = tools.filter((tool) => shouldRegisterMcpTool(server, tool.name));
            const toolNames = buildMcpPiToolNames(
                serverName,
                exposed.map((tool) => tool.name),
                this.registeredPiToolNames,
            );
            for (const tool of tools) {
                if (!shouldRegisterMcpTool(server, tool.name)) {
                    result.skipped.push({serverName, mcpToolName: tool.name, reason: "not exposed"});
                    continue;
                }
                const piToolName = toolNames.get(tool.name);
                if (!piToolName) {
                    result.skipped.push({serverName, mcpToolName: tool.name, reason: "name generation failed"});
                    continue;
                }
                const key = serverToolKey(serverName, tool.name);
                if (this.registeredByServerTool.has(key)) continue;
                const definition = createMcpPiTool({
                    serverName,
                    mcpTool: tool,
                    piToolName,
                    manager: this.manager,
                    store: this.store,
                    displayRows: this.displayRows,
                });
                this.pi.registerTool(definition);
                this.registeredByServerTool.set(key, piToolName);
                this.definitionsByServerTool.set(key, {
                    serverName,
                    mcpToolName: tool.name,
                    definition: definition as unknown as ToolDefinition<any, any>,
                });
                this.registeredPiToolNames.add(piToolName);
                result.registered.push({serverName, mcpToolName: tool.name, piToolName});
            }
        }
        return result;
    }

    registeredToolNames(): string[] {
        return [...this.registeredPiToolNames].sort();
    }

    registeredToolDefinitions(config: McpConfigSnapshot = this.store.load()): ToolDefinition<any, any>[] {
        return [...this.definitionsByServerTool.values()]
            .filter(({serverName, mcpToolName}) => {
                const server = config.servers[serverName];
                return Boolean(server && shouldRegisterMcpTool(server, mcpToolName));
            })
            .map(({definition}) => definition);
    }
}

export function buildMcpPiToolNames(
    serverName: string,
    toolNames: string[],
    existing = new Set<string>(),
): Map<string, string> {
    const result = new Map<string, string>();
    const reserved = new Set(existing);
    for (const toolName of toolNames) {
        const base = ["mcp", sanitizeToolNamePart(serverName), sanitizeToolNamePart(toolName)].join("_");
        const candidate = uniqueToolName(base, toolName, reserved);
        reserved.add(candidate);
        result.set(toolName, candidate);
    }
    return result;
}

export function sanitizeToolNamePart(input: string): string {
    const sanitized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
    return sanitized || "unnamed";
}

export function formatMcpResultText(result: McpToolCallResult): {
    content: McpOutputContent[];
    contentTypes: string[];
} {
    const output: McpOutputContent[] = [];
    const contentTypes: string[] = [];
    for (const block of Array.isArray(result.content) ? result.content : []) {
        const converted = convertMcpContentBlock(block);
        contentTypes.push(converted.contentType);
        output.push(...converted.content);
    }
    if (output.length === 0 && result.structuredContent) {
        contentTypes.push("structuredContent");
        output.push({type: "text", text: stringifyMcpJson(result.structuredContent)});
    }
    if (output.length === 0 && Object.prototype.hasOwnProperty.call(result, "toolResult")) {
        contentTypes.push("toolResult");
        output.push({type: "text", text: stringifyMcpJson(result.toolResult)});
    }
    if (output.length === 0) {
        contentTypes.push("empty");
        output.push({type: "text", text: "MCP tool returned no content."});
    }
    return {content: truncateMcpTextOutput(output), contentTypes};
}

function createMcpPiTool(input: {
    serverName: string;
    mcpTool: McpTool;
    piToolName: string;
    manager: McpManager;
    store: McpConfigStore;
    displayRows: ToolDisplayRows;
}): ToolDefinition<any, McpToolDetails | undefined> {
    const description = [
        `MCP tool '${input.mcpTool.name}' from server '${input.serverName}'.`,
        input.mcpTool.description ?? "No MCP tool description provided.",
    ].join(" ");
    const presentation = new ToolPresentationRenderer({
        toolName: input.piToolName,
        arguments: [],
        result: {direction: ToolTextDirection.TAIL},
    } satisfies ToolPresentationSpec<Record<string, unknown>>);

    return {
        name: input.piToolName,
        label: input.mcpTool.title ?? input.piToolName,
        description,
        promptSnippet: description,
        renderShell: "self",
        parameters: normalizeMcpInputSchema(input.mcpTool.inputSchema) as any,
        async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<McpToolDetails | undefined>> {
            const latestConfig = input.store.load();
            const server = latestConfig.servers[input.serverName];
            if (!server) throw new Error(`MCP server is no longer configured: ${input.serverName}`);
            if (!shouldRegisterMcpTool(server, input.mcpTool.name)) {
                throw new Error(`MCP tool is not exposed: ${input.serverName}/${input.mcpTool.name}`);
            }
            const result = await input.manager.callTool(
                input.serverName,
                input.mcpTool.name,
                params as Record<string, unknown>,
                {
                    signal,
                    onprogress: progressUpdater(
                        onUpdate,
                        input.serverName,
                        input.mcpTool.name,
                        input.piToolName,
                    ),
                },
            );
            const converted = formatMcpResultText(result);
            if (result.isError) {
                throw new Error(converted.content
                    .filter((item): item is Extract<McpOutputContent, { type: "text" }> => item.type === "text")
                    .map((item) => item.text)
                    .join("\n") || `MCP tool failed: ${input.serverName}/${input.mcpTool.name}`);
            }
            const details: McpToolDetails = {
                server: input.serverName,
                tool: input.mcpTool.name,
                piTool: input.piToolName,
                contentTypes: converted.contentTypes,
                ...(result.structuredContent ? {structuredContent: result.structuredContent} : {}),
            };
            return {content: converted.content, details};
        },
        renderCall: (args, theme, context) => {
            input.displayRows.observe(input.piToolName, args, context);
            return new ToolStatusRail(
                presentation.renderCall(
                    args as Record<string, unknown>,
                    theme,
                    resolveToolDisplayMode(context.expanded, context.state),
                ),
                theme,
                context,
            );
        },
        renderResult: (result, options, theme, context) => new ToolStatusRail(
            presentation.renderResult(
                result,
                theme,
                {isError: context.isError},
                resolveToolDisplayMode(options.expanded, context.state),
            ),
            theme,
            context,
        ),
    };
}

function shouldRegisterMcpTool(server: McpServerConfig, toolName: string): boolean {
    return server.enabled && shouldExposeMcpTool(server, toolName);
}

function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (schema.type === "object") return schema;
    return {type: "object", additionalProperties: true, properties: {}};
}

function progressUpdater(
    onUpdate: AgentToolUpdateCallback<McpToolDetails | undefined> | undefined,
    serverName: string,
    toolName: string,
    piToolName: string,
): ((progress: { progress: number; total?: number; message?: string }) => void) | undefined {
    if (!onUpdate) return undefined;
    return (progress) => {
        const total = progress.total !== undefined ? `/${progress.total}` : "";
        const message = progress.message ? ` ${progress.message}` : "";
        onUpdate({
            content: [{
                type: "text",
                text: `MCP progress ${serverName}/${toolName}: ${progress.progress}${total}${message}`,
            }],
            details: {
                server: serverName,
                tool: toolName,
                piTool: piToolName,
                contentTypes: ["progress"],
            },
        });
    };
}

function convertMcpContentBlock(block: unknown): {
    content: McpOutputContent[];
    contentType: string;
} {
    if (!isRecord(block)) return {
        content: [{type: "text", text: String(block)}],
        contentType: "unknown",
    };
    switch (block.type) {
        case "text":
            return {
                content: [{type: "text", text: typeof block.text === "string" ? block.text : ""}],
                contentType: "text",
            };
        case "image":
            if (typeof block.data === "string" && typeof block.mimeType === "string") {
                return {
                    content: [{type: "image", data: block.data, mimeType: block.mimeType}],
                    contentType: "image",
                };
            }
            return {
                content: [{type: "text", text: "[MCP image content omitted: invalid image payload]"}],
                contentType: "image",
            };
        case "audio":
            return {
                content: [{
                    type: "text",
                    text: `[MCP audio content omitted: ${typeof block.mimeType === "string" ? block.mimeType : "unknown type"}]`,
                }],
                contentType: "audio",
            };
        case "resource":
            return {
                content: [{type: "text", text: formatMcpResource(block.resource)}],
                contentType: "resource",
            };
        case "resource_link":
            return {
                content: [{type: "text", text: formatMcpResourceLink(block)}],
                contentType: "resource_link",
            };
        default:
            return {
                content: [{type: "text", text: stringifyMcpJson(block)}],
                contentType: typeof block.type === "string" ? block.type : "unknown",
            };
    }
}

function formatMcpResource(resource: unknown): string {
    if (!isRecord(resource)) return "[MCP resource content omitted: invalid resource payload]";
    const uri = typeof resource.uri === "string" ? resource.uri : "unknown URI";
    if (typeof resource.text === "string") return `[MCP resource: ${uri}]\n${resource.text}`;
    if (typeof resource.blob === "string") {
        return `[MCP binary resource: ${uri}, ${resource.blob.length} base64 chars]`;
    }
    return `[MCP resource: ${uri}]`;
}

function formatMcpResourceLink(block: Record<string, unknown>): string {
    const name = typeof block.name === "string" ? block.name : "resource";
    const uri = typeof block.uri === "string" ? block.uri : "unknown URI";
    const description = typeof block.description === "string" ? ` - ${block.description}` : "";
    return `[MCP resource link: ${name} ${uri}${description}]`;
}

function truncateMcpTextOutput(content: McpOutputContent[]): McpOutputContent[] {
    let remaining = maxMcpTextOutputChars;
    const output: McpOutputContent[] = [];
    for (const item of content) {
        if (item.type !== "text") {
            output.push(item);
            continue;
        }
        if (remaining <= 0) continue;
        const truncated = item.text.slice(0, remaining);
        remaining -= truncated.length;
        output.push({
            ...item,
            text: truncated + (item.text.length > truncated.length ? "\n[Truncated MCP text output]" : ""),
        });
    }
    return output;
}

function uniqueToolName(base: string, originalToolName: string, reserved: Set<string>): string {
    if (!reserved.has(base)) return base;
    const hash = crypto.createHash("sha1").update(originalToolName).digest("hex").slice(0, 8);
    const withHash = `${base}_${hash}`;
    if (!reserved.has(withHash)) return withHash;
    let index = 2;
    while (reserved.has(`${withHash}_${index}`)) index++;
    return `${withHash}_${index}`;
}

function serverToolKey(serverName: string, toolName: string): string {
    return `${serverName}\u0000${toolName}`;
}

function stringifyMcpJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
