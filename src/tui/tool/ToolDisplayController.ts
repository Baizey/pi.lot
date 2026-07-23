import type {ExtensionContext} from "@earendil-works/pi-coding-agent";

export const TOOL_EXPANDED_KEY_TEXT = "ctrl+o";
export const TOOL_MINIMAL_KEY_TEXT = "alt+o";

export enum ToolDisplayMode {
    FULL = "full",
    TRUNCATED = "truncated",
    MINIMAL = "minimal",
}

export type ToolDisplayModeSource = {
    currentMode(): ToolDisplayMode;
};

export class ToolDisplayController implements ToolDisplayModeSource {
    private regularMode = ToolDisplayMode.TRUNCATED;
    private minimal = false;

    constructor(private readonly ctx: ExtensionContext) {
        this.applyMode();
    }

    currentMode(): ToolDisplayMode {
        return this.minimal ? ToolDisplayMode.MINIMAL : this.regularMode;
    }

    toggleExpanded(): ToolDisplayMode {
        if (this.minimal) {
            this.minimal = false;
        } else {
            this.regularMode = this.regularMode === ToolDisplayMode.FULL
                ? ToolDisplayMode.TRUNCATED
                : ToolDisplayMode.FULL;
        }
        this.applyMode();
        return this.currentMode();
    }

    synchronizeExpanded(expanded: boolean): ToolDisplayMode {
        if (this.minimal && !expanded) return ToolDisplayMode.MINIMAL;
        this.minimal = false;
        this.regularMode = expanded ? ToolDisplayMode.FULL : ToolDisplayMode.TRUNCATED;
        return this.currentMode();
    }

    toggleMinimal(): ToolDisplayMode {
        this.minimal = !this.minimal;
        this.applyMode();
        return this.currentMode();
    }

    private applyMode(): void {
        if (this.ctx.mode !== "tui") return;
        this.ctx.ui.setToolsExpanded(this.currentMode() === ToolDisplayMode.FULL);
    }
}
