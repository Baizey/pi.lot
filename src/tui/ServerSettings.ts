import {DynamicBorder, getSettingsListTheme, type Theme} from "@earendil-works/pi-coding-agent";
import {Container, SettingsList, Text, type SettingItem} from "@earendil-works/pi-tui";
import {CONFIG_KEYS, type ConfigKey} from "../server/config-sync/ConfigSyncProtocol.js";
import {SettingsChoice} from "./SettingsChoice.js";
import {truncateToWidth} from "./terminalText.js";

type RecoverableKey = Exclude<ConfigKey, "global-policies">;
export type ServerSettingsAction = "status" | "login" | "logout" | "upload current" | "upload all"
    | "sync" | "sync on" | "sync off" | `sync recover ${RecoverableKey} ${"local" | "server"}`;

/** Selecting an action closes this screen before input dialogs or network work begin. */
export class ServerSettings extends Container {
    readonly capturesViewportInput = true;
    private readonly settings: SettingsList;

    constructor(
        url: string | undefined,
        theme: Theme,
        onAction: (action: ServerSettingsAction) => void,
        onClose: () => void,
        private readonly requestRender: () => void,
    ) {
        super();
        const syncOptions: Array<{value: "sync" | "sync on" | "sync off"; label: string; description: string}> = [
            {value: "sync", label: "Sync now", description: "One foreground pass over saved settings and GLOBAL rules; includes saved web-search keys."},
            {value: "sync on", label: "Enable startup sync", description: "Sync now and persist opt-in for startup checks on this server binding; includes saved web-search keys."},
            {value: "sync off", label: "Disable startup sync", description: "Disable automatic checks on this computer. Session archival is unchanged."},
        ];
        const items: SettingItem[] = [
            {id: "status", label: "Check connection", currentValue: "check", values: ["check"], description: "Check server compatibility and display the saved URL and API key locally. Do not share unredacted output."},
            {id: "login", label: url ? "Replace connection" : "Configure connection", currentValue: "login", values: ["login"], description: "Enter URL and API key in dialogs. Saving enables automatic publication of complete session histories, which can include secrets."},
            {id: "logout", label: "Remove connection", currentValue: "logout", values: ["logout"], description: "Remove local authorization. Does not revoke the remote API key or delete local archives."},
            {
                id: "upload", label: "Upload sessions", currentValue: "choose scope",
                description: "Queue complete native histories for background upload, including reasoning, tool output and possible secrets. Queued does not mean uploaded.",
                submenu: (current, done) => new SettingsChoice([
                    {value: "upload current", label: "Current session family", description: "Queue the current persistent session and its discoverable children."},
                    {value: "upload all", label: "All persisted sessions", description: "Explicitly queue all discoverable persisted history."},
                ], current, done),
            },
            {
                id: "sync", label: "Configuration sync", currentValue: "choose action",
                description: "Saved configuration and GLOBAL rules only. Includes web-search keys; connection credentials and live session overrides are not synchronized.",
                submenu: (current, done) => new SettingsChoice(syncOptions, current, done),
            },
            {
                id: "recover", label: "Recover interrupted sync", currentValue: "choose item",
                description: "Explicit recovery for an interrupted JSON configuration application; choose the item and which side to keep.",
                submenu: (_current, done) => this.recoveryPicker(onAction, () => done()),
            },
        ];
        this.settings = new SettingsList(items, items.length, getSettingsListTheme(), (id, value) => {
            if (id === "status" || id === "login" || id === "logout") onAction(id);
            else if (id === "upload" && (value === "upload current" || value === "upload all")) onAction(value);
            else if (id === "sync") {
                const action = syncOptions.find((option) => option.value === value);
                if (action) onAction(action.value);
            }
        }, onClose);
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
        this.addChild(new Text(theme.fg("accent", theme.bold("pi.server")), 1, 0));
        this.addChild(new Text(theme.fg("muted", url ?? "Not configured"), 1, 0));
        this.addChild(new Text(theme.fg("muted", "Connection and sync choices persist on this computer; opening this menu sends nothing."), 1, 0));
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

    private recoveryPicker(onAction: (action: ServerSettingsAction) => void, onCancel: () => void): SettingsList {
        const keys = CONFIG_KEYS.filter((key): key is RecoverableKey => key !== "global-policies");
        return new SettingsList(keys.map((key) => ({
            id: key, label: key, currentValue: "choose side",
            submenu: (current, done) => new SettingsChoice([
                {value: "local", label: "Keep local", description: "Reconcile the interrupted exchange and submit the selected local file."},
                {value: "server", label: "Use server", description: "Apply the server's configuration to the saved local file."},
            ], current, done),
        })), keys.length, getSettingsListTheme(), (id, value) => {
            const key = keys.find((key) => key === id);
            if (key && (value === "local" || value === "server")) onAction(`sync recover ${key} ${value}`);
        }, onCancel);
    }
}
