import {DynamicBorder, getSettingsListTheme, type Theme} from "@earendil-works/pi-coding-agent";
import {Container, SettingsList, Text, type SettingItem} from "@earendil-works/pi-tui";
import type {PilotSessionRuntimeInterface} from "../runtime/PilotSessionRuntime.js";
import {truncateToWidth} from "./terminalText.js";

export type SandboxingSetting = "network-inspection" | "mmap";

/** Uses the same switch list as Pi's /settings; changes apply immediately. */
export class SandboxingSettings extends Container {
    readonly capturesViewportInput = true;
    private readonly settings: SettingsList;

    constructor(
        runtime: PilotSessionRuntimeInterface,
        theme: Theme,
        onChange: (setting: SandboxingSetting, enabled: boolean) => void,
        onClose: () => void,
        private readonly requestRender: () => void,
    ) {
        super();
        const items: SettingItem[] = [
            {
                id: "network-inspection",
                label: "Network inspection",
                description: "On by default. Off keeps HTTPS end-to-end: opaque traffic has transport-only policy; recognized plaintext protocols still receive checks. Does not disable the network sandbox.",
                currentValue: runtime.fullNetworkInspection ? "on" : "off",
                values: ["on", "off"],
            },
            {
                id: "mmap",
                label: "Writable mmap",
                description: "Off by default. On enables cached write-through for build/linker compatibility. Opens and backing I/O still check filesystem policy, but memory stores cannot be individually checked or revoked. Revocation/cancellation can lose dirty changes; errors can be delayed. Host/cross-call SQLite WAL is unsupported.",
                currentValue: runtime.writableMmap ? "on" : "off",
                values: ["off", "on"],
            },
        ];
        this.settings = new SettingsList(items, items.length, getSettingsListTheme(), (id, value) => {
            if (id === "network-inspection" || id === "mmap") onChange(id, value === "on");
            this.requestRender();
        }, onClose);
        this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
        this.addChild(new Text(theme.fg("accent", theme.bold("Sandboxing")), 1, 0));
        this.addChild(new Text(theme.fg("muted", "Session only · never saved · applies to new Bash calls, including subagents"), 1, 0));
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
