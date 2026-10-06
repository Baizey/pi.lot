import type {Theme} from "@earendil-works/pi-coding-agent";
import type {ToolCallSpinnerState} from "./ToolCallSpinner.js";
import type {ToolDisplayMode} from "./ToolDisplayMode.js";

/** Stateless call layout: nested calls must not own rows, toggles, or animation timers. */
export type ToolCallPresentation = (
    args: Record<string, unknown>,
    theme: Theme,
    mode: ToolDisplayMode,
    width: number,
    indicator?: string,
) => string[];

export type ToolDisplayState = ToolCallSpinnerState & {pilotFullDisplay?: boolean};

type ToolDisplayRenderContext = {
    toolCallId: string;
    state: ToolDisplayState;
    invalidate(): void;
};

export type ToolDisplayRow = {
    toolCallId: string;
    toolName: string;
    args: unknown;
    sequence: number;
    full: boolean;
};

type StoredToolDisplayRow = {
    toolName: string;
    args: unknown;
    sequence: number;
    state: ToolDisplayState;
    invalidate(): void;
};

export class ToolDisplayRows {
    private readonly rows = new Map<string, StoredToolDisplayRow>();
    // Layouts outlive observed rows: cached definitions do not re-register after tree/compaction cleanup.
    private readonly callPresentations = new Map<string, ToolCallPresentation>();
    private nextSequence = 1;

    registerCallPresentation(toolName: string, render: ToolCallPresentation): void {
        this.callPresentations.set(toolName, render);
    }

    callPresentation(toolName: string): ToolCallPresentation | undefined {
        return this.callPresentations.get(toolName);
    }

    observe(toolName: string, args: unknown, context: ToolDisplayRenderContext): void {
        const existing = this.rows.get(context.toolCallId);
        this.rows.set(context.toolCallId, {
            toolName,
            args,
            sequence: existing?.sequence ?? this.nextSequence++,
            state: context.state,
            invalidate: context.invalidate,
        });
    }

    list(): ToolDisplayRow[] {
        return [...this.rows.entries()].map(([toolCallId, row]) => ({
            toolCallId,
            toolName: row.toolName,
            args: row.args,
            sequence: row.sequence,
            full: row.state.pilotFullDisplay === true,
        }));
    }

    toggle(toolCallId: string): boolean | undefined {
        const row = this.rows.get(toolCallId);
        if (!row) return undefined;
        const full = !row.state.pilotFullDisplay;
        row.state.pilotFullDisplay = full;
        row.invalidate();
        return full;
    }

    clear(): void {
        for (const row of this.rows.values()) {
            row.state.pilotCallSpinner?.stop();
            row.state.pilotCallSpinner = null;
        }
        this.rows.clear();
        this.nextSequence = 1;
    }
}
