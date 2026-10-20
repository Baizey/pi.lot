import childProcess, {type ChildProcess} from "node:child_process";
import {constants} from "node:fs";
import {access, realpath, stat} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

export type ArchiveRuntimeOptions = {
    nodeExecutable?: string;
    bootstrap?: string;
};

/** Owns an independent worker launch, not a session-owned managed process. */
export class ArchiveRuntime {
    private readonly options: ArchiveRuntimeOptions;
    private initialization: Promise<void> | undefined;
    private executable: string | undefined;
    private bootstrap: string | undefined;

    constructor(options: ArchiveRuntimeOptions = {}) {
        this.options = {...options};
    }

    /** Call at startup/configuration, never while committing a departure. */
    async initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = this.validate().catch((error: unknown) => {
                this.initialization = undefined;
                throw error;
            });
        }
        await this.initialization;
    }

    /** Success means only that the OS spawned a child, not that it drained work. */
    async launch(directory: string, configDirectory: string): Promise<void> {
        if (!this.executable || !this.bootstrap) throw new Error("Archive runtime is not initialized");
        if (!path.isAbsolute(directory) || !path.isAbsolute(configDirectory)) {
            throw new Error("Archive worker directories must be absolute");
        }
        const child = childProcess.spawn(this.executable, [this.bootstrap, directory, configDirectory], {
            cwd: path.dirname(this.bootstrap),
            env: this.environment(),
            detached: true,
            stdio: "ignore",
            shell: false,
        });
        await this.observeLaunch(child);
    }

    private async validate(): Promise<void> {
        const executable = await this.resolveExecutable();
        const requestedBootstrap = this.options.bootstrap ?? fileURLToPath(new URL("./archive-worker.mjs", import.meta.url));
        if (!path.isAbsolute(requestedBootstrap)) throw new Error("Archive bootstrap path must be absolute");
        const bootstrap = await realpath(requestedBootstrap);
        if (!(await stat(bootstrap)).isFile()) throw new Error("Archive bootstrap must be a file");

        const version = await this.check(executable, ["--eval",
            "process.stdout.write(JSON.stringify({node:process.versions.node,bun:!!process.versions.bun,name:process.release.name}))"], bootstrap);
        let supported = false;
        try {
            const value: unknown = JSON.parse(version);
            if (typeof value === "object" && value !== null && "node" in value && typeof value.node === "string"
                && "name" in value && value.name === "node" && "bun" in value && value.bun === false) {
                const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.node);
                supported = match !== null && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 19));
            }
        } catch {
            // An executable claiming an incompatible or non-Node version is not usable.
        }
        if (!supported) throw new Error("Archive worker requires external Node >=22.19");
        await this.check(executable, [bootstrap, "--check"], bootstrap);
        this.executable = executable;
        this.bootstrap = bootstrap;
    }

    private async resolveExecutable(): Promise<string> {
        if (this.options.nodeExecutable !== undefined) {
            if (!path.isAbsolute(this.options.nodeExecutable)) throw new Error("Archive Node executable must be absolute");
            return await this.executablePath(this.options.nodeExecutable);
        }
        // Ignore relative PATH entries: neither Pi's executable nor a project cwd is authority.
        for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
            if (!path.isAbsolute(directory)) continue;
            try {
                return await this.executablePath(path.join(directory, "node"));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw error;
            }
        }
        throw new Error("Archive worker requires an external Node executable on PATH");
    }

    private async executablePath(candidate: string): Promise<string> {
        const executable = await realpath(candidate);
        await access(executable, constants.X_OK);
        if (!(await stat(executable)).isFile()) throw new Error("Archive Node executable must be a file");
        return executable;
    }

    private async check(executable: string, args: string[], bootstrap: string): Promise<string> {
        return await new Promise((resolve, reject) => {
            childProcess.execFile(executable, args, {
                cwd: path.dirname(bootstrap),
                env: this.environment(),
                timeout: 5_000,
                killSignal: "SIGKILL",
                maxBuffer: 16 * 1024,
                encoding: "utf8",
                shell: false,
            }, (error, stdout) => {
                // Do not echo subprocess output: bootstrap diagnostics are not credential authority.
                if (error) reject(new Error("Archive runtime validation failed (Node or SQLite bootstrap)"));
                else resolve(stdout);
            });
        });
    }

    private observeLaunch(child: ChildProcess): Promise<void> {
        return new Promise((resolve, reject) => {
            let outcome: "pending" | "spawned" | "failed" = "pending";
            const terminate = () => {
                // Kill the exact child handle, never a possibly reused PID/process group.
                // If spawn is still pending, the late spawn listener performs this cleanup.
                if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            };
            const timeout = setTimeout(() => {
                outcome = "failed";
                clearTimeout(timeout);
                terminate();
                child.unref();
                // Bound the caller's wait, not OS reaping. Keep cleanup listeners alive for
                // delayed spawn/error/close events without keeping the parent alive for them.
                reject(new Error("Archive worker launch timed out after one second"));
            }, 1_000);
            child.once("spawn", () => {
                if (outcome === "failed") {
                    terminate();
                    child.unref();
                    return;
                }
                outcome = "spawned";
                clearTimeout(timeout);
                child.unref();
                resolve();
            });
            child.on("error", () => {
                if (outcome !== "pending") return;
                outcome = "failed";
                clearTimeout(timeout);
                terminate();
                child.unref();
                reject(new Error("Archive worker could not be spawned"));
            });
            child.once("close", () => {
                clearTimeout(timeout);
                if (outcome !== "pending") return;
                outcome = "failed";
                reject(new Error("Archive worker closed before spawn completed"));
            });
        });
    }

    private environment(): NodeJS.ProcessEnv {
        const environment: NodeJS.ProcessEnv = {PATH: "/usr/bin:/bin"};
        for (const key of ["HOME", "TMPDIR"] as const) {
            const value = process.env[key];
            if (value && path.isAbsolute(value)) environment[key] = value;
        }
        return environment;
    }
}
