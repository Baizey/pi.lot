import {
    createCodemodeExtension,
    type AgentToolResult,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type Theme,
    type ToolDefinition,
    type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {getCapabilities, wrapTextWithAnsi} from "@earendil-works/pi-tui";
import type {Type} from "typebox";
import {ThemeColor} from "../../tui/Color.js";
import {renderLineFactory, sanitizeTerminalLine, type TextComponent} from "../../tui/terminalText.js";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows, type ToolDisplayState} from "../../tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection, type ToolResultLike} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

const PURPOSE_GUIDELINE = "Call codemode with a JSON object containing a concise, one-line `purpose` (1-160 characters) "
    + "and JavaScript source in `code`. Native codemode documentation describes `code` and its APIs; "
    + "its raw-input convention does not apply to this tool.";

type CodemodeInput = {purpose: string; code: string};
type NativeCodemodeSchema = Type.TObject<{code: Type.TString}>;

/** Pi owns script execution and discovery; Pilot adds purpose and presentation. */
export class CodemodeExtension {
    private static readonly nativeSchemas = new WeakMap<object, ToolInfo["parameters"]>();
    private readonly liveRows = new WeakSet<object>();
    // UI-only arguments: leave Pi's bounded transcript metadata and model output unchanged.
    private readonly callArguments = new WeakMap<CodemodeToolDetails, ReadonlyMap<number, string>>();
    private readonly presentation = new ToolPresentationRenderer<CodemodeInput>({
        toolName: "codemode",
        arguments: [
            {key: "purpose", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
            {key: "code", layout: ToolArgumentLayout.BLOCK, wrap: true},
        ],
        result: {direction: ToolTextDirection.TAIL, wrap: true},
    });

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly displayRows: ToolDisplayRows,
    ) {}

    /** Native MCP recognizes scripts by schema identity before waiting for pending servers. */
    static nativeMcpTools<TTool extends Pick<ToolInfo, "name" | "parameters">>(tools: readonly TTool[]): TTool[] {
        return tools.map((tool) => {
            const parameters = tool.name === "codemode" ? this.nativeSchemas.get(tool.parameters) : undefined;
            return parameters ? {...tool, parameters} : tool;
        });
    }

    register(): void {
        // The generic registerTool API cannot express this decorator's built-in-only boundary.
        const registerTool = ((definition: ToolDefinition<NativeCodemodeSchema, CodemodeToolDetails | undefined>) => {
            const parameters = {
                ...definition.parameters,
                properties: {
                    purpose: {
                        ...definition.parameters.properties.code,
                        description: "A short, one-line explanation of what the script will achieve",
                        minLength: 1,
                        maxLength: 160,
                        pattern: "^[^\\r\\n]+$",
                    },
                    ...definition.parameters.properties,
                },
                required: [...definition.parameters.required, "purpose"] satisfies [
                    ...typeof definition.parameters.required, "purpose",
                ],
            };
            CodemodeExtension.nativeSchemas.set(parameters, definition.parameters);
            this.pi.registerTool<typeof parameters, CodemodeToolDetails | undefined>({
                ...definition,
                parameters,
                prepareArguments: undefined,
                // Pi's raw-source grammar supports exactly one required string, not purpose + code.
                constrainedSampling: {type: "json_schema", strict: "prefer"},
                description: this.describePurpose(definition.description),
                promptGuidelines: [...(definition.promptGuidelines ?? []), PURPOSE_GUIDELINE],
                prepareLoadout: (loadout) => {
                    const changes = definition.prepareLoadout?.(loadout);
                    const description = changes?.descriptions?.codemode;
                    if (!description) return changes;
                    return {
                        ...changes,
                        descriptions: {...changes.descriptions, codemode: this.describePurpose(description)},
                    };
                },
                execute: async (toolCallId, params, signal, onUpdate, ctx) => {
                    const argumentsByCall = new Map<number, string>();
                    let calls: CodemodeToolDetails["calls"] = [];
                    const capture = (result: AgentToolResult<CodemodeToolDetails | undefined>) => {
                        calls = result.details?.calls ?? [];
                        if (result.details) this.callArguments.set(result.details, argumentsByCall);
                        return result;
                    };
                    const executeTool: typeof ctx.executeTool = (name, args, options) => {
                        // Native codemode publishes the new running row immediately before
                        // calling executeTool. Capture by position: running ids are all "?".
                        const call = calls.at(-1);
                        if (call?.name === name && call.status === "running") {
                            try {
                                argumentsByCall.set(calls.length - 1, JSON.stringify(args) ?? call.args);
                            } catch {
                                // Keep Pi's preview when an input cannot be serialized.
                            }
                        }
                        return ctx.executeTool(name, args, options);
                    };
                    // Inherit Pi's guarded, non-enumerable tools/context getters; do not spread them.
                    const toolContext: typeof ctx = Object.create(ctx, {executeTool: {value: executeTool}});
                    return capture(await definition.execute(toolCallId, params, signal, (update) => {
                        onUpdate?.(capture(update));
                    }, toolContext));
                },
                renderShell: "self",
                renderCall: (args, theme, context) => {
                    // Pi's TUI creates rows before execution; HTML exports start with
                    // executionStarted=true. Export state must not own live toggles or timers.
                    if (!context.executionStarted) this.liveRows.add(context.state);
                    const live = this.liveRows.has(context.state);
                    if (live) this.displayRows.observe("codemode", args, context);
                    return this.presentation.renderCall(
                        args,
                        theme,
                        resolveToolDisplayMode(context.expanded, context.state),
                        {...context, invalidate: live ? context.invalidate : undefined},
                    );
                },
                renderResult: (result, options, theme, context) => {
                    if (!options.isPartial) {
                        context.state.pilotCallSpinner?.stop();
                        context.state.pilotCallSpinner = null;
                    }
                    return this.renderResult(
                        result,
                        // This callback decorates only Pi's native codemode definition.
                        result.details as CodemodeToolDetails | undefined,
                        theme,
                        resolveToolDisplayMode(options.expanded, context.state),
                        options.isPartial,
                        context.isError,
                        context.showImages,
                        context.state,
                    );
                },
            });
        }) as ExtensionAPI["registerTool"];
        createCodemodeExtension()({...this.pi, registerTool});
    }

    private describePurpose(description: string): string {
        // Pi exposes its factory, not the description builder. Preserve its generated guidance
        // and catalogue; adapt only the raw-input convention that our JSON envelope replaces.
        const input = /^([^\n]*?)The input is raw JavaScript\s*\([^\n)]*\),\s*run as\s*/;
        const options = /^- Optional first line:/m;
        if (!input.test(description) || !options.test(description)) {
            throw new Error("Unsupported native codemode description: expected script input and options guidance");
        }
        return description.replace(
            input,
            "$1Pass a JSON object with a concise, one-line `purpose` and JavaScript source in `code` "
            + "(no code fence). `code` runs as ",
        ).replace(options, "- Optional first line of `code`:");
    }

    private renderResult(
        result: ToolResultLike,
        details: CodemodeToolDetails | undefined,
        theme: Theme,
        mode: ToolDisplayMode,
        isPartial: boolean,
        isError: boolean,
        showImages: boolean,
        state: ToolDisplayState,
    ): TextComponent {
        return renderLineFactory((width) => {
            const calls = details?.calls ?? [];
            const argumentsByCall = details ? this.callArguments.get(details) : undefined;
            const indicator = isPartial ? state.pilotCallSpinner?.frame() : undefined;
            const lines = calls.length > 0 ? ["", ...calls.flatMap((call, index) => {
                const text = this.formatCall(call, argumentsByCall?.get(index) ?? call.args, theme, mode, indicator);
                return text.split("\n").flatMap((line) => Number.isFinite(width) && width >= 1
                    ? wrapTextWithAnsi(sanitizeTerminalLine(line), Math.floor(width))
                    : [sanitizeTerminalLine(line)]);
            })] : [];
            const priced = calls.filter((call) => call.cost !== undefined);
            if (priced.length > 1) {
                const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
                lines.push(theme.fg(ThemeColor.muted, `Model calls: ${formatCost(total)}`));
            }
            if (isPartial || mode === ToolDisplayMode.MINIMAL) return lines;

            const content = result.content ?? [];
            const first = content[0];
            const output = first?.type === "text" && SCRIPT_HEADER.test(first.text ?? "")
                ? content.slice(1)
                : content;
            lines.push(...this.presentation.renderResult({
                content: output.map((part) => part.type === "image" && (!showImages || !getCapabilities().images)
                    ? {type: "text", text: "[image]"}
                    : part),
            }, theme, {isError}, mode).render(width));
            if (details?.fullOutputPath) {
                lines.push(theme.fg(ThemeColor.muted, `Full output: ${details.fullOutputPath}`));
            }
            return lines;
        });
    }

    private formatCall(
        call: CodemodeToolDetails["calls"][number],
        args: string,
        theme: Theme,
        mode: ToolDisplayMode,
        indicator: string | undefined,
    ): string {
        const status = call.status === "running" && indicator ? theme.fg(ThemeColor.accent, indicator) : " ";
        const color = call.status === "error" ? ThemeColor.error
            : call.status === "cancelled" ? ThemeColor.muted : ThemeColor.toolTitle;
        let line = `${status} ${theme.fg(color, call.name)}`;
        if (args) line += ` ${theme.fg(ThemeColor.muted, args)}`;
        if (call.durationMs !== undefined) {
            const duration = call.durationMs < 1000
                ? `${Math.round(call.durationMs)}ms`
                : `${(call.durationMs / 1000).toFixed(1)}s`;
            line += ` ${theme.fg(ThemeColor.dim, duration)}`;
        }
        if (call.cost !== undefined) line += ` ${theme.fg(ThemeColor.dim, formatCost(call.cost))}`;
        if (mode === ToolDisplayMode.FULL && call.error) {
            const error = call.error.replace(/\r\n|\r/g, "\n").split("\n")
                .map((text) => theme.fg(ThemeColor.error, text));
            line += `\n${error.join("\n")}`;
        }
        return line;
    }
}

function formatCost(cost: number): string {
    return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}
