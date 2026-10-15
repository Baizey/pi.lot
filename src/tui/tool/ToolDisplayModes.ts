import {resolveToolDisplayMode, ToolDisplayMode, type ToolDisplayViews} from "./ToolDisplayMode.js";

/** Shared view preferences; changing them redraws existing rows without changing session content. */
export class ToolDisplayModes {
    private views: ToolDisplayViews = {
        primary: ToolDisplayMode.MINIMAL,
        alternate: ToolDisplayMode.TRUNCATED,
    };
    private readonly listeners = new Set<() => void>();

    resolve(expanded: boolean, state?: {pilotFullDisplay?: boolean}): ToolDisplayMode {
        return resolveToolDisplayMode(expanded, state, this.views);
    }

    setViews(primary: ToolDisplayMode, alternate: ToolDisplayMode): void {
        if (this.views.primary === primary && this.views.alternate === alternate) return;
        this.views = {primary, alternate};
        for (const listener of this.listeners) listener();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
