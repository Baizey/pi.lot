import os from "node:os";
import path from "node:path";
import {JsonDefaultsFile} from "../../storage/JsonDefaultsFile.js";
import {ToolDisplayMode, type ToolDisplayViews} from "./ToolDisplayMode.js";
import {ToolDisplayModes} from "./ToolDisplayModes.js";

export const initialDisplayDefaults: Readonly<ToolDisplayViews> = Object.freeze({
    normal: ToolDisplayMode.MINIMAL,
    alternate: ToolDisplayMode.TRUNCATED,
});

export interface DisplayDefaultsStore {
    load(): ToolDisplayViews;
    save(views: ToolDisplayViews): void;
}

export class DisplayDefaultsJsonStore implements DisplayDefaultsStore {
    readonly file: string;
    private readonly defaultsFile: JsonDefaultsFile<ToolDisplayViews>;

    constructor(filename = "display-defaults", directory = path.join(os.homedir(), ".pilot")) {
        this.file = path.join(directory, `${filename}.json`);
        this.defaultsFile = new JsonDefaultsFile(
            this.file, "display defaults", parseDefaults, () => ({...initialDisplayDefaults}),
        );
    }

    load(): ToolDisplayViews {
        return this.defaultsFile.load();
    }

    save(views: ToolDisplayViews): void {
        this.defaultsFile.save(views);
    }
}

/** Persistence for the shared mode pair, never for Pi's active toggle position. */
export class DisplayDefaultsRuntime {
    constructor(
        private readonly modes: ToolDisplayModes,
        private readonly store: DisplayDefaultsStore = new DisplayDefaultsJsonStore(),
    ) {
        this.reset();
    }

    get values(): ToolDisplayViews {
        return this.modes.values;
    }

    setViews(normal: ToolDisplayMode, alternate: ToolDisplayMode): void {
        this.modes.setViews(normal, alternate);
    }

    save(): void {
        this.store.save(this.values);
    }

    reset(): void {
        const views = this.store.load();
        this.setViews(views.normal, views.alternate);
    }
}

function parseDefaults(value: unknown): ToolDisplayViews {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("defaults must be an object");
    }
    const defaults = value as Record<string, unknown>;
    const unexpected = Object.keys(defaults).filter((key) => key !== "normal" && key !== "alternate");
    if (unexpected.length > 0) {
        throw new Error(`defaults contain unsupported keys: ${unexpected.join(", ")}`);
    }
    return {normal: displayMode(defaults.normal, "normal"), alternate: displayMode(defaults.alternate, "alternate")};
}

function displayMode(value: unknown, slot: string): ToolDisplayMode {
    for (const mode of Object.values(ToolDisplayMode)) {
        if (value === mode) return mode;
    }
    throw new Error(`${slot} must be a supported display mode`);
}
