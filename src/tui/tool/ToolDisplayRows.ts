import type {Theme, ToolDefinition, ToolRenderResultOptions} from "@earendil-works/pi-coding-agent";
import {ToolCallSpinner, type ToolCallSpinnerState} from "./ToolCallSpinner.js";
import type {TextComponent} from "../terminalText.js";
import type {ToolPresentationSpec, ToolResultLike} from "./ToolPresentation.js";
import {ToolPresentationRenderer} from "./ToolPresentationRenderer.js";
import type {ToolDisplayMode} from "./ToolDisplayMode.js";
import {ToolDisplayModes} from "./ToolDisplayModes.js";

/** Stateless call layout: nested calls must not own rows, toggles, or animation timers. */
export type ToolCallPresentation = (
    args: Record<string, unknown>,
    theme: Theme,
    mode: ToolDisplayMode,
    width: number,
    indicator?: string,
) => string[];

export type ToolDisplayState = ToolCallSpinnerState & {pilotFullDisplay?: boolean};

type DisplayDefinition = ToolDefinition<ToolDefinition["parameters"], unknown, ToolDisplayState>;
type DisplayContext = Parameters<NonNullable<DisplayDefinition["renderCall"]>>[2];
type BoundToolRenderers = {
    renderShell: "self";
    renderCall(args: unknown, theme: Theme, context: DisplayContext): TextComponent;
    renderResult(result: ToolResultLike, options: ToolRenderResultOptions, theme: Theme, context: DisplayContext): TextComponent;
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
    private readonly liveStates = new WeakSet<ToolDisplayState>();
    // Layouts outlive observed rows: cached definitions do not re-register after tree/compaction cleanup.
    private readonly callPresentations = new Map<string, ToolCallPresentation>();
    private nextSequence = 1;

    constructor(readonly modes = new ToolDisplayModes()) {
        modes.subscribe(() => {
            for (const row of this.rows.values()) row.invalidate();
        });
    }

    /** Bind ordinary Pi callbacks and register their pure layout for nested calls. */
    bind<TArgs extends object>(spec: ToolPresentationSpec<TArgs>): BoundToolRenderers {
        const presentation = new ToolPresentationRenderer(spec);
        this.registerCallPresentation(spec.toolName, (args, theme, mode, width, indicator) => (
            presentation.renderCallLines(args as Partial<TArgs>, theme, mode, width, indicator)
        ));
        return {
            renderShell: "self",
            renderCall: (args, theme, context) => {
                this.observe(spec.toolName, args, context);
                // Pi renders streamed arguments before schema validation; layouts accept partial inputs.
                return presentation.renderCall(
                    args as Partial<TArgs> | undefined,
                    theme,
                    this.resolveMode(context.expanded, context.state),
                    {
                        isPartial: context.isPartial,
                        outputPad: context.outputPad,
                        indicator: () => context.state.pilotCallSpinner?.frame(),
                    },
                );
            },
            renderResult: (result, options, theme, context) => {
                if (!options.isPartial) this.complete(context.state);
                return presentation.renderResult(result, theme, {
                    isPartial: options.isPartial, isError: context.isError, outputPad: context.outputPad,
                }, this.resolveMode(options.expanded, context.state));
            },
        };
    }

    resolveMode(expanded: boolean, state?: {pilotFullDisplay?: boolean}): ToolDisplayMode {
        return this.modes.resolve(expanded, state);
    }

    registerCallPresentation(toolName: string, render: ToolCallPresentation): void {
        this.callPresentations.set(toolName, render);
    }

    callPresentation(toolName: string): ToolCallPresentation | undefined {
        return this.callPresentations.get(toolName);
    }

    /** Observe a top-level call and advance its animation lifecycle; exports are not live rows. */
    observe(toolName: string, args: unknown, context: DisplayContext): boolean {
        // Pi creates TUI rows before execution, including restored rows. HTML export
        // starts with executionStarted=true and a fresh state for the same call ID.
        if (!context.executionStarted) this.liveStates.add(context.state);
        if (!this.liveStates.has(context.state)) return false;
        if (!context.isPartial) this.complete(context.state);
        else if (context.state.pilotCallSpinner === undefined) {
            context.state.pilotCallSpinner = new ToolCallSpinner(context.invalidate);
        }
        const existing = this.rows.get(context.toolCallId);
        this.rows.set(context.toolCallId, {
            toolName,
            args,
            sequence: existing?.sequence ?? this.nextSequence++,
            state: context.state,
            invalidate: context.invalidate,
        });
        return true;
    }

    complete(state: ToolDisplayState): void {
        state.pilotCallSpinner?.stop();
        state.pilotCallSpinner = null;
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
        for (const row of this.rows.values()) this.complete(row.state);
        this.rows.clear();
        this.nextSequence = 1;
    }
}
