import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ThemeColor} from "./Color.js";

type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type ThinkingContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "ui">;

const THINKING_STEPS = {
    off: {filled: 0, color: ThemeColor.thinkingOff},
    minimal: {filled: 1, color: ThemeColor.thinkingMinimal},
    low: {filled: 2, color: ThemeColor.thinkingLow},
    medium: {filled: 3, color: ThemeColor.thinkingMedium},
    high: {filled: 4, color: ThemeColor.thinkingHigh},
    xhigh: {filled: 5, color: ThemeColor.thinkingXhigh},
    max: {filled: 6, color: ThemeColor.thinkingMax},
} satisfies Record<ThinkingLevel, {filled: number; color: ThemeColor}>;

const BAR_WIDTH = Math.max(...Object.values(THINKING_STEPS).map(({filled}) => filled));
const LABEL_WIDTH = Math.max(...Object.keys(THINKING_STEPS).map((level) => level.length));

/** Formats the live level with fixed cube and label columns, including trailing padding. */
export function formatThinkingIndicator(ctx: ThinkingContext, includeHeading = true): string {
    const level = ctx.model?.reasoning ? (ctx.thinkingLevel ?? "off") : "off";
    const {filled, color} = THINKING_STEPS[level];
    const total = Math.max(THINKING_STEPS.xhigh.filled, filled);
    const theme = ctx.ui.theme;
    const bar = theme.fg(color, "■".repeat(filled))
        + theme.fg(ThemeColor.thinkingOff, "□".repeat(total - filled));
    // Reserve max's sixth cube and pad labels on the right so both columns stay fixed.
    const barPadding = " ".repeat(BAR_WIDTH - total);
    const labelPadding = " ".repeat(LABEL_WIDTH - level.length);
    const heading = includeHeading ? `${theme.fg(ThemeColor.dim, "Thinking")} ` : "";
    return `${heading}${bar}${barPadding} ${theme.fg(color, level)}${labelPadding}`;
}
