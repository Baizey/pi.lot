import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {wrapTextWithAnsi} from "@earendil-works/pi-tui";
import {
    decisionDisplayText,
    decisionFieldLines,
    formatUiDecisionPrompt,
    type UiDecisionContext,
    type UiDecisionField,
} from "./UiDecisionPrompt.js";
import {ThemeColor} from "./Color.js";
import {displayWidth, truncateToWidth} from "./terminalText.js";
import {UiDecisionFlowQueue} from "./UiDecisionFlowQueue.js";

type ValueOrLambda<T, K> = K | ((state: Partial<T>) => K);

type Component = {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
};

type ShortcutTui = {requestRender(): void; terminal?: {rows: number}};
type ShortcutTheme = {
    fg?: (name: ThemeColor, text: string) => string;
    bg?: (name: string, text: string) => string;
    bold?: (text: string) => string;
};
type ShortcutKeybindings = {
    matches?: (data: string, key: string) => boolean;
    getKeys?: (key: string) => readonly string[];
};
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

export type UiDecisionFlowOptions<T> = {
    shortcuts?: UiFlowShortcutOptions;
    signal?: AbortSignal;
    beforeStart?: () => T | UiFlowShortcut | undefined;
    afterFinish?: (result: T | UiFlowShortcut) => void | Promise<void>;
};

export type UiSelectDecision<T> = {
    type: "select";
    title: ValueOrLambda<T, string>;
    context?: ValueOrLambda<T, UiDecisionContext>;
    key: keyof T;
    options: UiSelectDecisionOption<T>[];
};

export type UiInputDecision<T> = {
    type: "input";
    title: ValueOrLambda<T, string>;
    context?: ValueOrLambda<T, UiDecisionContext>;
    key: keyof T;
    placeholder: ValueOrLambda<T, string>;
    next: ValueOrLambda<T, keyof T | null>;
};

export class UiDecisionFlowManager {
    constructor(
        private readonly ctx: ExtensionContext,
        private readonly queue: UiDecisionFlowQueue = new UiDecisionFlowQueue(),
    ) {}

    async runFlow<T>(
        initialDecision: UiDecision<T>,
        allDecisions: Record<keyof T, UiDecision<T>>,
        onCancelReturn: (state: Partial<T>) => T,
        options: UiDecisionFlowOptions<T> = {},
    ): Promise<T | UiFlowShortcut> {
        const state = {} as Partial<T>;
        let cancellation: T | undefined;
        let hasCancellation = false;
        const cancel = (): T => {
            if (!hasCancellation) {
                cancellation = onCancelReturn(state);
                hasCancellation = true;
            }
            return cancellation!;
        };
        const signal = options.signal
            ? AbortSignal.any([options.signal, this.queue.signal])
            : this.queue.signal;
        if (signal.aborted) return cancel();

        const queuedOptions = {...options, signal};
        const scheduled = this.queue.enqueue(() => this.runQueuedFlow(
            initialDecision,
            allDecisions,
            state,
            cancel,
            queuedOptions,
        ));

        return new Promise<T | UiFlowShortcut>((resolve, reject) => {
            const onAbort = () => {
                try {
                    resolve(cancel());
                } catch (error) {
                    reject(error);
                }
            };
            signal.addEventListener("abort", onAbort, {once: true});
            void scheduled.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
        });
    }

    private async runQueuedFlow<T>(
        initialDecision: UiDecision<T>,
        allDecisions: Record<keyof T, UiDecision<T>>,
        state: Partial<T>,
        cancel: () => T,
        options: UiDecisionFlowOptions<T>,
    ): Promise<T | UiFlowShortcut> {
        let result: T | UiFlowShortcut;
        if (options.signal?.aborted) {
            result = cancel();
        } else {
            const resolvedBeforeStart = options.beforeStart?.();
            result = resolvedBeforeStart ?? await this.runActiveFlow(
                initialDecision,
                allDecisions,
                state,
                cancel,
                options,
            );
        }
        await options.afterFinish?.(result);
        return result;
    }

    private async runActiveFlow<T>(
        initialDecision: UiDecision<T>,
        allDecisions: Record<keyof T, UiDecision<T>>,
        state: Partial<T>,
        cancel: () => T,
        options: UiDecisionFlowOptions<T>,
    ): Promise<T | UiFlowShortcut> {
        if (!this.ctx.hasUI || !this.ctx.ui?.select) return cancel();

        let currentDecision = initialDecision;
        while (currentDecision) {
            const choice = await this.resolveDecision(currentDecision, state, options);
            if (!choice) return cancel();
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
        options: UiDecisionFlowOptions<T>,
    ): Promise<UiSelectDecisionOption<T> | UiFlowShortcut | null> {
        if (options.signal?.aborted) return null;
        const title = parse(decision.title, state);
        const context = decision.context ? parse(decision.context, state) : undefined;

        switch (decision.type) {
            case "select":
                return this.resolveSelectDecision(decision, state, title, context, options);
            case "input":
                return this.resolveInputDecision(decision, state, formatUiDecisionPrompt(title, context), options.signal);
            default:
                throw new Error(`Decision type ${(decision as {type: string}).type} not supported.`);
        }
    }

    private async resolveSelectDecision<T>(
        decision: UiSelectDecision<T>,
        state: Partial<T>,
        title: string,
        context: UiDecisionContext | undefined,
        options: UiDecisionFlowOptions<T>,
    ): Promise<UiSelectDecisionOption<T> | UiFlowShortcut | null> {
        const renderedOptions = decision.options.map((option) => renderOptionTitle(option, state));
        const lookup = Object.fromEntries(renderedOptions.map((renderedTitle, index) => (
            [renderedTitle, decision.options[index]]
        )));

        const choice = options.shortcuts?.enabled && hasShortcutUi(this.ctx)
            ? await shortcutSelect(this.ctx.ui, title, renderedOptions, context, options.signal)
            : await this.ctx.ui!.select(formatUiDecisionPrompt(title, context), renderedOptions, {signal: options.signal});

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
    context: UiDecisionContext | undefined,
    signal?: AbortSignal,
): Promise<string | UiFlowShortcut | undefined> {
    return ui.custom<string | UiFlowShortcut | undefined>((tui, theme, keybindings, done) => {
        return new ShortcutSelectComponent(tui, theme, keybindings, done, title, options, context, signal);
    });
}

class ShortcutSelectComponent implements Component {
    private selected = 0;
    private completed = false;
    private showRequest = false;
    private requestOffset = 0;

    constructor(
        private readonly tui: ShortcutTui,
        private readonly theme: ShortcutTheme,
        private readonly keybindings: ShortcutKeybindings,
        private readonly done: (value: string | UiFlowShortcut | undefined) => void,
        private readonly title: string,
        private readonly options: string[],
        private readonly context: UiDecisionContext | undefined,
        private readonly signal?: AbortSignal,
    ) {
        if (signal?.aborted) queueMicrotask(() => this.complete(undefined));
        else signal?.addEventListener("abort", this.handleAbort, {once: true});
    }

    render(width: number): string[] {
        width = Math.floor(width);
        if (!Number.isFinite(width) || width <= 0) return [];
        const height = Math.max(4, Math.min(28, (this.tui.terminal?.rows ?? 30) - 2));
        const heading = [this.color(ThemeColor.accent, this.bold(decisionDisplayText(this.title)))];
        if (height >= 8) heading.push(this.color(ThemeColor.borderMuted, "─".repeat(width)));
        const lines = this.showRequest
            ? this.renderRequest(width, height, heading)
            : this.renderChoices(width, height, heading);
        return lines.map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        if (this.completed) return;
        if (this.isRight(data)) return this.complete(UiFlowShortcut.ALLOW_ALL_ONCE);
        if (this.isLeft(data)) return this.complete(UiFlowShortcut.DENY_ALL_ONCE);
        if (this.matches(data, "tui.input.tab") || data === "\t") {
            this.showRequest = !this.showRequest;
        } else if (this.isUp(data)) {
            if (this.showRequest) this.requestOffset = Math.max(0, this.requestOffset - 1);
            else this.moveSelection(-1);
        } else if (this.isDown(data)) {
            if (this.showRequest) this.requestOffset++;
            else this.moveSelection(1);
        } else if (this.isEnter(data)) return this.complete(this.options[this.selected]);
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

    private renderChoices(width: number, height: number, heading: string[]): string[] {
        const footer = this.renderHints(width, false, height - heading.length - 2);
        const spacing = height >= 12 ? [""] : [];
        const capacity = height - heading.length - footer.length - spacing.length * 2;
        const fields = this.context?.summary ?? [];
        const ordered = [...fields.filter((field) => field.essential), ...fields.filter((field) => !field.essential)];
        const layout = ordered.map((field) => ({field, lines: this.renderField(field, width, 3)}));
        const criticalSize = layout.filter(({field}) => field.essential).reduce((size, {lines}) => size + lines.length, 0);
        if (criticalSize > capacity - 1) {
            for (const item of layout) {
                if (item.field.essential) item.lines = this.renderField(item.field, width, 1);
            }
        }
        const preview = layout.flatMap(({lines}) => lines);
        const criticalRows = layout.filter(({field}) => field.essential).reduce((size, {lines}) => size + lines.length, 0);
        const preferredSummary = Math.min(preview.length, Math.max(criticalRows, capacity - 6));
        const count = Math.min(this.options.length, 5, Math.max(1, capacity - preferredSummary - 1));
        const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), this.options.length - count));
        const choices = this.options.slice(start, start + count).map((option, offset) => (
            this.renderOption(option, start + offset, width)
        ));
        if (count < this.options.length && capacity - count > preferredSummary) {
            choices.push(this.color(ThemeColor.dim, `  ${this.selected + 1}/${this.options.length} · more choices`));
        }
        const available = Math.max(0, capacity - choices.length);
        const summary = preview.slice(0, available);
        if (preview.length > available && summary.length > 0) {
            summary[summary.length - 1] = truncateToWidth(`${summary[summary.length - 1]} …`, width);
        }
        return [...heading, ...summary, ...spacing, ...choices, ...spacing, ...footer];
    }

    private renderRequest(width: number, height: number, heading: string[]): string[] {
        const footer = this.renderHints(width, true, height - heading.length - 2);
        const spacing = height >= 12 ? [""] : [];
        const fields: UiDecisionField[] = [
            {label: "Selected option", value: this.options[this.selected] ?? ""},
            ...(this.context?.summary ?? []),
            ...(this.context?.details ?? []),
        ];
        const request = fields.flatMap((field) => this.renderField(field, width));
        const available = Math.max(1, height - heading.length - footer.length - spacing.length - 1);
        this.requestOffset = Math.min(this.requestOffset, Math.max(0, request.length - available));
        const visible = request.slice(this.requestOffset, this.requestOffset + available);
        const position = this.color(ThemeColor.dim, `Request lines ${this.requestOffset + 1}–${this.requestOffset + visible.length}/${request.length}`);
        return [...heading, ...visible, position, ...spacing, ...footer];
    }

    private renderField(field: UiDecisionField, width: number, maximum?: number): string[] {
        const label = this.color(ThemeColor.muted, `${decisionDisplayText(field.label)}: `);
        const valueLines = decisionFieldLines(field);
        const lines = valueLines.flatMap((value, index) => (
            wrapTextWithAnsi(`${index === 0 ? label : "  "}${value}`, width)
        ));
        if (maximum === undefined || lines.length <= maximum) return lines;
        return [...lines.slice(0, maximum - 1), truncateToWidth(`${lines[maximum - 1]} …`, width)];
    }

    private renderHints(width: number, request: boolean, maximum: number): string[] {
        const up = this.keyLabel("tui.select.up", "↑");
        const down = this.keyLabel("tui.select.down", "↓");
        const enter = this.keyLabel("tui.select.confirm", "enter");
        const escape = this.keyLabel("tui.select.cancel", "esc");
        const tab = this.keyLabel("tui.input.tab", "tab");
        const left = this.keyLabel("tui.editor.cursorLeft", "←");
        const right = this.keyLabel("tui.editor.cursorRight", "→");
        const movement = `${up}${down} ${request ? "scroll" : `move ${this.selected + 1}/${this.options.length}`}`;
        const navigation = `${movement} · ${enter} select · ${escape} cancel`;
        const review = `${tab} ${request ? "choices" : "full request"}`;
        const fullShortcuts = `${left} deny once · ${right} allow once`;
        const shortcuts = displayWidth(fullShortcuts) <= width ? fullShortcuts : `Once ${left}:deny ${right}:allow`;
        const hints = width >= 60 ? [navigation, `${review} · ${shortcuts}`]
            : [`${movement} · ${enter} select`, `${escape} cancel · ${tab} ${request ? "choices" : "request"}`, shortcuts];
        const bounded = hints.length <= maximum ? hints
            : maximum >= 2 ? [navigation, `${review} · ${shortcuts}`]
                : [`${review} · ${escape} cancel`];
        return bounded.map((hint) => this.color(ThemeColor.dim, hint));
    }

    private keyLabel(action: string, fallback: string): string {
        const key = this.keybindings.getKeys?.(action)?.[0] ?? fallback;
        const labels: Record<string, string> = {up: "↑", down: "↓", left: "←", right: "→", escape: "esc"};
        return labels[key] ?? decisionDisplayText(key);
    }

    private renderOption(option: string, index: number, width: number): string {
        const prefix = index === this.selected ? "› " : "  ";
        const line = truncateToWidth(`${prefix}${decisionDisplayText(option)}`, width);
        if (index !== this.selected) return line;
        const padded = `${line}${" ".repeat(Math.max(0, width - displayWidth(line)))}`;
        return this.bg("selectedBg", this.color(ThemeColor.accent, padded));
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
