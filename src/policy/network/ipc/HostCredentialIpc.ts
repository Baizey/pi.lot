import type {Readable} from "node:stream";
import {existsSync} from "node:fs";
import {realpath, stat} from "node:fs/promises";
import path from "node:path";
import type {WorkerBindMount, WorkerRuntimeResource} from "../worker/WorkerRuntimeResource.js";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";

const XDG_DBUS_PROXY_PATH = "/usr/bin/xdg-dbus-proxy";
const DBUS_NAME_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]*\.)+[A-Za-z_][A-Za-z0-9_-]*(?:\.\*)?$/;
const MAX_PROXY_ERROR_BYTES = 16 * 1024;
const PROXY_CLOSE_TIMEOUT_MILLISECONDS = 2_000;

export type HostCredentialUnixSocket = {
    id: string;
    optional?: boolean;
} & (
    | {environment: string; path?: never}
    | {path: string; environment?: never}
);

export type HostCredentialIpcOptions = {
    sessionBus?: {
        talk: readonly string[];
    };
    unixSockets?: readonly HostCredentialUnixSocket[];
};

export type HostCredentialIpcPreparationOptions = {
    runtimeDirectory: string;
    environment: NodeJS.ProcessEnv;
    ipc: HostCredentialIpcOptions;
    onError?: (error: unknown) => void;
    onFatalError?: (error: unknown) => void;
};

export async function prepareHostCredentialIpc(
    options: HostCredentialIpcPreparationOptions,
): Promise<WorkerRuntimeResource[]> {
    const resources: WorkerRuntimeResource[] = [];
    const mountedDestinations = new Set<string>();

    const talkNames = options.ipc.sessionBus?.talk ?? [];
    if (talkNames.length > 0) {
        const address = options.environment.DBUS_SESSION_BUS_ADDRESS;
        if (address) {
            try {
                const resource = await FilteredSessionBusProxy.start({
                    upstreamAddress: address,
                    runtimeDirectory: options.runtimeDirectory,
                    talkNames,
                    onFatalError: options.onFatalError,
                });
                resources.push(resource);
                mountedDestinations.add(resource.mounts()[0]!.destination);
            } catch (error) {
                report(options.onError, error);
            }
        }
    }

    const ids = new Set<string>();
    for (const socket of options.ipc.unixSockets ?? []) {
        try {
            validateSocketDefinition(socket, ids);
            const resource = isEnvironmentSocket(socket)
                ? await socketFromEnvironment(socket, options.environment)
                : await ImportedUnixSocket.atPath(socket.path);
            if (!resource) continue;
            const destination = resource.mounts()[0]!.destination;
            if (mountedDestinations.has(destination)) continue;
            mountedDestinations.add(destination);
            resources.push(resource);
        } catch (error) {
            if (!socket.optional || !isMissingPathError(error)) report(options.onError, error);
        }
    }

    return resources;
}

type FilteredSessionBusProxyOptions = {
    upstreamAddress: string;
    runtimeDirectory: string;
    talkNames: readonly string[];
    onFatalError?: (error: unknown) => void;
};

class FilteredSessionBusProxy implements WorkerRuntimeResource {
    private stopping = false;

    private constructor(
        private readonly child: ManagedChildProcess,
        private readonly socketPath: string,
        private readonly errorText: () => string,
        private readonly onFatalError?: (error: unknown) => void,
    ) {
        void child.waitForExit().then(({exitCode, signal}) => {
            if (this.stopping || child.failure) return;
            this.reportFatal(new Error(
                `filtered session D-Bus proxy exited unexpectedly: ${formatExit(exitCode, signal)}${this.errorDetail()}`,
            ));
        });
    }

    static async start(options: FilteredSessionBusProxyOptions): Promise<FilteredSessionBusProxy> {
        if (!existsSync(XDG_DBUS_PROXY_PATH)) {
            throw new Error(`filtered session D-Bus proxy is unavailable: ${XDG_DBUS_PROXY_PATH} was not found`);
        }
        if (
            !/^[A-Za-z][A-Za-z0-9_-]*:/.test(options.upstreamAddress)
            || options.upstreamAddress.includes("\0")
        ) {
            throw new Error("host D-Bus session address is malformed");
        }

        const talkNames = [...new Set(options.talkNames)];
        if (talkNames.length === 0 || talkNames.some((name) => !DBUS_NAME_PATTERN.test(name))) {
            throw new Error("credential session bus contains an invalid D-Bus talk name");
        }

        const socketPath = path.join(options.runtimeDirectory, "credential-session-bus");
        let proxy: FilteredSessionBusProxy | undefined;
        let startupFailure: Error | undefined;
        const child = ManagedChildProcess.spawn({
            name: "filtered session D-Bus proxy",
            command: XDG_DBUS_PROXY_PATH,
            arguments: [
                "--fd=3",
                options.upstreamAddress,
                socketPath,
                "--filter",
                ...talkNames.map((name) => `--talk=${name}`),
            ],
            spawnOptions: {
                detached: false,
                stdio: ["ignore", "ignore", "pipe", "pipe"],
            },
            onFailure(error) {
                startupFailure ??= error;
                proxy?.reportFatal(error);
            },
        });
        const readiness = child.readable(3);
        if (!readiness) {
            child.terminate();
            await child.settle();
            throw new Error("Secret Service D-Bus proxy readiness descriptor was not created");
        }

        let stderr = "";
        child.stderr?.on("data", (data: Buffer) => {
            if (stderr.length < MAX_PROXY_ERROR_BYTES) {
                stderr += data.toString().slice(0, MAX_PROXY_ERROR_BYTES - stderr.length);
            }
        });
        const errorText = () => stderr.trim();
        const exitedDuringStartup = () => child.wait().then(({exitCode, signal}) => {
            throw new Error(
                `filtered session D-Bus proxy exited before readiness: ${formatExit(exitCode, signal)}`
                + `${errorText() ? `: ${errorText()}` : ""}`,
            );
        });

        try {
            await Promise.race([waitForProxyReady(readiness), exitedDuringStartup()]);
            if (startupFailure) throw startupFailure;
            const socketStat = await Promise.race([stat(socketPath), exitedDuringStartup()]);
            if (!socketStat.isSocket()) throw new Error("filtered session D-Bus proxy did not create a Unix socket");
            proxy = new FilteredSessionBusProxy(
                child,
                socketPath,
                errorText,
                options.onFatalError,
            );
            return proxy;
        } catch (error) {
            child.beginShutdown();
            child.destroy(3);
            child.terminate();
            await child.settle();
            throw startupFailure ?? error;
        }
    }

    environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        return {...base, DBUS_SESSION_BUS_ADDRESS: `unix:path=${this.socketPath}`};
    }

    mounts(): readonly WorkerBindMount[] {
        return [{source: this.socketPath, destination: this.socketPath, readOnly: true}];
    }

    async close(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        this.child.beginShutdown();
        this.child.destroy(3);
        if (!await this.child.settle(PROXY_CLOSE_TIMEOUT_MILLISECONDS)) {
            this.child.terminate();
            await this.child.settle();
        }
    }

    private reportFatal(error: unknown): void {
        if (this.stopping) return;
        try {
            this.onFatalError?.(error);
        } catch {
            // Fatal-error reporting must not escape a child-process event callback.
        }
    }

    private errorDetail(): string {
        const detail = this.errorText();
        return detail ? `: ${detail}` : "";
    }
}

type EnvironmentSocket = Extract<HostCredentialUnixSocket, {environment: string}>;

function isEnvironmentSocket(socket: HostCredentialUnixSocket): socket is EnvironmentSocket {
    return typeof socket.environment === "string";
}

async function socketFromEnvironment(
    socket: EnvironmentSocket,
    environment: NodeJS.ProcessEnv,
): Promise<ImportedUnixSocket | null> {
    validateEnvironmentVariable(socket.environment);
    const socketPath = environment[socket.environment];
    if (!socketPath) {
        if (socket.optional) return null;
        throw new Error(`${socket.id} requires environment variable ${socket.environment}`);
    }
    return ImportedUnixSocket.fromEnvironment(socket.environment, socketPath);
}

function validateSocketDefinition(socket: HostCredentialUnixSocket, ids: Set<string>): void {
    if (!/^[A-Za-z0-9_-]+$/.test(socket.id)) {
        throw new Error(`invalid credential Unix-socket id: ${JSON.stringify(socket.id)}`);
    }
    if (ids.has(socket.id)) throw new Error(`duplicate credential Unix-socket id: ${JSON.stringify(socket.id)}`);
    ids.add(socket.id);
    const hasEnvironment = "environment" in socket && typeof socket.environment === "string";
    const hasPath = "path" in socket && typeof socket.path === "string";
    if (hasEnvironment === hasPath) {
        throw new Error(`${socket.id} must define exactly one Unix-socket source`);
    }
}

class ImportedUnixSocket implements WorkerRuntimeResource {
    private constructor(
        private readonly mount: WorkerBindMount,
        private readonly environmentVariable?: string,
    ) {}

    static async fromEnvironment(variable: string, socketPath: string): Promise<ImportedUnixSocket> {
        const resolved = await validatedSocketPath(socketPath, variable);
        return new ImportedUnixSocket(
            {source: resolved, destination: resolved, readOnly: true},
            variable,
        );
    }

    static async atPath(socketPath: string): Promise<ImportedUnixSocket> {
        const resolved = await validatedSocketPath(socketPath, "configured Unix socket");
        return new ImportedUnixSocket({source: resolved, destination: socketPath, readOnly: true});
    }

    environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        if (!this.environmentVariable) return base;
        return {...base, [this.environmentVariable]: this.mount.destination};
    }

    mounts(): readonly WorkerBindMount[] {
        return [this.mount];
    }
}

async function validatedSocketPath(candidate: string, description: string): Promise<string> {
    if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
        throw new Error(`${description} does not contain an absolute Unix-socket path`);
    }
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isSocket()) {
        throw new Error(`${description} does not refer to a Unix socket: ${JSON.stringify(candidate)}`);
    }
    return resolved;
}

function isMissingPathError(error: unknown): boolean {
    return error instanceof Error
        && "code" in error
        && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function validateEnvironmentVariable(variable: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        throw new Error(`invalid Unix-socket environment variable: ${JSON.stringify(variable)}`);
    }
}

function waitForProxyReady(readiness: Readable): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            readiness.off("data", onReady);
            readiness.off("end", onReadinessEnd);
            readiness.off("error", onReadinessError);
        };
        const onReady = () => {
            cleanup();
            resolve();
        };
        const onReadinessEnd = () => {
            cleanup();
            reject(new Error("filtered session D-Bus proxy closed its readiness descriptor before signaling"));
        };
        const onReadinessError = (error: Error) => {
            cleanup();
            reject(error);
        };
        readiness.once("data", onReady);
        readiness.once("end", onReadinessEnd);
        readiness.once("error", onReadinessError);
    });
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) return `signal ${signal}`;
    return `exit ${code ?? "unknown"}`;
}

function report(handler: ((error: unknown) => void) | undefined, error: unknown): void {
    try {
        handler?.(error);
    } catch {
        // Compatibility diagnostics must not fail worker setup.
    }
}
