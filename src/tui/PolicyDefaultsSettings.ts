import {DynamicBorder, getSettingsListTheme, type Theme} from "@earendil-works/pi-coding-agent";
import {Container, SettingsList, Text, type SettingItem} from "@earendil-works/pi-tui";
import PolicyRuntime from "../policy/PolicyRuntime.js";
import {PolicyArea, PolicyFallbackResponse} from "../policy/types.js";
import {SettingsChoice} from "./SettingsChoice.js";
import {truncateToWidth} from "./terminalText.js";

const RESPONSES: Record<PolicyFallbackResponse, string> = {
    allow: "Allow unmatched operations",
    deny: "Deny unmatched operations",
    ask_user: "Ask you for approval",
    ask_llm: "Ask the policy-review model",
};

export class PolicyDefaultsSettings extends Container {
    readonly capturesViewportInput = true;
    private readonly settings: SettingsList;

    constructor(
        runtime: PolicyRuntime,
        theme: Theme,
        onClose: () => void,
        private readonly requestRender: () => void,
        notify: (message: string, type: "info" | "error") => void,
    ) {
        super();
        const areas = Object.values(PolicyArea);
        const items: SettingItem[] = areas.map((area) => ({
            id: area,
            label: area,
            currentValue: runtime.defaultResponses[area],
            description: "Fallback for unmatched operations only; explicit rules still take precedence.",
            submenu: (current, done) => new SettingsChoice(Object.values(PolicyFallbackResponse).map((response) => ({
                value: response, label: response, description: RESPONSES[response],
            })), current, done),
        }));
        items.push(
            {id: "save", label: "Save defaults", currentValue: "save", values: ["save"], description: "Persist current defaults for future sessions."},
            {id: "reset", label: "Reload saved defaults", currentValue: "reload", values: ["reload"], description: "Reload saved defaults, or built-ins if none exist. Does not clear explicit rules."},
        );
        this.settings = new SettingsList(items, 12, getSettingsListTheme(), (id, value) => {
            try {
                if (id === "save") {
                    runtime.saveDefaultResponses();
                    notify("Saved current policy defaults to ~/.pilot/policy-defaults.json.", "info");
                } else if (id === "reset") {
                    runtime.resetDefaultResponses();
                    for (const area of areas) this.settings.updateValue(area, runtime.defaultResponses[area]);
                    notify("Reset policy defaults.", "info");
                } else {
                    const area = areas.find((area) => area === id);
                    const response = Object.values(PolicyFallbackResponse).find((response) => response === value);
                    if (area && response) runtime.setDefaultResponse(area, response);
                }
            } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
            }
            this.requestRender();
        }, onClose);
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
        this.addChild(new Text(theme.fg("accent", theme.bold("Policy defaults")), 1, 0));
        this.addChild(new Text(theme.fg("muted", "Changes apply to this session immediately; save explicitly to persist."), 1, 0));
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
