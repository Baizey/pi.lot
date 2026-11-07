import {getSelectListTheme} from "@earendil-works/pi-coding-agent";
import {Container, Input, SelectList, fuzzyFilter, getKeybindings, type SelectItem} from "@earendil-works/pi-tui";

/** Native selection controls for settings submenus, optionally searchable. */
export class SettingsChoice extends Container {
    private list: SelectList;
    private readonly search: Input | undefined;
    private readonly listIndex: number;

    constructor(
        private readonly items: SelectItem[],
        current: string,
        private readonly done: (value?: string) => void,
        searchable = false,
    ) {
        super();
        if (searchable) {
            this.search = new Input();
            // This submenu owns keyboard input while visible; SettingsList does
            // not forward focus to a nested search input.
            this.search.focused = true;
            this.search.onSubmit = () => this.list.handleInput("\r");
            this.addChild(this.search);
        }
        this.listIndex = this.children.length;
        this.list = this.createList(items, current);
        this.addChild(this.list);
    }

    handleInput(data: string): void {
        const keys = getKeybindings();
        if (!this.search || (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown",
            "tui.select.confirm", "tui.select.cancel"] as const).some((action) => keys.matches(data, action))) {
            this.list.handleInput(data);
            return;
        }
        this.search.handleInput(data);
        const filtered = fuzzyFilter(this.items, this.search.getValue(), (item) => `${item.label} ${item.description ?? ""}`);
        this.list = this.createList(filtered);
        this.children[this.listIndex] = this.list;
    }

    private createList(items: SelectItem[], current?: string): SelectList {
        const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), getSelectListTheme());
        const selected = items.findIndex((item) => item.value === current);
        if (selected >= 0) list.setSelectedIndex(selected);
        list.onSelect = (item) => this.done(item.value);
        list.onCancel = () => this.done();
        return list;
    }
}
