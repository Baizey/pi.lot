import {DynamicBorder, getSelectListTheme, getSettingsListTheme, type Theme} from "@earendil-works/pi-coding-agent";
import {Container, SelectList, SettingsList, Text, type Component, type SettingItem} from "@earendil-works/pi-tui";
import {truncateToWidth} from "../terminalText.js";
import {DisplayDefaultsRuntime} from "./DisplayDefaults.js";
import {displayModeChoices, displayModeTitle, parseDisplayMode} from "./DisplayModeChoice.js";
import type {ToolDisplayViews} from "./ToolDisplayMode.js";

/** Two stable slots; selecting a mode replaces its meaning without toggling Pi's view. */
export class DisplaySettings extends Container {
    private readonly settings: SettingsList;

    constructor(
        defaults: DisplayDefaultsRuntime,
        theme: Theme,
        onClose: () => void,
        private readonly requestRender: () => void,
        notify: (message: string, type: "info" | "error") => void,
    ) {
        super();
        const views = defaults.values;
        const items = (["normal", "alternate"] as const).map((slot): SettingItem => ({
            id: slot,
            label: slot === "normal" ? "Normal view" : "Alternate view",
            currentValue: displayModeTitle(views[slot]),
            submenu: (current, done) => this.modePicker(current, done),
        }));
        items.push(
            {id: "save", label: "Save defaults", currentValue: "save", values: ["save"], description: "Persist current views for future sessions."},
            {id: "reset", label: "Reload saved defaults", currentValue: "reload", values: ["reload"], description: "Reload saved views, or built-ins if none exist."},
        );
        this.settings = new SettingsList(items, items.length, getSettingsListTheme(), (id, value) => {
            try {
                if (id === "save") {
                    defaults.save();
                    notify("Saved current display defaults to ~/.pilot/display-defaults.json.", "info");
                } else if (id === "reset") {
                    defaults.reset();
                    for (const slot of ["normal", "alternate"] as const) {
                        this.settings.updateValue(slot, displayModeTitle(defaults.values[slot]));
                    }
                    notify("Reset display defaults from saved preferences.", "info");
                } else {
                    const mode = parseDisplayMode(value)!;
                    const views: ToolDisplayViews = {...defaults.values, [id]: mode};
                    defaults.setViews(views.normal, views.alternate);
                }
            } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
            }
        }, onClose);
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
        this.addChild(new Text(theme.fg("accent", theme.bold("Display")), 1, 0));
        this.addChild(new Text(theme.fg("muted", "Changes apply immediately; save explicitly to persist."), 1, 0));
        this.addChild(this.settings);
        this.addChild(new Text(theme.fg("dim", "/display save · /display reset"), 1, 0));
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    }

    override render(width: number): string[] {
        // Native SelectList reserves a two-column prefix even on a one-column terminal.
        return super.render(width).map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        this.settings.handleInput(data);
        this.requestRender();
    }

    private modePicker(current: string, done: (value?: string) => void): Component {
        const items = displayModeChoices.map((choice) => ({value: choice.title, label: choice.title}));
        const list = new SelectList(items, items.length, getSelectListTheme());
        list.setSelectedIndex(items.findIndex((item) => item.value === current));
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done();
        return list;
    }
}
