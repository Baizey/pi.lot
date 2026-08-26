import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {SubagentReasoningSkill} from "./SubagentReasoning.js";

export const AUTO_SUBAGENT_MODEL = "auto";
export type SubagentModelPreference = typeof AUTO_SUBAGENT_MODEL | string;
export type SubagentDefaultValues = Record<SubagentReasoningSkill, SubagentModelPreference>;

export const initialSubagentDefaults: Readonly<SubagentDefaultValues> = Object.freeze({
    min: AUTO_SUBAGENT_MODEL,
    low: AUTO_SUBAGENT_MODEL,
    mid: AUTO_SUBAGENT_MODEL,
    high: AUTO_SUBAGENT_MODEL,
    max: AUTO_SUBAGENT_MODEL,
});

export interface SubagentDefaultsStore {
    load(): SubagentDefaultValues;
    save(defaults: SubagentDefaultValues): void;
}

export class SubagentDefaultsJsonStore implements SubagentDefaultsStore {
    readonly file: string;

    constructor(
        filename = "subagent-defaults",
        directory = path.join(os.homedir(), ".pilot"),
    ) {
        this.file = path.join(directory, `${filename}.json`);
    }

    load(): SubagentDefaultValues {
        let contents: string;
        try {
            contents = fs.readFileSync(this.file, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return {...initialSubagentDefaults};
            throw new Error(`Unable to read subagent defaults from ${this.file}.`, {cause: error});
        }

        try {
            return parseDefaults(JSON.parse(contents));
        } catch (error) {
            throw new Error(`Invalid subagent defaults in ${this.file}.`, {cause: error});
        }
    }

    save(defaults: SubagentDefaultValues): void {
        fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
        try {
            fs.writeFileSync(this.file, `${JSON.stringify(defaults, null, 2)}\n`, {
                encoding: "utf8",
                flag: "w",
                mode: 0o600,
            });
        } catch (error) {
            throw new Error(`Unable to save subagent defaults to ${this.file}.`, {cause: error});
        }
    }
}

export class SubagentDefaultsRuntime {
    readonly values: SubagentDefaultValues;

    constructor(private readonly store: SubagentDefaultsStore = new SubagentDefaultsJsonStore()) {
        this.values = store.load();
    }

    set(skill: SubagentReasoningSkill, model: SubagentModelPreference): void {
        this.values[skill] = model;
    }

    save(): void {
        this.store.save(this.values);
    }

    reset(): void {
        Object.assign(this.values, this.store.load());
    }
}

function parseDefaults(value: unknown): SubagentDefaultValues {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("defaults must be an object");
    }
    const defaults = value as Record<string, unknown>;
    const skills = Object.values(SubagentReasoningSkill);
    const supportedKeys = new Set<string>(skills);
    const unexpected = Object.keys(defaults).filter((key) => !supportedKeys.has(key));
    if (unexpected.length > 0) {
        throw new Error(`defaults contain unsupported keys: ${unexpected.join(", ")}`);
    }
    return Object.fromEntries(skills.map((skill) => [
        skill,
        modelPreference(defaults[skill], skill),
    ])) as SubagentDefaultValues;
}

function modelPreference(value: unknown, skill: SubagentReasoningSkill): SubagentModelPreference {
    if (typeof value !== "string" || !value.trim() || /\s/.test(value)) {
        throw new Error(`${skill} must be auto or a canonical provider/model`);
    }
    const normalized = value.trim();
    if (normalized !== AUTO_SUBAGENT_MODEL && !normalized.includes("/")) {
        throw new Error(`${skill} must be auto or a canonical provider/model`);
    }
    return normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
