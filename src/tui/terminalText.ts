import {
    truncateToWidth as truncateToPiWidth,
    visibleWidth as piVisibleWidth,
} from "@earendil-works/pi-tui";

const FULL_RESET = "\x1b[0m";
const ELLIPSIS = "…";
const sgrTokenPattern = /(\x1b\[[0-?]*[ -/]*m)/g;
const exactSgrPattern = /^\x1b\[[0-?]*[ -/]*m$/;
const containsSgrPattern = /\x1b\[[0-?]*[ -/]*m/;
const nonSgrEscapePattern = /\x1b(?:][^\x1b\x07]*(?:\x07|\x1b\\)?|\[[0-?]*[ -/]*[@-~]|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])|\x1b/g;
const unsafeControlPattern = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g;
const lineBreakPattern = /\r\n|\n|\r/g;

export type TextComponent = {
    render(width: number): string[];
    handleInput?(data: string): void;
    wantsKeyRelease?: boolean;
    invalidate(): void;
};

/** Measures terminal columns exactly as Pi measures them before rendering. */
export function displayWidth(value: string): number {
    return piVisibleWidth(value);
}

/** Creates a static component whose lines always satisfy Pi's width contract. */
export function renderLines(lines: readonly string[]): TextComponent {
    const snapshot = [...lines];
    return renderLineFactory(() => snapshot);
}

/** Rebuilds logical lines for each render instead of caching derived content. */
export function renderLineFactory(buildLines: () => readonly string[]): TextComponent {
    return {
        render(width: number): string[] {
            // Pi resets SGR state after each rendered line. A redundant trailing
            // full reset can interfere with styling applied by an outer component.
            return buildLines().map((line) => withoutTrailingFullReset(truncateToWidth(line, width)));
        },
        invalidate(): void {
            // No cache: the next render rebuilds the logical lines.
        },
    };
}

/** Sanitizes one terminal line and truncates it to at most `width` Pi columns. */
export function truncateToWidth(value: string, width: number): string {
    const line = sanitizeTerminalLine(value);
    const columns = renderWidth(width);
    if (columns === Number.POSITIVE_INFINITY) return line;
    if (columns === 0) return "";
    if (displayWidth(line) <= columns) return line;

    let bounded = normalizeTruncationSuffix(truncateToPiWidth(line, columns, ELLIPSIS));
    if (!containsSgrPattern.test(line)) bounded = withoutTrailingFullReset(bounded);

    // Fail closed if a future TUI truncation regression violates its own width contract.
    return displayWidth(bounded) <= columns ? bounded : "";
}

export function sanitizeTerminalLine(value: string): string {
    const singleLine = value.replace(/\t/g, "  ").replace(lineBreakPattern, " ");
    const sgrOnly = singleLine
        .split(sgrTokenPattern)
        .map((token) => exactSgrPattern.test(token) ? token : token.replace(nonSgrEscapePattern, ""))
        .join("");
    const sanitized = sgrOnly.replace(unsafeControlPattern, "");
    return containsSgrPattern.test(sanitized) && !sanitized.endsWith(FULL_RESET)
        ? `${sanitized}${FULL_RESET}`
        : sanitized;
}

function normalizeTruncationSuffix(value: string): string {
    const suffix = `${FULL_RESET}${ELLIPSIS}${FULL_RESET}`;
    if (!value.endsWith(suffix)) return value;
    return `${value.slice(0, -suffix.length)}${ELLIPSIS}${FULL_RESET}`;
}

function withoutTrailingFullReset(value: string): string {
    return value.endsWith(FULL_RESET) ? value.slice(0, -FULL_RESET.length) : value;
}

function renderWidth(width: number): number {
    if (width === Number.POSITIVE_INFINITY) return width;
    if (!Number.isFinite(width) || width <= 0) return 0;
    return Math.floor(width);
}
