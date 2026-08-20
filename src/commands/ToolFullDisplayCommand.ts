import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {ToolDisplayRows, type ToolDisplayRow} from "../tui/tool/ToolDisplayRows.js";

const COMMAND_NAME = "tool-full";
const MAX_SUMMARY_LENGTH = 80;

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

                const choices = rows.map(formatChoice);
                const selected = await ctx.ui.select("Toggle full tool display", choices);
                if (!selected) return;

                const index = choices.indexOf(selected);
                const row = rows[index];
                if (!row || !this.rows.toggle(row.toolCallId)) {
                    ctx.ui.notify("That tool call is no longer available.", "warning");
                }
            },
        });
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
