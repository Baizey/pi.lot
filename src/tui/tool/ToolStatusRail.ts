import type {Theme} from "@earendil-works/pi-coding-agent";
import type {Component} from "@earendil-works/pi-tui";

export type ToolStatusContext = {
    isPartial: boolean;
    isError: boolean;
};

/** Self-rendered tool shell that paints only its first terminal cell with the tool status background. */
export class ToolStatusRail implements Component {
    constructor(
        private readonly content: Component,
        private readonly theme: Theme,
        private readonly status: ToolStatusContext,
    ) {
    }

    render(width: number): string[] {
        const availableWidth = normalizedWidth(width);
        if (availableWidth === 0) return [];

        const contentWidth = availableWidth === Number.POSITIVE_INFINITY
            ? availableWidth
            : Math.max(1, availableWidth - 1);
        const lines = this.content.render(contentWidth);
        const rail = this.theme.bg(this.backgroundColor(), " ");
        return lines.map((line) => availableWidth === 1 ? rail : `${rail}${trimTrailingSpaces(line)}`);
    }

    invalidate(): void {
        this.content.invalidate();
    }

    private backgroundColor(): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
        if (this.status.isPartial) return "toolPendingBg";
        return this.status.isError ? "toolErrorBg" : "toolSuccessBg";
    }
}

function trimTrailingSpaces(line: string): string {
    return line.replace(/ +$/, "");
}

function normalizedWidth(width: number): number {
    if (width === Number.POSITIVE_INFINITY) return width;
    if (!Number.isFinite(width) || width <= 0) return 0;
    return Math.floor(width);
}
