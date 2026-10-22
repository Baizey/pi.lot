import {
    createCodemodeExtension,
    type AgentToolResult,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {getCapabilities, wrapTextWithAnsi} from "@earendil-works/pi-tui";
import {ThemeColor} from "../../tui/Color.js";
import {renderLineFactory, sanitizeTerminalLine, type TextComponent} from "../../tui/terminalText.js";
import {ToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows, type ToolDisplayState} from "../../tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection, type ToolResultLike} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {withApprovalAwareCodemodeTimeout, type NativeCodemodeDefinition} from "./CodemodeExecutionTimeout.js";

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

const PURPOSE_GUIDELINE = "Call codemode with a JSON object containing a concise, one-line `purpose` (1-160 characters) "
    + "and JavaScript source in `code`. Native codemode documentation describes `code` and its APIs; "
    + "its raw-input convention does not apply to this tool.";

type CodemodeInput = {purpose: string; code: string};

/** Pi owns script execution and discovery; Pilot adds purpose and presentation. */
export class CodemodeExtension {
    private readonly timing = new WeakMap<object, {startedAt: number; endedAt?: number}>();
    // UI-only arguments: leave Pi's bounded transcript metadata and model output unchanged.
    private readonly callArguments = new WeakMap<CodemodeToolDetails, ReadonlyMap<number, string>>();
    private readonly presentation = new ToolPresentationRenderer<CodemodeInput>({
        toolName: "codemode",
        arguments: [
            {key: "purpose", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
            {key: "code", layout: ToolArgumentLayout.BLOCK, previewDirection: ToolTextDirection.TAIL, wrap: true},
        ],
        result: {direction: ToolTextDirection.TAIL, wrap: true},
    });

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly displayRows: ToolDisplayRows,
    ) {}

    register(): void {
        this.displayRows.registerCallPresentation("codemode", (args, theme, mode, width, indicator) => (
            this.presentation.renderCallLines(args, theme, mode, width, indicator)
        ));
        // The generic registerTool API cannot express this decorator's built-in-only boundary.
        const registerTool = ((definition: NativeCodemodeDefinition) => {
            const execute = withApprovalAwareCodemodeTimeout(definition.execute);
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
                    return capture(await execute(toolCallId, params, signal, (update) => {
                        onUpdate?.(capture(update));
                    }, toolContext));
                },
                renderShell: "self",
                renderCall: (args, theme, context) => {
                    const live = this.displayRows.observe("codemode", args, context);
                    if (live && context.executionStarted && !this.timing.has(context.state)) {
                        this.timing.set(context.state, {startedAt: Date.now()});
                    }
                    return this.presentation.renderCall(
                        args,
                        theme,
                        this.displayRows.resolveMode(context.expanded, context.state),
                        {
                            isPartial: context.isPartial,
                            outputPad: context.outputPad,
                            indicator: () => context.state.pilotCallSpinner?.frame(),
                        },
                    );
                },
                renderResult: (result, options, theme, context) => {
                    const timing = this.timing.get(context.state);
                    if (!options.isPartial) {
                        if (timing) timing.endedAt ??= Date.now();
                        this.displayRows.complete(context.state);
                    }
                    return this.renderResult(
                        result,
                        // This callback decorates only Pi's native codemode definition.
                        result.details as CodemodeToolDetails | undefined,
                        theme,
                        this.displayRows.resolveMode(options.expanded, context.state),
                        options.isPartial,
                        context.isError,
                        context.showImages,
                        context.state,
                        context.outputPad,
                        context.durationMs,
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
        outputPad: number,
        durationMs: number | undefined,
    ): TextComponent {
        return renderLineFactory((width) => {
            if (mode === ToolDisplayMode.HIDDEN && !isPartial) return [];
            const calls = details?.calls ?? [];
            const argumentsByCall = details ? this.callArguments.get(details) : undefined;
            const indicator = isPartial ? state.pilotCallSpinner?.frame() : undefined;
            // Reserve the indent before laying out or wrapping a nested call. On tiny terminals,
            // shrink it rather than losing the entire call to indentation.
            const indent = " ".repeat(Number.isFinite(width) ? Math.max(0, Math.min(2, Math.floor(width) - 1)) : 2);
            const callWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width) - indent.length) : width;
            const activity = calls.flatMap((call, index) => {
                if (mode === ToolDisplayMode.HIDDEN && call.status !== "running") return [];
                return this.callLines(
                    call, argumentsByCall?.get(index) ?? call.args, theme,
                    mode === ToolDisplayMode.HIDDEN ? ToolDisplayMode.TRUNCATED : mode, indicator, callWidth,
                ).flatMap((line) => Number.isFinite(callWidth)
                    ? wrapTextWithAnsi(sanitizeTerminalLine(line), callWidth)
                    : [sanitizeTerminalLine(line)])
                    .map((line) => `${indent}${line}`);
            });
            const lines = activity.length > 0 ? ["", ...activity] : [];
            if (mode === ToolDisplayMode.HIDDEN) return lines;
            const priced = calls.filter((call) => call.cost !== undefined);
            if (priced.length > 1) {
                const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
                lines.push(theme.fg(ThemeColor.muted, `Model calls: ${formatCost(total)}`));
            }
            // The existing call spinner redraws live rows; do not add native renderer intervals
            // that would outlive Pilot's row cleanup. Compact mode keeps its activity-only layout.
            const timing = this.timing.get(state);
            const elapsed = !isPartial && durationMs !== undefined ? durationMs
                : timing ? (timing.endedAt ?? Date.now()) - timing.startedAt : undefined;
            const timerText = elapsed === undefined ? undefined
                : theme.fg(ThemeColor.muted, `${isPartial ? "Elapsed" : "Took"} ${(elapsed / 1000).toFixed(1)}s`);
            if (mode === ToolDisplayMode.MINIMAL) return lines;
            if (isPartial) return timerText ? [...lines, "", timerText] : lines;

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
            if (timerText) lines.push("", timerText);
            return lines;
        }, outputPad);
    }

    private callLines(
        call: CodemodeToolDetails["calls"][number],
        args: string,
        theme: Theme,
        mode: ToolDisplayMode,
        indicator: string | undefined,
        width: number,
    ): string[] {
        const runningIndicator = call.status === "running" ? indicator : undefined;
        const color = call.status === "error" ? ThemeColor.error
            : call.status === "cancelled" ? ThemeColor.muted : ThemeColor.toolTitle;
        const callTheme: Theme = Object.create(theme, {
            fg: {value: (token: Parameters<Theme["fg"]>[0], text: string) => (
                theme.fg(token === ThemeColor.toolTitle ? color : token, text)
            )},
        });
        const parsed = parseCallArguments(args);
        let lines: string[] | undefined;
        if (parsed && !call.name.startsWith("models.")) {
            try {
                const render = this.displayRows.callPresentation(call.name);
                lines = render
                    ? render(parsed, callTheme, mode, width, runningIndicator)
                    : new ToolPresentationRenderer<Record<string, unknown>>({toolName: call.name, arguments: []})
                        .renderCallLines(parsed, callTheme, mode, width, runningIndicator);
            } catch {
                // Rejected inputs are recorded too. A formatter's schema assumptions must not
                // let one invalid call hide the rest of the script's activity.
            }
        }
        if (!lines) {
            // Restored calls can contain Pi's truncated JSON previews. Model calls contain only
            // a model identifier. Keep these readable without guessing missing arguments.
            const status = runningIndicator ? theme.fg(ThemeColor.accent, runningIndicator) : " ";
            const summary = `${status} ${callTheme.fg(ThemeColor.toolTitle, theme.bold(call.name))}`
                + (args ? ` ${theme.fg(ThemeColor.muted, args)}` : "");
            lines = summary.replace(/\r\n|\r/g, "\n").split("\n");
        }
        if (call.durationMs !== undefined) {
            const duration = call.durationMs < 1000
                ? `${Math.round(call.durationMs)}ms`
                : `${(call.durationMs / 1000).toFixed(1)}s`;
            lines[0] += ` ${theme.fg(ThemeColor.dim, duration)}`;
        }
        if (call.cost !== undefined) lines[0] += ` ${theme.fg(ThemeColor.dim, formatCost(call.cost))}`;
        if (mode === ToolDisplayMode.FULL && call.error) {
            lines.push(...call.error.replace(/\r\n|\r/g, "\n").split("\n")
                .map((text) => theme.fg(ThemeColor.error, text)));
        }
        return lines;
    }
}

function parseCallArguments(args: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(args);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}

function formatCost(cost: number): string {
    return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}
