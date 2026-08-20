import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {ThemeColor} from "../Color.js";
import {renderLineFactory} from "../terminalText.js";
import type {TextComponent} from "../terminalText.js";
import type {
    ToolArgumentPresentation,
    ToolPresentationSpec,
    ToolResultLike,
    ToolResultPresentation,
} from "./ToolPresentation.js";
import {
    ToolArgumentLayout,
    ToolArgumentPlacement,
    ToolTextDirection,
} from "./ToolPresentation.js";
import {ToolDisplayMode} from "./ToolDisplayMode.js";

const DEFAULT_ARGUMENT_PREVIEW_LINES = 8;
const DEFAULT_RESULT_PREVIEW_LINES = 5;
const DEFAULT_MAX_CALL_LINES = 100;
const DEFAULT_MAX_ARGUMENT_LINES = 100;

export type ToolResultRenderOptions = {
    isError?: boolean;
};

type ResolvedArgument<TArgs extends object> = {
    key: string;
    value: unknown;
    presentation: ToolArgumentPresentation<TArgs> | undefined;
    layout: ToolArgumentLayout;
    placement: ToolArgumentPlacement;
};

type TextWindowRow =
    | {kind: "content"; text: string}
    | {kind: "fold"; omitted: number; direction: ToolTextDirection}
    | {kind: "lines-omitted"; omitted: number; direction: ToolTextDirection}
    | {kind: "characters-omitted"};

export class ToolPresentationRenderer<TArgs extends object> {
    private readonly consumedKeysByOwner = new Map<string, string[]>();

    constructor(
        private readonly presentation: ToolPresentationSpec<TArgs>,
    ) {
        this.validatePresentation();
        for (const argument of presentation.arguments) {
            if (!argument.consumedBy) continue;
            const consumedKeys = this.consumedKeysByOwner.get(argument.consumedBy) ?? [];
            consumedKeys.push(argument.key);
            this.consumedKeysByOwner.set(argument.consumedBy, consumedKeys);
        }
    }

    renderCall(args: Partial<TArgs> | undefined, theme: Theme, mode: ToolDisplayMode): TextComponent {
        const normalizedArgs = (args ?? {}) as Partial<TArgs>;
        return renderLineFactory(() => this.toolCallLines(normalizedArgs, theme, mode));
    }

    renderResult(
        result: ToolResultLike,
        theme: Theme,
        options: ToolResultRenderOptions,
        mode: ToolDisplayMode,
    ): TextComponent {
        return renderLineFactory(() => this.toolResultLines(result, theme, options, mode));
    }

    private toolCallLines(args: Partial<TArgs>, theme: Theme, mode: ToolDisplayMode): string[] {
        const resolved = this.resolveArguments(args);
        const lines = mode === ToolDisplayMode.MINIMAL
            ? this.minimalCallLines(resolved, args, theme)
            : this.regularCallLines(resolved, args, theme, mode);
        return this.boundCallLines(lines, theme);
    }

    private minimalCallLines(
        resolved: ResolvedArgument<TArgs>[],
        args: Partial<TArgs>,
        theme: Theme,
    ): string[] {
        let title = this.toolTitle(theme);
        for (const argument of resolved) {
            if (argument.placement === ToolArgumentPlacement.BODY) continue;
            title = this.appendTitleArgument(title, argument, args, theme);
        }
        return [title];
    }

    private regularCallLines(
        resolved: ResolvedArgument<TArgs>[],
        args: Partial<TArgs>,
        theme: Theme,
        mode: ToolDisplayMode,
    ): string[] {
        let title = this.toolTitle(theme);
        for (const argument of resolved) {
            if (argument.placement === ToolArgumentPlacement.BODY) continue;
            title = this.appendTitleArgument(title, argument, args, theme);
        }

        const body = resolved.filter((argument) => argument.placement === ToolArgumentPlacement.BODY);
        const inline = body.filter((argument) => argument.layout === ToolArgumentLayout.INLINE);
        const blocks = body.filter((argument) => argument.layout === ToolArgumentLayout.BLOCK);
        const showLabels = body.length !== 1;
        return [
            title,
            ...inline.flatMap((argument) => this.bodyArgumentLines(argument, args, theme, showLabels, mode)),
            ...blocks.flatMap((argument) => this.bodyArgumentLines(argument, args, theme, showLabels, mode)),
        ];
    }

    private toolResultLines(
        result: ToolResultLike,
        theme: Theme,
        options: ToolResultRenderOptions,
        mode: ToolDisplayMode,
    ): string[] {
        if (mode === ToolDisplayMode.MINIMAL) return [];

        const text = collectResultText(result);
        if (!text) return [];
        const resultPresentation = this.presentation.result ?? {};
        const rows = selectTextRows(text, {
            mode,
            direction: resultPresentation.direction ?? ToolTextDirection.TAIL,
            previewLines: resultPresentation.previewLines ?? DEFAULT_RESULT_PREVIEW_LINES,
            maxCharacters: resultPresentation.maxCharacters ?? DEFAULT_MAX_BYTES,
            maxFullLines: resultPresentation.maxFullLines ?? DEFAULT_MAX_LINES,
        });
        const contentColor = options.isError ? ThemeColor.error : ThemeColor.toolOutput;
        return [
            "",
            ...rows.map((row) => this.textRow(row, theme, contentColor)),
        ];
    }

    private resolveArguments(args: Partial<TArgs>): ResolvedArgument<TArgs>[] {
        const values = args as Record<string, unknown>;
        const resolved: ResolvedArgument<TArgs>[] = [];
        const known = new Set<string>();

        for (const presentation of this.presentation.arguments) known.add(presentation.key);
        for (const presentation of this.presentation.arguments) {
            if (presentation.consumedBy) continue;
            const consumedKeys = this.consumedKeysByOwner.get(presentation.key) ?? [];
            const value = values[presentation.key];
            const hasConsumedValue = consumedKeys.some((key) => values[key] !== undefined);
            if (value === undefined && !hasConsumedValue) continue;
            resolved.push(this.resolveArgument(presentation.key, value, presentation));
        }

        const unknownKeys = Object.keys(values)
            .filter((key) => !known.has(key) && values[key] !== undefined)
            .sort(compareStrings);
        for (const key of unknownKeys) resolved.push(this.resolveArgument(key, values[key], undefined));
        return resolved;
    }

    private resolveArgument(
        key: string,
        value: unknown,
        presentation: ToolArgumentPresentation<TArgs> | undefined,
    ): ResolvedArgument<TArgs> {
        return {
            key,
            value,
            presentation,
            layout: presentation?.layout ?? inferredLayout(value),
            placement: presentation?.placement ?? ToolArgumentPlacement.BODY,
        };
    }

    private appendTitleArgument(
        title: string,
        argument: ResolvedArgument<TArgs>,
        args: Partial<TArgs>,
        theme: Theme,
    ): string {
        const value = this.formattedValue(argument, args, false);
        const color = argument.presentation?.color ?? ThemeColor.muted;
        if (argument.placement === ToolArgumentPlacement.TITLE_PRIMARY) {
            return `${title} ${theme.fg(color, "|")} ${theme.fg(color, value)}`;
        }
        if (argument.placement === ToolArgumentPlacement.TITLE_SECONDARY) {
            return `${title}${theme.fg(color, value)}`;
        }
        return title;
    }

    private bodyArgumentLines(
        argument: ResolvedArgument<TArgs>,
        args: Partial<TArgs>,
        theme: Theme,
        showLabel: boolean,
        mode: ToolDisplayMode,
    ): string[] {
        const contentColor = argument.presentation?.color ?? ThemeColor.dim;
        if (argument.layout === ToolArgumentLayout.INLINE) {
            const value = theme.fg(contentColor, this.formattedValue(argument, args, false));
            if (!showLabel) return [`    ${value}`];
            const label = theme.fg(ThemeColor.dim, `${this.argumentLabel(argument)}:`);
            return [`    ${label} ${value}`];
        }

        const text = this.formattedValue(argument, args, true);
        const rows = selectTextRows(text, {
            mode,
            direction: argument.presentation?.direction ?? ToolTextDirection.HEAD,
            previewLines: argument.presentation?.previewLines ?? DEFAULT_ARGUMENT_PREVIEW_LINES,
            maxCharacters: argument.presentation?.maxCharacters ?? DEFAULT_MAX_BYTES,
            maxFullLines: argument.presentation?.maxFullLines ?? DEFAULT_MAX_ARGUMENT_LINES,
        });
        const valueIndent = showLabel ? "        " : "    ";
        const lines = rows.map((row) => `${valueIndent}${this.textRow(row, theme, contentColor)}`);
        if (!showLabel) return lines;
        return [`    ${theme.fg(ThemeColor.dim, `${this.argumentLabel(argument)}:`)}`, ...lines];
    }

    private formattedValue(
        argument: ResolvedArgument<TArgs>,
        args: Partial<TArgs>,
        block: boolean,
    ): string {
        const formatted = argument.presentation?.format?.(argument.value, args);
        if (formatted !== undefined) return formatted || "\"\"";
        return block ? formatBlockValue(argument.value) : formatInlineValue(argument.value);
    }

    private argumentLabel(argument: ResolvedArgument<TArgs>): string {
        return argument.presentation?.label ?? argument.key;
    }

    private toolTitle(theme: Theme): string {
        return theme.fg(ThemeColor.toolTitle, theme.bold(this.presentation.toolName));
    }

    private textRow(row: TextWindowRow, theme: Theme, contentColor: ThemeColor): string {
        if (row.kind === "content") return theme.fg(contentColor, row.text);
        if (row.kind === "fold") return foldNotice(row.omitted, row.direction, theme);
        if (row.kind === "lines-omitted") {
            return theme.fg(ThemeColor.warning, omittedLinesNotice(row.omitted));
        }
        return theme.fg(ThemeColor.warning, "[display truncated]");
    }

    private boundCallLines(lines: string[], theme: Theme): string[] {
        const limit = positiveInteger(this.presentation.maxCallLines, DEFAULT_MAX_CALL_LINES);
        if (lines.length <= limit) return lines;
        const contentLines = Math.max(0, limit - 1);
        return [
            ...lines.slice(0, contentLines),
            theme.fg(ThemeColor.warning, omittedLinesNotice(lines.length - contentLines)),
        ];
    }

    private validatePresentation(): void {
        if (!this.presentation.toolName.trim()) throw new Error("Tool presentation name must not be empty");

        const argumentsByKey = new Map<string, ToolArgumentPresentation<TArgs>>();
        for (const argument of this.presentation.arguments) {
            if (argumentsByKey.has(argument.key)) {
                throw new Error(`Tool presentation contains duplicate argument: ${argument.key}`);
            }
            if (argument.consumedBy) {
                const owner = argumentsByKey.get(argument.consumedBy);
                if (!owner) {
                    throw new Error(
                        `Consumed argument ${argument.key} must reference an earlier argument: ${argument.consumedBy}`,
                    );
                }
                if (owner.consumedBy || owner.placement !== ToolArgumentPlacement.TITLE_SECONDARY) {
                    throw new Error(`Consumed argument owner must be a title secondary: ${argument.consumedBy}`);
                }
                if (argument.placement !== ToolArgumentPlacement.TITLE_SECONDARY) {
                    throw new Error(`Consumed argument must be a title secondary: ${argument.key}`);
                }
                if (!owner.format) {
                    throw new Error(`Consumed argument owner must define a formatter: ${argument.consumedBy}`);
                }
            }
            argumentsByKey.set(argument.key, argument);
            if (
                argument.layout === ToolArgumentLayout.BLOCK
                && argument.placement !== undefined
                && argument.placement !== ToolArgumentPlacement.BODY
            ) {
                throw new Error(`Title argument cannot use block layout: ${argument.key}`);
            }
            validatePositiveOption(argument.previewLines, `${argument.key}.previewLines`);
            validatePositiveOption(argument.maxCharacters, `${argument.key}.maxCharacters`);
            validatePositiveOption(argument.maxFullLines, `${argument.key}.maxFullLines`);
        }

        validatePositiveOption(this.presentation.maxCallLines, "maxCallLines");
        this.validateResultPresentation(this.presentation.result);
    }

    private validateResultPresentation(result: ToolResultPresentation | undefined): void {
        if (!result) return;
        validatePositiveOption(result.previewLines, "result.previewLines");
        validatePositiveOption(result.maxCharacters, "result.maxCharacters");
        validatePositiveOption(result.maxFullLines, "result.maxFullLines");
    }
}

type TextWindowOptions = {
    mode: ToolDisplayMode;
    direction: ToolTextDirection;
    previewLines: number;
    maxCharacters: number;
    maxFullLines: number;
};

function selectTextRows(value: string, options: TextWindowOptions): TextWindowRow[] {
    const maxCharacters = positiveInteger(options.maxCharacters, 1);
    const characterTruncated = value.length > maxCharacters;
    const bounded = characterTruncated
        ? options.direction === ToolTextDirection.TAIL
            ? value.slice(-maxCharacters)
            : value.slice(0, maxCharacters)
        : value;
    const lines = logicalLines(bounded);
    const reservedCharacterNotice = characterTruncated && options.mode === ToolDisplayMode.FULL ? 1 : 0;
    const lineLimit = options.mode === ToolDisplayMode.TRUNCATED
        ? positiveInteger(options.previewLines, 1)
        : Math.max(0, positiveInteger(options.maxFullLines, 1) - reservedCharacterNotice);
    const needsLineNotice = lines.length > lineLimit;
    const contentLimit = options.mode === ToolDisplayMode.FULL && needsLineNotice
        ? Math.max(0, lineLimit - 1)
        : lineLimit;
    const selected = options.direction === ToolTextDirection.TAIL
        ? lines.slice(Math.max(0, lines.length - contentLimit))
        : lines.slice(0, contentLimit);
    let rows: TextWindowRow[] = selected.map((text) => ({kind: "content", text}));

    if (needsLineNotice) {
        const omitted = lines.length - selected.length;
        const notice: TextWindowRow = options.mode === ToolDisplayMode.TRUNCATED
            ? {kind: "fold", omitted, direction: options.direction}
            : {kind: "lines-omitted", omitted, direction: options.direction};
        rows = addBoundaryRow(rows, notice, options.direction);
    }
    if (characterTruncated) {
        rows = addBoundaryRow(rows, {kind: "characters-omitted"}, options.direction);
    }
    return rows;
}

function addBoundaryRow(
    rows: TextWindowRow[],
    notice: TextWindowRow,
    direction: ToolTextDirection,
): TextWindowRow[] {
    return direction === ToolTextDirection.TAIL ? [notice, ...rows] : [...rows, notice];
}

function logicalLines(value: string): string[] {
    if (!value) return [];
    const lines = value.replace(/\r\n|\r/g, "\n").split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function collectResultText(result: ToolResultLike): string {
    return (result.content ?? [])
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text ?? "")
        .join("\n");
}

function inferredLayout(value: unknown): ToolArgumentLayout {
    if (typeof value === "string" && /[\r\n]/.test(value)) return ToolArgumentLayout.BLOCK;
    if (value !== null && typeof value === "object") return ToolArgumentLayout.BLOCK;
    return ToolArgumentLayout.INLINE;
}

function formatInlineValue(value: unknown): string {
    if (typeof value === "string") return value || "\"\"";
    if (value === undefined || value === null) return String(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    return jsonValue(value, false);
}

function formatBlockValue(value: unknown): string {
    if (typeof value === "string") return value || "\"\"";
    if (value === undefined || value === null) return String(value);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    return jsonValue(value, true);
}

function jsonValue(value: unknown, pretty: boolean): string {
    try {
        return JSON.stringify(value, bigintJsonValue, pretty ? 2 : undefined) ?? String(value);
    } catch {
        return "[unserializable]";
    }
}

function bigintJsonValue(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? String(value) : value;
}

function foldNotice(omitted: number, direction: ToolTextDirection, theme: Theme): string {
    const location = direction === ToolTextDirection.TAIL ? "earlier" : "more";
    const count = `${omitted} ${location} ${omitted === 1 ? "line" : "lines"}`;
    return theme.fg(ThemeColor.muted, `... (${count})`);
}

function omittedLinesNotice(omitted: number): string {
    return `... (${omitted} ${omitted === 1 ? "line" : "lines"} omitted from display)`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return Math.max(1, Math.floor(fallback));
    return Math.max(1, Math.floor(value));
}

function validatePositiveOption(value: number | undefined, name: string): void {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}
