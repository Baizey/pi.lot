import {
    createCodemodeExtension,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type Theme,
    type ToolDefinition,
    type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {getCapabilities} from "@earendil-works/pi-tui";
import type {Type} from "typebox";
import {ThemeColor} from "../../tui/Color.js";
import {renderLineFactory, type TextComponent} from "../../tui/terminalText.js";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection, type ToolResultLike} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

const PURPOSE_GUIDELINE = "Include a concise, one-line purpose describing what each codemode script will achieve.";

type CodemodeInput = {purpose: string; code: string};
type NativeCodemodeSchema = Type.TObject<{code: Type.TString}>;

/** Pi owns script execution and discovery; Pilot adds purpose and presentation. */
export class CodemodeExtension {
    private static readonly nativeSchemas = new WeakMap<object, ToolInfo["parameters"]>();
    private readonly liveRows = new WeakSet<object>();
    private readonly presentation = new ToolPresentationRenderer<CodemodeInput>({
        toolName: "codemode",
        arguments: [
            {key: "purpose", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
            {key: "code", layout: ToolArgumentLayout.BLOCK, wrap: true},
        ],
        result: {direction: ToolTextDirection.TAIL, wrap: true},
    });
    private readonly callsPresentation = new ToolPresentationRenderer({
        toolName: "codemode",
        arguments: [],
        result: {direction: ToolTextDirection.TAIL, previewLines: 8, maxFullLines: 100, wrap: true},
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
                renderShell: "self",
                renderCall: (args, theme, context) => {
                    // Pi 0.99.2's TUI creates rows before execution; HTML exports start with
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
                        // This callback decorates only Pi 0.99.2's native codemode definition.
                        result.details as CodemodeToolDetails | undefined,
                        theme,
                        resolveToolDisplayMode(options.expanded, context.state),
                        options.isPartial,
                        context.isError,
                        context.showImages,
                    );
                },
            });
        }) as ExtensionAPI["registerTool"];
        createCodemodeExtension()({...this.pi, registerTool});
    }

    private describePurpose(description: string): string {
        return description.replace(
            "- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.",
            "- Pass an object with a concise, one-line `purpose` and JavaScript source in `code`; do not wrap the code in markdown fences.",
        ).replace(
            "- You may optionally start the tool input with a first line like",
            "- You may optionally start `code` with a first line like",
        );
    }

    private renderResult(
        result: ToolResultLike,
        details: CodemodeToolDetails | undefined,
        theme: Theme,
        mode: ToolDisplayMode,
        isPartial: boolean,
        isError: boolean,
        showImages: boolean,
    ): TextComponent {
        return renderLineFactory((width) => {
            const calls = details?.calls ?? [];
            const lines = this.callsPresentation.renderResult({
                content: [{type: "text", text: calls.map((call) => this.formatCall(call, theme, mode)).join("\n")}],
            }, theme, {}, mode === ToolDisplayMode.MINIMAL ? ToolDisplayMode.TRUNCATED : mode).render(width);
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

    private formatCall(call: CodemodeToolDetails["calls"][number], theme: Theme, mode: ToolDisplayMode): string {
        const statuses = {
            running: ["…", ThemeColor.warning],
            ok: ["✓", ThemeColor.success],
            error: ["✗", ThemeColor.error],
            cancelled: ["⊘", ThemeColor.muted],
        } as const;
        const [icon, color] = statuses[call.status];
        let line = `${theme.fg(color, icon)} ${theme.fg(ThemeColor.toolTitle, call.name)}`;
        const args = mode !== ToolDisplayMode.FULL && call.args.length > 80
            ? `${call.args.slice(0, 77)}...`
            : call.args;
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
