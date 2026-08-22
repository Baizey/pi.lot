import {spawn, type ChildProcess, type SpawnOptions} from "node:child_process";
import type {Readable, Writable} from "node:stream";

export type ManagedChildProcessExit = {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
};

export type ManagedChildProcessDescriptor = "process" | "stdin" | "stdout" | "stderr" | `fd${number}`;

export type ManagedChildProcessOptions = {
    name: string;
    command: string;
    arguments?: readonly string[];
    spawnOptions?: SpawnOptions;
    terminateProcessGroup?: boolean;
    onFailure?: (error: Error) => void;
};

export class ManagedChildProcess {
    private readonly child: ChildProcess;
    private readonly exitPromise: Promise<ManagedChildProcessExit>;
    private readonly name: string;
    private readonly terminateProcessGroup: boolean;
    private readonly onFailure: ((error: Error) => void) | undefined;
    private firstFailure: Error | undefined;
    private stopping = false;
    private terminationSent = false;
    private exited = false;

    private constructor(options: ManagedChildProcessOptions, child: ChildProcess) {
        this.child = child;
        this.name = options.name;
        this.terminateProcessGroup = options.terminateProcessGroup === true;
        this.onFailure = options.onFailure;
        this.exitPromise = new Promise((resolve) => {
            child.once("close", (exitCode, signal) => {
                this.exited = true;
                resolve({exitCode, signal});
            });
        });
        child.on("error", (error) => this.handleFailure(error, "process"));

        const observed = new Set<Readable | Writable>();
        for (const [index, stream] of child.stdio.entries()) {
            if (!stream || observed.has(stream)) continue;
            observed.add(stream);
            stream.on("error", (error) => this.handleFailure(error, streamDescriptor(index)));
        }
    }

    static spawn(options: ManagedChildProcessOptions): ManagedChildProcess {
        if (!options.name.trim()) throw new Error("Managed child-process name must not be empty");
        if (!options.command.trim()) throw new Error("Managed child-process command must not be empty");
        if (options.terminateProcessGroup && options.spawnOptions?.detached !== true) {
            throw new Error("Managed child-process group termination requires a detached process");
        }
        const child = spawn(options.command, [...(options.arguments ?? [])], options.spawnOptions ?? {});
        return new ManagedChildProcess(options, child);
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    get stdout(): Readable | undefined {
        return this.child.stdout ?? undefined;
    }

    get stderr(): Readable | undefined {
        return this.child.stderr ?? undefined;
    }

    get failure(): Error | undefined {
        return this.firstFailure;
    }

    readable(index: number): Readable | undefined {
        const stream = this.stream(index);
        return stream && typeof (stream as Readable).read === "function" ? (stream as Readable) : undefined;
    }

    writable(index: number): Writable | undefined {
        const stream = this.stream(index);
        return stream && typeof (stream as Writable).write === "function" ? (stream as Writable) : undefined;
    }

    async write(index: number, data: string | Uint8Array): Promise<void> {
        const stream = this.writable(index);
        if (!stream) throw new Error(`${this.name} has no writable fd${index}`);
        if (this.stopping) throw new Error(`${this.name} is stopping`);
        await new Promise<void>((resolve, reject) => {
            stream.write(data, (error) => {
                if (!error) {
                    resolve();
                    return;
                }
                this.handleFailure(error, streamDescriptor(index));
                reject(this.firstFailure ?? error);
            });
        });
    }

    end(index: number, data?: string | Uint8Array): void {
        const stream = this.writable(index);
        if (!stream || stream.destroyed) return;
        try {
            stream.end(data);
        } catch (error) {
            this.handleFailure(asError(error), streamDescriptor(index));
        }
    }

    destroy(index: number): void {
        const stream = this.stream(index);
        if (!stream || stream.destroyed) return;
        stream.destroy();
    }

    async wait(): Promise<ManagedChildProcessExit> {
        const result = await this.exitPromise;
        if (this.firstFailure) throw this.firstFailure;
        return result;
    }

    waitForExit(): Promise<ManagedChildProcessExit> {
        return this.exitPromise;
    }

    beginShutdown(): void {
        this.stopping = true;
    }

    terminate(): void {
        this.beginShutdown();
        if (this.terminationSent || this.exited) return;
        this.terminationSent = true;
        const pid = this.child.pid;
        if (this.terminateProcessGroup && pid) {
            try {
                process.kill(-pid, "SIGKILL");
                return;
            } catch {
                // Fall back to the direct child when the process group has already disappeared.
            }
        }
        try {
            this.child.kill("SIGKILL");
        } catch {
            // The process already exited.
        }
    }

    async settle(timeoutMilliseconds = 1_000): Promise<boolean> {
        if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
            throw new Error("Managed child-process settle timeout must be a non-negative finite number");
        }
        return await Promise.race([
            this.exitPromise.then(() => true),
            delay(timeoutMilliseconds).then(() => false),
        ]);
    }

    private stream(index: number): Readable | Writable | undefined {
        if (!Number.isInteger(index) || index < 0) throw new Error("Managed child-process fd must be a non-negative integer");
        return this.child.stdio[index] ?? undefined;
    }

    private handleFailure(cause: Error, descriptor: ManagedChildProcessDescriptor): void {
        if (this.stopping || this.exited || this.firstFailure) return;
        const error = new Error(
            `${this.name} ${descriptor} failed: ${cause.message}`,
            {cause},
        );
        this.firstFailure = error;
        try {
            this.onFailure?.(error);
        } catch {
            // Process failures happen outside the initiating stack. Reporting must not crash Pi.
        } finally {
            this.terminate();
        }
    }
}

function streamDescriptor(index: number): ManagedChildProcessDescriptor {
    if (index === 0) return "stdin";
    if (index === 1) return "stdout";
    if (index === 2) return "stderr";
    return `fd${index}`;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, milliseconds);
        timeout.unref();
    });
}
