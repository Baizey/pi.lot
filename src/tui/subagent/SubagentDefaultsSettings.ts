import {DynamicBorder, getSettingsListTheme, type Theme} from "@earendil-works/pi-coding-agent";
import {Container, SettingsList, Text, type SettingItem} from "@earendil-works/pi-tui";
import {AUTO_SUBAGENT_MODEL, SubagentDefaultsRuntime} from "../../subagents/SubagentDefaults.js";
import {SubagentReasoningSkill} from "../../subagents/SubagentReasoning.js";
import {SettingsChoice} from "../SettingsChoice.js";
import {truncateToWidth} from "../terminalText.js";

export class SubagentDefaultsSettings extends Container {
    readonly capturesViewportInput = true;
    private readonly settings: SettingsList;

    constructor(
        defaults: SubagentDefaultsRuntime,
        availableModels: () => readonly string[],
        automaticModels: Readonly<Record<SubagentReasoningSkill, string>>,
        theme: Theme,
        onClose: () => void,
        private readonly requestRender: () => void,
        notify: (message: string, type: "info" | "error") => void,
    ) {
        super();
        const skills = Object.values(SubagentReasoningSkill);
        const items: SettingItem[] = skills.map((skill) => ({
            id: skill,
            label: skill,
            currentValue: defaults.values[skill],
            description: `Automatic selection: ${automaticModels[skill]}. Changes affect newly accepted jobs, not running jobs.`,
            submenu: (current, done) => {
                const models = [...new Set(availableModels())];
                const options = [
                    {value: AUTO_SUBAGENT_MODEL, label: "auto", description: automaticModels[skill]},
                    ...models.map((model) => ({value: model, label: model, description: "Authenticated model"})),
                ];
                // Do not silently replace an unavailable saved preference just by opening the picker.
                if (current !== AUTO_SUBAGENT_MODEL && !models.includes(current)) {
                    options.push({value: current, label: current, description: "Current preference (unavailable); runtime falls back to auto"});
                }
                return new SettingsChoice(options, current, done, true);
            },
        }));
        items.push(
            {id: "save", label: "Save defaults", currentValue: "save", values: ["save"], description: "Persist current model mappings for future sessions."},
            {id: "reset", label: "Reload saved defaults", currentValue: "reload", values: ["reload"], description: "Reload saved mappings, or automatic selection if none exist."},
        );
        this.settings = new SettingsList(items, items.length, getSettingsListTheme(), (id, value) => {
            try {
                if (id === "save") {
                    defaults.save();
                    notify("Saved current subagent defaults to ~/.pilot/subagent-defaults.json.", "info");
                } else if (id === "reset") {
                    defaults.reset();
                    for (const skill of skills) this.settings.updateValue(skill, defaults.values[skill]);
                    notify("Reset subagent defaults.", "info");
                } else {
                    const skill = skills.find((skill) => skill === id);
                    if (skill) defaults.set(skill, value);
                }
            } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
            }
            this.requestRender();
        }, onClose);
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
        this.addChild(new Text(theme.fg("accent", theme.bold("Subagent defaults")), 1, 0));
        this.addChild(new Text(theme.fg("muted", "Choose a skill, then search models. Session changes persist only when saved."), 1, 0));
        this.addChild(this.settings);
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    }

    override render(width: number): string[] {
        return super.render(width).map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        this.settings.handleInput(data);
        this.requestRender();
    }
}
