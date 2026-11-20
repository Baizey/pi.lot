import {randomUUID} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {ArchiveLock, ensurePrivateDirectory, syncDirectory} from "../server/ArchiveLock.js";
import {isPersonaId, MAX_PERSONA_CATALOG_BYTES, parsePersonaCatalog, type PersonaCatalog} from "./PersonaCatalog.js";

export function withPersonaCatalogLock<T>(directory: string, operation: () => T): T {
    const lock = new ArchiveLock(path.join(directory, "personas.lock"));
    if (!lock.acquire(250)) throw new Error("The persona library is busy. Try again.");
    try {
        return operation();
    } finally {
        lock.release();
    }
}

export class PersonaStore {
    constructor(private readonly directory = path.join(os.homedir(), ".pilot")) {}

    catalog(): PersonaCatalog {
        const file = path.join(this.directory, "personas.json");
        const value = readJson(file, MAX_PERSONA_CATALOG_BYTES);
        return value === undefined ? {personas: []} : parsePersonaCatalog(value);
    }

    /** Check the expected snapshot under the lock so a concurrent save cannot be overwritten. */
    saveCatalog(expected: PersonaCatalog, replacement: PersonaCatalog): void {
        const next = encodeCatalog(parsePersonaCatalog(replacement));
        if (Buffer.byteLength(next) > MAX_PERSONA_CATALOG_BYTES) throw new Error("The persona library is too large.");
        withPersonaCatalogLock(this.directory, () => {
            if (encodeCatalog(this.catalog()) !== encodeCatalog(expected)) {
                throw new Error("The persona library changed. Review the change and try again.");
            }
            writeJson(this.directory, "personas.json", next);
        });
    }

    defaultId(): string | null {
        const file = path.join(this.directory, "persona-default.json");
        const value = readJson(file, 1024);
        if (value === undefined) return null;
        if (typeof value === "object" && value !== null && Object.keys(value).length === 1 && "id" in value
            && (value.id === null || isPersonaId(value.id))) return value.id;
        throw new Error("Invalid saved persona default.");
    }

    saveDefault(id: string | null): void {
        if (id !== null && !isPersonaId(id)) throw new Error("Invalid persona ID.");
        ensurePrivateDirectory(this.directory);
        writeJson(this.directory, "persona-default.json", JSON.stringify({id}));
    }
}

function encodeCatalog({personas}: PersonaCatalog): string {
    return JSON.stringify({personas: [...personas].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)});
}

function readJson(file: string, maxBytes: number): unknown {
    let descriptor: number;
    try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw new Error(`Unable to read ${path.basename(file)}.`, {cause: error});
    }
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > maxBytes) throw new Error("Not a bounded regular file.");
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            if (read === 0) break;
            length += read;
        }
        if (length > maxBytes) throw new Error("File is too large.");
        return JSON.parse(new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, length)));
    } catch (error) {
        throw new Error(`Invalid ${path.basename(file)}.`, {cause: error});
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeJson(directory: string, filename: string, json: string): void {
    const file = path.join(directory, filename);
    const temporary = path.join(directory, `.persona-${randomUUID()}.tmp`);
    let written = false;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
        try {
            fs.writeFileSync(descriptor, json, "utf8");
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, file);
        written = true;
        syncDirectory(directory);
    } finally {
        if (!written) fs.unlinkSync(temporary);
    }
}
