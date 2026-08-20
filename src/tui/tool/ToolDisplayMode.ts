export enum ToolDisplayMode {
    FULL = "full",
    TRUNCATED = "truncated",
    MINIMAL = "minimal",
}

export function resolveToolDisplayMode(
    expanded: boolean,
    state?: {pilotFullDisplay?: boolean},
): ToolDisplayMode {
    if (state?.pilotFullDisplay) return ToolDisplayMode.FULL;
    return expanded ? ToolDisplayMode.TRUNCATED : ToolDisplayMode.MINIMAL;
}
