import type {
    ExtensionUIContext,
    KeybindingsManager,
    Theme,
} from "@earendil-works/pi-coding-agent";
import {truncateToWidth, type Component} from "@earendil-works/pi-tui";

export type BoundedListItem<T> = {
    value: T;
    label: string;
};

export type BoundedListOptions<T> = {
    title: string;
    items: BoundedListItem<T>[];
    onActivate: (item: BoundedListItem<T>, index: number) => void;
    initialIndex?: number;
    radius?: number;
    hint?: string;
};

type BoundedListComponentOptions<T> = BoundedListOptions<T> & {
    theme: Theme;
    keybindings: KeybindingsManager;
    onCancel: () => void;
};

export function showBoundedList<T>(
    ui: ExtensionUIContext,
    options: BoundedListOptions<T>,
): Promise<void> {
    return ui.custom<void>((_tui, theme, keybindings, done) => new BoundedListComponent({
        ...options,
        theme,
        keybindings,
        onCancel: () => done(),
    }));
}

export class BoundedListComponent<T> implements Component {
    private readonly title: string;
    private readonly items: BoundedListItem<T>[];
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly onActivate: (item: BoundedListItem<T>, index: number) => void;
    private readonly onCancel: () => void;
    private readonly radius: number;
    private readonly hint: string;
    private selectedIndex: number;

    constructor(options: BoundedListComponentOptions<T>) {
        this.title = options.title;
        this.items = options.items;
        this.theme = options.theme;
        this.keybindings = options.keybindings;
        this.onActivate = options.onActivate;
        this.onCancel = options.onCancel;
        this.radius = Math.max(0, Math.floor(options.radius ?? 5));
        this.hint = options.hint ?? "↑↓ navigate • enter select • esc close";
        this.selectedIndex = clamp(options.initialIndex ?? 0, 0, Math.max(0, this.items.length - 1));
    }

    render(width: number): string[] {
        const start = Math.max(0, this.selectedIndex - this.radius);
        const end = Math.min(this.items.length, this.selectedIndex + this.radius + 1);
        const rows = this.items.slice(start, end).map((item, offset) => {
            const selected = start + offset === this.selectedIndex;
            const line = `${selected ? "→" : " "} ${item.label}`;
            return selected ? this.theme.fg("accent", line) : line;
        });
        return [
            this.theme.fg("accent", this.theme.bold(this.title)),
            "",
            ...rows,
            this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.items.length})`),
            "",
            this.theme.fg("dim", this.hint),
        ].map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        if (this.keybindings.matches(data, "tui.select.up")) {
            if (this.selectedIndex > 0) this.selectedIndex--;
        } else if (this.keybindings.matches(data, "tui.select.down")) {
            if (this.selectedIndex < this.items.length - 1) this.selectedIndex++;
        } else if (this.keybindings.matches(data, "tui.select.confirm")) {
            const item = this.items[this.selectedIndex];
            if (item) this.onActivate(item, this.selectedIndex);
        } else if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onCancel();
        }
    }

    invalidate(): void {
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(value, maximum));
}
