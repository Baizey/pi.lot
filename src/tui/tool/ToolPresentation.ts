import type {ThemeColor} from "../Color.js";

export enum ToolArgumentLayout {
    INLINE = "inline",
    BLOCK = "block",
}

export enum ToolArgumentPlacement {
    BODY = "body",
    TITLE_PRIMARY = "title-primary",
    TITLE_SECONDARY = "title-secondary",
}

export enum ToolTextDirection {
    HEAD = "head",
    TAIL = "tail",
}

export type ToolArgumentPresentation<TArgs extends object> = {
    key: Extract<keyof TArgs, string>;
    label?: string;
    layout?: ToolArgumentLayout;
    placement?: ToolArgumentPlacement;
    consumedBy?: Extract<keyof TArgs, string>;
    color?: ThemeColor;
    direction?: ToolTextDirection;
    previewLines?: number;
    maxCharacters?: number;
    maxFullLines?: number;
    format?: (value: unknown, args: Partial<TArgs>) => string;
};

export type ToolResultPresentation = {
    direction?: ToolTextDirection;
    color?: ThemeColor | ((line: string) => ThemeColor);
    previewLines?: number;
    maxCharacters?: number;
    maxFullLines?: number;
};

export type ToolPresentationSpec<TArgs extends object> = {
    toolName: string;
    arguments: readonly ToolArgumentPresentation<TArgs>[];
    result?: ToolResultPresentation;
    maxCallLines?: number;
};

export type ToolResultLike = {
    content?: ReadonlyArray<{
        type: string;
        text?: string;
    }>;
};
