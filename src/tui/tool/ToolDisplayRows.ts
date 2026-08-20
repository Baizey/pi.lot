type ToolDisplayRenderContext = {
    toolCallId: string;
    state: {pilotFullDisplay?: boolean};
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
    state: {pilotFullDisplay?: boolean};
    invalidate(): void;
};

export class ToolDisplayRows {
    private readonly rows = new Map<string, StoredToolDisplayRow>();
    private nextSequence = 1;

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

    toggle(toolCallId: string): boolean {
        const row = this.rows.get(toolCallId);
        if (!row) return false;
        row.state.pilotFullDisplay = !row.state.pilotFullDisplay;
        row.invalidate();
        return true;
    }

    clear(): void {
        this.rows.clear();
        this.nextSequence = 1;
    }
}
