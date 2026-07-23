import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {ThemeColor} from "./Color.js";
import {truncateToWidth} from "./terminalText.js";

type ValueOrLambda<T, K> = K | ((state: Partial<T>) => K);

type Component = {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
};

type ShortcutTui = {requestRender(): void};
type ShortcutTheme = {
    fg?: (name: ThemeColor, text: string) => string;
    bg?: (name: string, text: string) => string;
    bold?: (text: string) => string;
};
type ShortcutKeybindings = {matches?: (data: string, key: string) => boolean};
type ShortcutCustomUi = {
    custom<T>(factory: (tui: ShortcutTui, theme: ShortcutTheme, keybindings: ShortcutKeybindings, done: (value: T) => void) => Component): Promise<T>;
};

/**
 * K cannot be a function.
 */
const parse = <T, K>(lambdaMaybe: ValueOrLambda<T, K>, input: Partial<T>): K => {
    if (typeof lambdaMaybe === "function") {
        return (lambdaMaybe as ((state: Partial<T>) => K))(input);
    }
    return lambdaMaybe;
};

function isUiFlowShortcut(value: unknown): value is UiFlowShortcut {
    return value === UiFlowShortcut.ALLOW_ALL_ONCE || value === UiFlowShortcut.DENY_ALL_ONCE;
}

export type UiSelectDecisionOption<T> = {
    title: ValueOrLambda<T, string>;
    /**
     * Should technically be bound to T[keyof T] for the relevant key, but please just remember this on usage
     */
    value: T[keyof T];
    /**
     * Returns the key of the next decision to run
     * Return null if the flow is completed and should finish
     */
    next: ValueOrLambda<T, keyof T | null>;
};

export type UiDecision<T> = UiSelectDecision<T> | UiInputDecision<T>;

export enum UiFlowShortcut {
    ALLOW_ALL_ONCE = "ALLOW_ALL_ONCE",
    DENY_ALL_ONCE = "DENY_ALL_ONCE",
}

export type UiFlowShortcutOptions = {
    enabled?: boolean;
};

export type UiDecisionFlowOptions = {
    shortcuts?: UiFlowShortcutOptions;
    signal?: AbortSignal;
};

export type UiSelectDecision<T> = {
    type: "select";
    title: ValueOrLambda<T, string>;
    key: keyof T;
    options: UiSelectDecisionOption<T>[];
};

export type UiInputDecision<T> = {
    type: "input";
    title: ValueOrLambda<T, string>;
    key: keyof T;
    placeholder: ValueOrLambda<T, string>;
    next: ValueOrLambda<T, keyof T | null>;
};

export class UiDecisionFlowManager {
    constructor(private readonly ctx: ExtensionContext) {}

    async runFlow<T>(
        initialDecision: UiDecision<T>,
        allDecisions: Record<keyof T, UiDecision<T>>,
        onCancelReturn: (state: Partial<T>) => T,
        options: UiDecisionFlowOptions = {},
    ): Promise<T | UiFlowShortcut> {
        const state = {} as Partial<T>;
        if (!this.ctx.hasUI || options.signal?.aborted || !this.ctx.ui?.select) {
            return onCancelReturn(state);
        }

        let currentDecision = initialDecision;
        while (currentDecision) {
            const choice = await this.resolveDecision(currentDecision, state, options);
            if (!choice) return onCancelReturn(state);
            if (isUiFlowShortcut(choice)) return choice;

            state[currentDecision.key] = choice.value;
            const nextDecisionKey = parse(choice.next, state);
            if (!nextDecisionKey) break;

            const nextDecision = allDecisions[nextDecisionKey];
            if (!nextDecision) throw new Error(`Decision ${String(nextDecisionKey)} is not defined.`);
            currentDecision = nextDecision;
        }
        return state as T;
    }

    private async resolveDecision<T>(
        decision: UiDecision<T>,
        state: Partial<T>,
        options: UiDecisionFlowOptions,
    ): Promise<UiSelectDecisionOption<T> | UiFlowShortcut | null> {
        if (options.signal?.aborted) return null;
        const title = parse(decision.title, state);

        switch (decision.type) {
            case "select":
                return this.resolveSelectDecision(decision, state, title, options);
            case "input":
                return this.resolveInputDecision(decision, state, title, options.signal);
            default:
                throw new Error(`Decision type ${(decision as {type: string}).type} not supported.`);
        }
    }

    private async resolveSelectDecision<T>(
        decision: UiSelectDecision<T>,
        state: Partial<T>,
        title: string,
        options: UiDecisionFlowOptions,
    ): Promise<UiSelectDecisionOption<T> | UiFlowShortcut | null> {
        const renderedOptions = decision.options.map((option) => renderOptionTitle(option, state));
        const lookup = Object.fromEntries(renderedOptions.map((renderedTitle, index) => (
            [renderedTitle, decision.options[index]]
        )));

        const choice = options.shortcuts?.enabled && hasShortcutUi(this.ctx)
            ? await shortcutSelect(this.ctx.ui, title, renderedOptions, options.signal)
            : await this.ctx.ui!.select(title, renderedOptions, {signal: options.signal});

        if (!choice || options.signal?.aborted) return null;
        if (isUiFlowShortcut(choice)) return choice;
        return lookup[choice] ?? null;
    }

    private async resolveInputDecision<T>(
        decision: UiInputDecision<T>,
        state: Partial<T>,
        title: string,
        signal?: AbortSignal,
    ): Promise<UiSelectDecisionOption<T> | null> {
        if (!this.ctx.ui?.input) return null;
        const input = await this.ctx.ui.input(title, parse(decision.placeholder, state), {signal});
        if (input === undefined || signal?.aborted) return null;
        return {
            title: "",
            value: (input || "") as T[keyof T],
            next: decision.next,
        } satisfies UiSelectDecisionOption<T>;
    }
}

function renderOptionTitle<T>(option: UiSelectDecisionOption<T>, state: Partial<T>): string {
    return parse(option.title, state);
}

function hasShortcutUi(ctx: ExtensionContext): ctx is ExtensionContext & {ui: ShortcutCustomUi} {
    return ctx.mode === "tui" && typeof (ctx.ui as {custom?: unknown} | undefined)?.custom === "function";
}

async function shortcutSelect(
    ui: ShortcutCustomUi,
    title: string,
    options: string[],
    signal?: AbortSignal,
): Promise<string | UiFlowShortcut | undefined> {
    return ui.custom<string | UiFlowShortcut | undefined>((tui, theme, keybindings, done) => {
        return new ShortcutSelectComponent(tui, theme, keybindings, done, title, options, signal);
    });
}

class ShortcutSelectComponent implements Component {
    private selected = 0;
    private completed = false;

    constructor(
        private readonly tui: ShortcutTui,
        private readonly theme: ShortcutTheme,
        private readonly keybindings: ShortcutKeybindings,
        private readonly done: (value: string | UiFlowShortcut | undefined) => void,
        private readonly title: string,
        private readonly options: string[],
        private readonly signal?: AbortSignal,
    ) {
        if (signal?.aborted) queueMicrotask(() => this.complete(undefined));
        else signal?.addEventListener("abort", this.handleAbort, {once: true});
    }

    render(width: number): string[] {
        const titleLines = this.title.split(/\r?\n/).map((line) => this.color(ThemeColor.accent, this.bold(line)));
        const optionLines = this.options.map((option, index) => this.renderOption(option, index));
        return [...titleLines, "", ...optionLines].map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        if (this.isRight(data)) return this.complete(UiFlowShortcut.ALLOW_ALL_ONCE);
        if (this.isLeft(data)) return this.complete(UiFlowShortcut.DENY_ALL_ONCE);
        if (this.isUp(data)) this.moveSelection(-1);
        else if (this.isDown(data)) this.moveSelection(1);
        else if (this.isEnter(data)) return this.complete(this.options[this.selected]);
        else if (this.isEscape(data)) return this.complete(undefined);
        this.tui.requestRender();
    }

    invalidate(): void {}

    dispose(): void {
        this.signal?.removeEventListener("abort", this.handleAbort);
    }

    private readonly handleAbort = (): void => this.complete(undefined);

    private complete(value: string | UiFlowShortcut | undefined): void {
        if (this.completed) return;
        this.completed = true;
        this.dispose();
        this.done(value);
    }

    private renderOption(option: string, index: number): string {
        const prefix = index === this.selected ? "› " : "  ";
        const line = `${prefix}${option}`;
        return index === this.selected ? this.bg("selectedBg", this.color(ThemeColor.accent, line)) : line;
    }

    private moveSelection(delta: -1 | 1): void {
        if (this.options.length === 0) return;
        this.selected = (this.selected + delta + this.options.length) % this.options.length;
    }

    private isLeft(data: string): boolean {
        return this.matches(data, "tui.editor.cursorLeft") || this.matches(data, "tui.select.pageUp") || data === "\x1b[D";
    }

    private isRight(data: string): boolean {
        return this.matches(data, "tui.editor.cursorRight") || this.matches(data, "tui.select.pageDown") || data === "\x1b[C";
    }

    private isUp(data: string): boolean {
        return this.matches(data, "tui.select.up") || data === "\x1b[A";
    }

    private isDown(data: string): boolean {
        return this.matches(data, "tui.select.down") || data === "\x1b[B";
    }

    private isEnter(data: string): boolean {
        return this.matches(data, "tui.select.confirm") || data === "\r" || data === "\n";
    }

    private isEscape(data: string): boolean {
        return this.matches(data, "tui.select.cancel") || data === "\x1b";
    }

    private matches(data: string, key: string): boolean {
        return this.keybindings.matches?.(data, key) === true;
    }

    private color(name: ThemeColor, text: string): string {
        return this.theme.fg ? this.theme.fg(name, text) : text;
    }

    private bg(name: string, text: string): string {
        return this.theme.bg ? this.theme.bg(name, text) : text;
    }

    private bold(text: string): string {
        return this.theme.bold ? this.theme.bold(text) : text;
    }
}
