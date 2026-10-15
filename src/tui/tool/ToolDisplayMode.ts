export enum ToolDisplayMode {
    HIDDEN = "hidden",
    FULL = "full",
    TRUNCATED = "truncated",
    MINIMAL = "minimal",
}

export type ToolDisplayViews = {
    primary: ToolDisplayMode;
    alternate: ToolDisplayMode;
};

export function resolveToolDisplayMode(
    expanded: boolean,
    state?: {pilotFullDisplay?: boolean},
    views?: ToolDisplayViews,
): ToolDisplayMode {
    const mode = expanded
        ? (views?.alternate ?? ToolDisplayMode.TRUNCATED)
        : (views?.primary ?? ToolDisplayMode.MINIMAL);
    // Hidden is conversation-only, including calls previously expanded individually.
    if (mode === ToolDisplayMode.HIDDEN) return mode;
    return state?.pilotFullDisplay ? ToolDisplayMode.FULL : mode;
}
