import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface JsonFileLoaderInterface<T> {
    load(): T;

    save(defaults: T): void;
}

export class JsonFileLoader<T> implements JsonFileLoaderInterface<T> {
    readonly file: string;
    private readonly defaultValue: T;

    constructor(
        filename: string,
        defaultValue: T,
        directory = path.join(os.homedir(), ".pilot")
    ) {
        this.defaultValue = Object.freeze(defaultValue);
        this.file = path.join(directory, filename + ".json");
    }

    load(): T {
        let contents: string;
        try {
            contents = fs.readFileSync(this.file, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return this.defaultValue;
            throw new Error(`Unable to read policy defaults from ${this.file}.`, {cause: error});
        }

        try {
            return JSON.parse(contents) as T;
        } catch (error) {
            throw new Error(`Invalid policy defaults in ${this.file}.`, {cause: error});
        }
    }

    save(value: T): void {
        const directory = path.dirname(this.file);
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        try {
            fs.writeFileSync(this.file, `${JSON.stringify(value, null, 2)}\n`, {
                encoding: "utf8",
                flag: "w",
                mode: 0o600,
            });
        } catch (error) {
            throw new Error(`Unable to save policy defaults to ${this.file}.`, {cause: error});
        }
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
