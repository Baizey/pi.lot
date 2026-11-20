import {getSelectListTheme, type ExtensionUIContext, type KeybindingsManager} from "@earendil-works/pi-coding-agent";
import {Container, Input, SelectList, Text, fuzzyFilter, getKeybindings, truncateToWidth,
    type Focusable, type SelectItem} from "@earendil-works/pi-tui";

interface ChoiceItem extends SelectItem {
    action?: boolean;
}

interface ChoiceOptions {
    searchable?: boolean;
    inline?: {
        heading: string;
        hint: string;
        keybindings: KeybindingsManager;
        requestRender: () => void;
        toggleTools: () => void;
    };
}

export function chooseFromCatalog(ui: ExtensionUIContext, title: string, items: ChoiceItem[], current: string): Promise<string | undefined> {
    return ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        const confirm = keybindings.getKeys("tui.select.confirm").join("/");
        const cancel = keybindings.getKeys("tui.select.cancel").join("/");
        const hint = ["↑↓ navigate", confirm && `${confirm} select`, cancel && `${cancel} cancel`].filter(Boolean).join(" · ");
        return new SettingsChoice(items, current, done, {
            searchable: true,
            inline: {
                heading: theme.fg("accent", theme.bold(title)),
                hint: theme.fg("dim", hint),
                keybindings,
                requestRender: () => tui.requestRender(),
                toggleTools: () => ui.setToolsExpanded(!ui.getToolsExpanded()),
            },
        });
    }, {blocked: {kind: "question", message: `Select ${title.toLowerCase()}`}});
}

/** Native selection controls for settings submenus and standalone catalogs. */
export class SettingsChoice extends Container implements Focusable {
    readonly capturesViewportInput = true;
    private list: SelectList;
    private readonly search: Input | undefined;
    private readonly listIndex: number;

    constructor(
        private readonly items: ChoiceItem[],
        private readonly current: string,
        private readonly done: (value?: string) => void,
        private readonly options: ChoiceOptions = {},
    ) {
        super();
        if (options.inline) this.addChild(new Text(options.inline.heading, 0, 0));
        if (options.searchable) {
            this.search = new Input({placeholder: "Type to filter"});
            // A settings submenu owns input while visible, but SettingsList does not forward focus.
            this.search.focused = !options.inline;
            this.addChild(this.search);
        }
        this.listIndex = this.children.length;
        this.list = this.createList(items, current);
        this.addChild(this.list);
        if (options.inline) this.addChild(new Text(options.inline.hint, 0, 0));
    }

    get focused(): boolean { return this.search?.focused ?? false; }
    set focused(value: boolean) { if (this.search) this.search.focused = value; }

    override render(width: number): string[] {
        return super.render(width).map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        const inline = this.options.inline;
        const keys = inline?.keybindings ?? getKeybindings();
        if (inline?.keybindings.matches(data, "app.tools.expand")) {
            inline.toggleTools();
        } else if (inline && data === "\n" && keys.getKeys("tui.select.confirm").includes("enter")) {
            // Preserve the built-in dialog's raw LF support, but honor remapped confirmation.
            const selected = this.list.getSelectedItem();
            if (selected) this.done(selected.value);
        } else if (!this.search || (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown",
            "tui.select.confirm", "tui.select.cancel"] as const).some((action) => keys.matches(data, action))) {
            this.list.handleInput(data);
        } else {
            const previous = this.search.getValue();
            this.search.handleInput(data);
            const query = this.search.getValue();
            if (query !== previous) {
                const filtered = fuzzyFilter(this.items, query, (item) => item.description
                    ? `${item.label} ${item.description}` : item.label);
                this.list = this.createList(filtered, query.trim() ? undefined : this.current);
                this.children[this.listIndex] = this.list;
            }
        }
        inline?.requestRender();
    }

    private createList(items: ChoiceItem[], current?: string): SelectList {
        const theme = getSelectListTheme();
        const displayed = this.options.inline ? items.map((item) => {
            const prefix = item.value === this.current ? "✓ " : item.action ? "· " : "";
            return prefix ? {...item, label: `${prefix}${item.label}`} : item;
        }) : items;
        const list = new SelectList(displayed, Math.min(Math.max(items.length, 1), 10),
            {...theme, noMatch: () => theme.noMatch("  No matches")});
        const selected = items.findIndex((item) => item.value === current);
        if (selected >= 0) list.setSelectedIndex(selected);
        list.onSelect = (item) => this.done(item.value);
        list.onCancel = () => this.done();
        return list;
    }
}
