import fs from "node:fs";
import path from "node:path";

export class JsonDefaultsFile<T> {
    constructor(
        private readonly file: string,
        private readonly label: string,
        private readonly decode: (value: unknown) => T,
        private readonly absentValue: () => T,
    ) {
    }

    load(): T {
        let contents: string;
        try {
            contents = fs.readFileSync(this.file, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") return this.absentValue();
            throw new Error(`Unable to read ${this.label} from ${this.file}.`, {cause: error});
        }

        try {
            return this.decode(JSON.parse(contents));
        } catch (error) {
            throw new Error(`Invalid ${this.label} in ${this.file}.`, {cause: error});
        }
    }

    save(value: T): void {
        fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
        try {
            fs.writeFileSync(this.file, `${JSON.stringify(value, null, 2)}\n`, {
                encoding: "utf8",
                flag: "w",
                mode: 0o600,
            });
        } catch (error) {
            throw new Error(`Unable to save ${this.label} to ${this.file}.`, {cause: error});
        }
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
