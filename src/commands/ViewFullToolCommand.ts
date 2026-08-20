import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {showBoundedList} from "../tui/BoundedListComponent.js";
import {ToolDisplayRows, type ToolDisplayRow} from "../tui/tool/ToolDisplayRows.js";

const COMMAND_NAME = "view-full-tool";
const MAX_SUMMARY_LENGTH = 80;

export class ViewFullToolCommand {
    constructor(
        private readonly pi: ExtensionAPI,
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

                await editToolRows(ctx, rows, this.rows);
            },
        });
    }
}

function editToolRows(
    ctx: ExtensionCommandContext,
    rows: ToolDisplayRow[],
    displayRows: ToolDisplayRows,
): Promise<void> {
    const items = rows.map((row) => ({
        value: row.toolCallId,
        label: formatChoice(row),
    }));

    return showBoundedList(ctx.ui, {
        title: "Toggle full tool display",
        items,
        initialIndex: items.length - 1,
        radius: 5,
        hint: "↑↓ navigate • enter toggle • esc close",
        onActivate: (item, index) => {
            const full = displayRows.toggle(item.value);
            if (full === undefined) {
                ctx.ui.notify("That tool call is no longer available.", "warning");
                return;
            }
            const row = rows[index];
            if (!row) return;
            row.full = full;
            item.label = formatChoice(row);
        },
    });
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
