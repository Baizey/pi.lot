import {ToolDisplayMode} from "./ToolDisplayMode.js";

/** User-facing vocabulary is independent of the renderer's internal mode names. */
export const displayModeChoices = [
    {mode: ToolDisplayMode.HIDDEN, title: "Conversation", value: "conversation"},
    {mode: ToolDisplayMode.MINIMAL, title: "Compact", value: "compact"},
    {mode: ToolDisplayMode.TRUNCATED, title: "Preview", value: "preview"},
    {mode: ToolDisplayMode.FULL, title: "Full", value: "full"},
] as const;

export function displayModeTitle(mode: ToolDisplayMode): string {
    return displayModeChoices.find((choice) => choice.mode === mode)!.title;
}

export function parseDisplayMode(value: string): ToolDisplayMode | undefined {
    return displayModeChoices.find((choice) => choice.value === value.toLowerCase())?.mode;
}
