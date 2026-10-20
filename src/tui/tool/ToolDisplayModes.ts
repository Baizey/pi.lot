import {resolveToolDisplayMode, ToolDisplayMode, type ToolDisplayViews} from "./ToolDisplayMode.js";

/** Shared view preferences; changing them redraws existing rows without changing session content. */
export class ToolDisplayModes {
    private views: ToolDisplayViews = {
        normal: ToolDisplayMode.MINIMAL,
        alternate: ToolDisplayMode.TRUNCATED,
    };
    private readonly listeners = new Set<() => void>();

    get values(): ToolDisplayViews {
        return {...this.views};
    }

    resolve(expanded: boolean, state?: {pilotFullDisplay?: boolean}): ToolDisplayMode {
        return resolveToolDisplayMode(expanded, state, this.views);
    }

    setViews(normal: ToolDisplayMode, alternate: ToolDisplayMode): void {
        if (this.views.normal === normal && this.views.alternate === alternate) return;
        this.views = {normal, alternate};
        for (const listener of this.listeners) listener();
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
