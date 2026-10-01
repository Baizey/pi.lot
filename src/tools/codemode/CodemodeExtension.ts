import {
    createCodemodeExtension,
    type CodemodeToolDetails,
    type ExtensionAPI,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {getCapabilities} from "@earendil-works/pi-tui";
import {ThemeColor} from "../../tui/Color.js";
import {renderLineFactory, type TextComponent} from "../../tui/terminalText.js";
import {resolveToolDisplayMode, ToolDisplayMode} from "../../tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolTextDirection, type ToolResultLike} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

/** Pi owns the script sandbox and loadout; Pilot replaces only its presentation. */
export class CodemodeExtension {
    private readonly liveRows = new WeakSet<object>();
    private readonly presentation = new ToolPresentationRenderer<{code: string}>({
        toolName: "codemode",
        arguments: [{key: "code", layout: ToolArgumentLayout.BLOCK, wrap: true}],
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

    register(): void {
        createCodemodeExtension()({
            ...this.pi,
            registerTool: (definition) => this.pi.registerTool({
                ...definition,
                renderShell: "self",
                renderCall: (args, theme, context) => {
                    // Pi 0.99.2's TUI creates rows before execution; HTML exports start with
                    // executionStarted=true. Export state must not own live toggles or timers.
                    if (!context.executionStarted) this.liveRows.add(context.state);
                    const live = this.liveRows.has(context.state);
                    if (live) this.displayRows.observe("codemode", args, context);
                    return this.presentation.renderCall(
                        args as {code: string},
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
            }),
        });
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
            if (mode === ToolDisplayMode.MINIMAL) return [];
            const calls = details?.calls ?? [];
            const lines = this.callsPresentation.renderResult({
                content: [{type: "text", text: calls.map((call) => this.formatCall(call, theme, mode)).join("\n")}],
            }, theme, {}, mode).render(width);
            const priced = calls.filter((call) => call.cost !== undefined);
            if (priced.length > 1) {
                const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
                lines.push(theme.fg(ThemeColor.muted, `Model calls: ${formatCost(total)}`));
            }
            if (isPartial) return lines;

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
        const args = mode === ToolDisplayMode.TRUNCATED && call.args.length > 80
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
