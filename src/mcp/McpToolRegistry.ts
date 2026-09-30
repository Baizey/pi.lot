import type {ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {ToolDisplayRows} from "../tui/tool/ToolDisplayRows.js";
import {resolveToolDisplayMode} from "../tui/tool/ToolDisplayMode.js";
import {ToolTextDirection} from "../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../tui/tool/ToolPresentationRenderer.js";

// MCP servers register heterogeneous JSON Schemas, as does Pi's native tool registry.
type McpDefinition = ToolDefinition<any, any>;

/** Native definitions own execution; Pilot owns presentation and delegated access to them. */
export class McpToolRegistry {
    private readonly definitions = new Map<string, McpDefinition>();
    private generation = 0;
    private active = false;

    constructor(
        private readonly pi: Pick<ExtensionAPI, "registerTool">,
        private readonly displayRows: ToolDisplayRows = new ToolDisplayRows(),
    ) {}

    startSession(): void {
        this.generation++;
        this.active = true;
        this.definitions.clear();
    }

    stopSession(): void {
        this.active = false;
        this.definitions.clear();
    }

    register(definition: McpDefinition): void {
        // Native startup/discovery is asynchronous and may finish during teardown.
        if (!this.active) return;
        this.definitions.set(definition.name, definition);
        this.pi.registerTool(this.decorate(definition));
    }

    toolDefinitions(): McpDefinition[] {
        return [...this.definitions.values()]
            // Native resource tools aggregate a changing set of servers. Until delegation has a
            // server-scoped resource snapshot, keep these root-only rather than widening a child.
            .filter((definition) => definition.exposure !== "hidden" && definition.name.startsWith("mcp__"))
            .map((definition) => this.decorate(definition));
    }

    private decorate(definition: McpDefinition): McpDefinition {
        const generation = this.generation;
        const presentation = new ToolPresentationRenderer<Record<string, unknown>>({
            toolName: definition.name,
            arguments: [],
            result: {direction: ToolTextDirection.TAIL},
        });
        return {
            ...definition,
            renderShell: "self",
            execute: (toolCallId, params, signal, onUpdate, ctx) => {
                const current = this.definitions.get(definition.name);
                if (!this.active || generation !== this.generation || !current || current.exposure === "hidden") {
                    throw new Error(`MCP tool is no longer exposed: ${definition.name}`);
                }
                if (JSON.stringify(current.parameters) !== JSON.stringify(definition.parameters)) {
                    throw new Error(`MCP tool schema changed; reload the tool or spawn a new child: ${definition.name}`);
                }
                // A retained child must not execute a stale closure after native withdrawal/reconnect.
                // Use its own context and signal, not the root session's execution pipeline.
                return current.execute(toolCallId, params, signal, onUpdate, ctx);
            },
            renderCall: (args, theme, context) => {
                this.displayRows.observe(definition.name, args, context);
                return presentation.renderCall(
                    args as Record<string, unknown>,
                    theme,
                    resolveToolDisplayMode(context.expanded, context.state),
                    {isPartial: context.isPartial, isError: context.isError},
                );
            },
            renderResult: (result, options, theme, context) => presentation.renderResult(
                result,
                theme,
                {isError: context.isError},
                resolveToolDisplayMode(options.expanded, context.state),
            ),
        };
    }
}
