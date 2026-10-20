import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

/** A stable inode and an inherited open-file description, never a PID/mtime lease. */
export class ArchiveLock {
    private descriptor: number | undefined;

    constructor(readonly file: string) {}

    acquire(waitMilliseconds = 0): boolean {
        if (this.descriptor !== undefined) throw new Error("Archive lock is already owned.");
        ensurePrivateDirectory(path.dirname(this.file));
        const descriptor = fs.openSync(this.file,
            fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
        let acquired = false;
        try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
                || (process.getuid && stat.uid !== process.getuid())) throw new Error("Archive lock must be private.");
            const args = ["--exclusive", ...(waitMilliseconds > 0
                ? ["--wait", String(Math.max(0, waitMilliseconds - 25) / 1000)] : ["--nonblock"]),
            "--conflict-exit-code", "75", "3"];
            // spawnSync terminates AND reaps on timeout before returning. Only then may
            // the parent's fd close; an uncertain helper is never an election victory.
            const helper = spawnSync("/usr/bin/flock", args, {
                stdio: ["ignore", "ignore", "ignore", descriptor],
                env: {PATH: "/usr/bin:/bin", LANG: "C"},
                timeout: waitMilliseconds > 0 ? waitMilliseconds : 250,
                killSignal: "SIGKILL",
            });
            if (waitMilliseconds > 0 && (helper.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return false;
            if (helper.error || helper.signal) throw new Error("Archive lock helper failed.");
            if (helper.status === 75) return false;
            if (helper.status !== 0) throw new Error("Archive lock helper failed.");
            this.descriptor = descriptor;
            acquired = true;
            return true;
        } finally {
            if (!acquired) fs.closeSync(descriptor);
        }
    }

    release(): void {
        if (this.descriptor === undefined) return;
        const descriptor = this.descriptor;
        this.descriptor = undefined;
        fs.closeSync(descriptor);
    }
}

/** Create one durable leaf only. Custom roots require an already-existing parent;
 * recursively creating unknown ancestors would need a different durability protocol. */
export function ensurePrivateDirectory(directory: string): void {
    try {
        fs.mkdirSync(directory, {mode: 0o700});
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error("Archive directory must be private.");
    // Repeat synchronization for existing leaves: a previous creation may have
    // succeeded but failed before its parent-directory synchronization completed.
    syncDirectory(directory);
    syncDirectory(path.dirname(directory));
}

export function syncDirectory(directory: string): void {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}
