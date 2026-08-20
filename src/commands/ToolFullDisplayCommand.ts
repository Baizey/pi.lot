import type {
    ExtensionAPI,
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from "@earendil-works/pi-coding-agent";
import {truncateToWidth} from "@earendil-works/pi-tui";
import {ToolDisplayRows, type ToolDisplayRow} from "../tui/tool/ToolDisplayRows.js";

const COMMAND_NAME = "tool-full";
const MAX_SUMMARY_LENGTH = 80;
const TOOL_ROWS_AROUND_SELECTION = 5;

export class ToolFullDisplayCommand {
    constructor(
        private readonly pi: Pick<ExtensionAPI, "registerCommand">,
        private readonly rows: ToolDisplayRows,
    ) {
    }

    register(): void {
        this.pi.registerCommand(COMMAND_NAME, {
            description: "Toggle full display for one tool call",
            handler: async (_args, ctx) => {
                const rows = this.rows.list();
                if (rows.length === 0) {
                    ctx.ui.notify("No tool calls are available.", "info");
                    return;
                }

                const toolCallId = await selectToolRow(ctx, rows);
                if (!toolCallId) return;
                if (!this.rows.toggle(toolCallId)) {
                    ctx.ui.notify("That tool call is no longer available.", "warning");
                }
            },
        });
    }
}

function selectToolRow(
    ctx: ExtensionCommandContext,
    rows: ToolDisplayRow[],
): Promise<string | undefined> {
    const items = rows.map((row) => ({
        value: row.toolCallId,
        label: formatChoice(row),
    }));

    return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => new ToolDisplaySelector(
        items,
        theme,
        keybindings,
        (value) => done(value),
        () => done(undefined),
        () => tui.requestRender(),
    ));
}

class ToolDisplaySelector {
    private selectedIndex: number;

    constructor(
        private readonly items: Array<{value: string; label: string}>,
        private readonly theme: Theme,
        private readonly keybindings: KeybindingsManager,
        private readonly select: (value: string) => void,
        private readonly cancel: () => void,
        private readonly changed: () => void,
    ) {
        this.selectedIndex = items.length - 1;
    }

    render(width: number): string[] {
        const start = Math.max(0, this.selectedIndex - TOOL_ROWS_AROUND_SELECTION);
        const end = Math.min(this.items.length, this.selectedIndex + TOOL_ROWS_AROUND_SELECTION + 1);
        const options = this.items.slice(start, end).map((item, offset) => {
            const selected = start + offset === this.selectedIndex;
            const line = `${selected ? "→" : " "} ${item.label}`;
            return selected ? this.theme.fg("accent", line) : line;
        });
        return [
            this.theme.fg("accent", this.theme.bold("Toggle full tool display")),
            "",
            ...options,
            this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.items.length})`),
            "",
            this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
        ].map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        if (this.keybindings.matches(data, "tui.select.up")) {
            if (this.selectedIndex > 0) {
                this.selectedIndex--;
                this.changed();
            }
        } else if (this.keybindings.matches(data, "tui.select.down")) {
            if (this.selectedIndex < this.items.length - 1) {
                this.selectedIndex++;
                this.changed();
            }
        } else if (this.keybindings.matches(data, "tui.select.confirm")) {
            const item = this.items[this.selectedIndex];
            if (item) this.select(item.value);
        } else if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.cancel();
        }
    }

    invalidate(): void {
    }
}

function formatChoice(row: ToolDisplayRow): string {
    const marker = row.full ? "●" : "○";
    const summary = summarizeArgs(row.args);
    return `${marker} ${row.sequence}. ${row.toolName}${summary ? ` — ${summary}` : ""}`;
}

function summarizeArgs(args: unknown): string {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "";
    const values = args as Record<string, unknown>;
    const preferredKeys = ["purpose", "path", "role", "jobId", "task"];
    for (const key of preferredKeys) {
        const summary = summarizeValue(values[key]);
        if (summary) return summary;
    }
    for (const value of Object.values(values)) {
        const summary = summarizeValue(value);
        if (summary) return summary;
    }
    return "";
}

function summarizeValue(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
    const summary = String(value).replace(/\s+/g, " ").trim();
    if (summary.length <= MAX_SUMMARY_LENGTH) return summary;
    return `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}
