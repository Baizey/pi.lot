const sgrPattern = /\x1b\[[0-?]*[ -/]*m/g;
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
  invalidate(): void
};

/** Creates a static component whose lines always satisfy Pi's width contract. */
export function renderLines(lines: readonly string[]): TextComponent {
  const snapshot = [...lines];
  return renderLineFactory(() => snapshot);
}

/** Rebuilds logical lines for each render instead of caching derived content. */
export function renderLineFactory(buildLines: () => readonly string[]): TextComponent {
  return {
    render(width: number): string[] {
      // Pi resets SGR state after each rendered line. Keeping our own trailing
      // full reset would clear the surrounding tool Box background before its padding.
      return buildLines().map(line => withoutTrailingFullReset(truncateToWidth(line, width)));
    },
    invalidate(): void {
      // No cache: the next render rebuilds the logical lines.
    },
  };
}

/** Sanitizes one terminal line and truncates it to at most `width` columns. */
export function truncateToWidth(value: string, width: number): string {
  const line = sanitizeTerminalLine(value);
  const columns = renderWidth(width);
  if (columns === Number.POSITIVE_INFINITY) return line;
  if (columns === 0) return "";
  if (visibleWidth(line) <= columns) return line;
  if (columns === 1) return "…";

  return truncateSanitizedLine(line, columns - 1);
}

export function sanitizeTerminalLine(value: string): string {
  const singleLine = value.replace(/\t/g, "  ").replace(lineBreakPattern, " ");
  const sgrOnly = singleLine
    .split(sgrTokenPattern)
    .map(token => exactSgrPattern.test(token) ? token : token.replace(nonSgrEscapePattern, ""))
    .join("");
  const sanitized = sgrOnly.replace(unsafeControlPattern, "");
  return containsSgrPattern.test(sanitized) && !sanitized.endsWith("\x1b[0m")
    ? `${sanitized}\x1b[0m`
    : sanitized;
}

function withoutTrailingFullReset(value: string): string {
  return value.endsWith("\x1b[0m") ? value.slice(0, -4) : value;
}

function renderWidth(width: number): number {
  if (width === Number.POSITIVE_INFINITY) return width;
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.floor(width);
}

function truncateSanitizedLine(line: string, textColumns: number): string {
  let result = "";
  let usedColumns = 0;
  let containsSgr = false;

  for (const token of line.split(sgrTokenPattern).filter(Boolean)) {
    if (exactSgrPattern.test(token)) {
      result += token;
      containsSgr = true;
      continue;
    }

    for (const character of token) {
      const nextWidth = usedColumns + terminalCharacterWidth(character);
      if (nextWidth > textColumns) return `${result}…${containsSgr ? "\x1b[0m" : ""}`;
      result += character;
      usedColumns = nextWidth;
    }
  }

  return result;
}

function visibleWidth(value: string): number {
  let width = 0;
  for (const character of value.replace(sgrPattern, "")) width += terminalCharacterWidth(character);
  return width;
}

function terminalCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (isZeroWidth(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

function isZeroWidth(codePoint: number): boolean {
  return codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7f && codePoint < 0xa0)
    || (codePoint >= 0x300 && codePoint <= 0x36f);
}

function isWide(codePoint: number): boolean {
  // Conservatively treat supplementary-plane characters as wide. Over-counting
  // is preferable to violating the TUI width contract.
  if (codePoint >= 0x10000) return true;
  if (codePoint < 0x1100) return false;

  return codePoint <= 0x115f
    || (codePoint >= 0x2300 && codePoint <= 0x23ff)
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
    || (codePoint >= 0x2b00 && codePoint <= 0x2bff)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6);
}
