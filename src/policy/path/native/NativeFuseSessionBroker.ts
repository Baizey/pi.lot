import {randomUUID} from "node:crypto";
import {chmod, mkdir, mkdtemp, realpath, rm} from "node:fs/promises";
import {createServer, type Server, type Socket} from "node:net";
import path from "node:path";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";
import {resolveNativeExecutable} from "../../../runtime/NativeExecutable.js";
import {NativeFilesystemPolicyBridge} from "./NativeFilesystemPolicyBridge.js";
import {replaceNativeFilesystemSnapshotFile} from "./NativeFilesystemSnapshotFile.js";
import {hasMountedPathAtOrBelow, isMountedPath} from "./NativeFuseMountState.js";
import type {
    NativeFilesystemPolicyBase,
    NativeFilesystemPolicySnapshot,
    NativeFilesystemPolicyView,
} from "./NativeFilesystemPolicyView.js";

const HOST_FILESYSTEM_ROOT = "/";
const READY_TIMEOUT_MILLISECONDS = 10_000;
const CLEANUP_TIMEOUT_MILLISECONDS = 5_000;
const MAX_HANDSHAKE_BYTES = 256;
const OUTPUT_TAIL_BYTES = 64 * 1024;

export type NativeFuseBrokerMountOptions = {
    cwd: string;
    policyView: NativeFilesystemPolicyView;
    signal?: AbortSignal;
    onDecisionError?: (error: unknown) => void;
    onPolicyDeny?: (message: string) => void;
};

export type NativeFuseBrokerMountContext = {
    mediatedHostRoot: string;
    cwd: string;
    signal: AbortSignal;
};

type AgentPolicyState = {
    policyBase: NativeFilesystemPolicyBase;
    directory: string;
    snapshotPath: string;
    lastRevision: number;
    failure?: Error;
    unsubscribe: () => void;
    retirement?: Promise<void>;
};

type MountContext = {
    token: string;
    directory: string;
    mountpoint: string;
    agentPolicyState: AgentPolicyState;
    statsPath: string;
    options: NativeFuseBrokerMountOptions;
    decisionController: AbortController;
    ready: Promise<void>;
    resolveReady: () => void;
    rejectReady: (error: Error) => void;
    readySettled: boolean;
    nativeReady: boolean;
    snapshotSynchronized: boolean;
    started: Promise<void>;
    resolveStarted: () => void;
    rejectStarted: (error: Error) => void;
    startedSettled: boolean;
    stopped: Promise<void>;
    resolveStopped: () => void;
    stopRequested: boolean;
    finished: Promise<void>;
    resolveFinished: () => void;
    startSent: boolean;
    workerPid?: number;
    mounted: boolean;
    active: boolean;
    socket?: Socket;
    bridge?: NativeFilesystemPolicyBridge;
    cleanup?: Promise<void>;
};

export class NativeFuseSessionBroker {
    private readonly contexts = new Map<string, MountContext>();
    private readonly contextSetups = new Set<Promise<MountContext>>();
    private readonly agentPolicyStates = new Map<NativeFilesystemPolicyBase, Promise<AgentPolicyState>>();
    private readonly sockets = new Set<Socket>();
    private readonly output = new OutputTail();
    private startPromise: Promise<void> | undefined;
    private closePromise: Promise<void> | undefined;
    private brokerOutputRemainder = "";
    private directory: string | undefined;
    private socketPath: string | undefined;
    private server: Server | undefined;
    private daemon: ManagedChildProcess | undefined;
    private closing = false;

    get pid(): number | undefined {
        return this.daemon?.pid;
    }

    get activeMountCount(): number {
        return this.contexts.size;
    }

    get mountedFilesystemCount(): number {
        return [...this.contexts.values()].filter((context) => context.mounted).length;
    }

    get hiddenHostPath(): string | undefined {
        return this.directory;
    }

    start(): Promise<void> {
        if (this.closing) return Promise.reject(new Error("Native FUSE session broker is shutting down"));
        this.startPromise ??= this.initialize();
        return this.startPromise;
    }

    async withFilesystem<T>(
        options: NativeFuseBrokerMountOptions,
        run: (context: NativeFuseBrokerMountContext) => Promise<T>,
    ): Promise<T> {
        await this.start();
        this.assertAvailable(options.signal);
        const commandCwd = await realpath(options.cwd);
        this.assertAvailable(options.signal);
        const context = await this.setupContext(options);
        const abort = () => context.decisionController.abort();
        options.signal?.addEventListener("abort", abort, {once: true});
        if (options.signal?.aborted) abort();

        let result: T | undefined;
        let runError: unknown;
        try {
            await this.startMount(context);
            result = await run({
                mediatedHostRoot: context.mountpoint,
                cwd: commandCwd,
                signal: context.decisionController.signal,
            });
        } catch (error) {
            runError = error;
        } finally {
            abort();
            options.signal?.removeEventListener("abort", abort);
        }

        let cleanupError: unknown;
        try {
            await this.cleanupContext(context);
        } catch (error) {
            cleanupError = error;
        } finally {
            context.resolveFinished();
        }
        if (runError && cleanupError) {
            throw new AggregateError(
                [runError, cleanupError],
                `Native FUSE run and broker cleanup both failed: ${this.output.value()}`,
            );
        }
        if (runError) throw runError;
        if (cleanupError) throw cleanupError;
        return result!;
    }

    beginShutdown(): void {
        if (this.closing) return;
        this.closing = true;
        for (const context of this.contexts.values()) context.decisionController.abort();
    }

    close(): Promise<void> {
        this.closePromise ??= this.performClose();
        return this.closePromise;
    }

    private async performClose(): Promise<void> {
        this.beginShutdown();
        const errors: unknown[] = [];
        let setupTimedOut = false;
        if (this.startPromise) await this.startPromise.catch(() => undefined);
        while (this.contextSetups.size > 0) {
            const setups = Promise.allSettled([...this.contextSetups]);
            if (await settlesWithin(setups, CLEANUP_TIMEOUT_MILLISECONDS)) continue;
            errors.push(new Error("Timed out waiting for native FUSE mount setup to stop"));
            setupTimedOut = true;
            break;
        }

        while (this.contexts.size > 0) {
            const active = [...this.contexts.values()];
            const finished = Promise.allSettled(active.map((context) => context.finished));
            if (await settlesWithin(finished, CLEANUP_TIMEOUT_MILLISECONDS)) {
                continue;
            }
            errors.push(new Error("Timed out waiting for native FUSE callbacks to stop"));
            const forced = await Promise.allSettled(active.map((context) => this.cleanupContext(context)));
            for (const result of forced) {
                if (result.status === "rejected") errors.push(result.reason);
            }
        }

        const daemon = this.daemon;
        if (daemon) {
            try {
                daemon.beginShutdown();
                daemon.end(0, "SHUTDOWN\n");
                if (!await daemon.settle(CLEANUP_TIMEOUT_MILLISECONDS)) daemon.terminate();
                await daemon.waitForExit();
            } catch (error) {
                errors.push(error);
            }
        }
        this.daemon = undefined;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        if (this.server) {
            try {
                await closeServer(this.server);
            } catch (error) {
                errors.push(error);
            }
        }
        this.server = undefined;
        const agentPolicyStateSettlement = Promise.allSettled(this.agentPolicyStates.values());
        if (await settlesWithin(agentPolicyStateSettlement, CLEANUP_TIMEOUT_MILLISECONDS)) {
            for (const result of await agentPolicyStateSettlement) {
                if (result.status === "fulfilled") result.value.unsubscribe();
            }
            this.agentPolicyStates.clear();
        } else {
            errors.push(new Error("Timed out waiting for native FUSE base setup to stop"));
            setupTimedOut = true;
            void agentPolicyStateSettlement.then(async (results) => {
                for (const result of results) {
                    if (result.status === "fulfilled") result.value.unsubscribe();
                }
                this.agentPolicyStates.clear();
                const directory = this.directory;
                if (!directory || await hasMountedPathAtOrBelow(directory)) return;
                await rm(directory, {recursive: true, force: true});
                if (this.directory === directory) {
                    this.directory = undefined;
                    this.socketPath = undefined;
                }
            }).catch(() => undefined);
        }
        let directoryRemoved = this.directory === undefined;
        if (this.directory) {
            try {
                if (setupTimedOut) {
                    throw new Error(
                        `Refusing to remove native FUSE directory with unfinished setup: ${this.directory}`,
                    );
                }
                if (await hasMountedPathAtOrBelow(this.directory)) {
                    throw new Error(`Refusing to remove native FUSE directory with an active mount: ${this.directory}`);
                }
                await rm(this.directory, {recursive: true, force: true});
                directoryRemoved = true;
            } catch (error) {
                errors.push(error);
            }
        }
        if (directoryRemoved) {
            this.directory = undefined;
            this.socketPath = undefined;
        }
        if (errors.length > 0) throw new AggregateError(errors, "Native FUSE session broker cleanup failed");
    }

    private async initialize(): Promise<void> {
        const directory = await mkdtemp(path.join("/var/tmp", "pilot-native-fuse-session-"));
        const socketPath = path.join(directory, "policy.sock");
        const server = createServer((socket) => this.acceptConnection(socket));
        try {
            await listen(server, socketPath);
            server.on("error", (error) => this.failContexts(error));
            await chmod(socketPath, 0o600);
            const daemon = ManagedChildProcess.spawn({
                name: "native FUSE session broker",
                command: resolveNativeExecutable("pi-fuse-native"),
                arguments: ["--broker"],
                spawnOptions: {
                    cwd: HOST_FILESYSTEM_ROOT,
                    detached: true,
                    stdio: ["pipe", "pipe", "pipe"],
                },
                terminateProcessGroup: true,
                onFailure: (error) => this.failContexts(error),
            });
            daemon.stdout?.on("data", (data: Buffer) => this.handleBrokerOutput(data));
            daemon.stderr?.on("data", (data: Buffer) => this.output.append(data));
            void daemon.waitForExit().then((exit) => {
                if (this.closing) return;
                this.failContexts(new Error(
                    `Native FUSE session broker exited: code=${String(exit.exitCode)} `
                    + `signal=${String(exit.signal)} stderr=${this.output.value()}`,
                ));
            });
            this.directory = directory;
            this.socketPath = socketPath;
            this.server = server;
            this.daemon = daemon;
        } catch (error) {
            await closeServer(server).catch(() => undefined);
            await rm(directory, {recursive: true, force: true});
            throw error;
        }
    }

    private async setupContext(options: NativeFuseBrokerMountOptions): Promise<MountContext> {
        const setup = this.createContext(options);
        this.contextSetups.add(setup);
        try {
            return await setup;
        } finally {
            this.contextSetups.delete(setup);
        }
    }

    private async createContext(options: NativeFuseBrokerMountOptions): Promise<MountContext> {
        this.assertAvailable(options.signal);
        const sessionDirectory = this.directory;
        if (!sessionDirectory) throw new Error("Native FUSE session broker is not started");
        const agentPolicyState = await this.agentPolicyState(options.policyView.policyBase);
        this.assertAvailable(options.signal);
        if (agentPolicyState.failure) throw agentPolicyState.failure;
        const token = randomUUID();
        const directory = path.join(sessionDirectory, `mount-${token}`);
        const mountpoint = path.join(directory, "root");
        const statsPath = path.join(directory, "stats.json");
        try {
            await mkdir(mountpoint, {recursive: true, mode: 0o700});
            this.assertAvailable(options.signal);
            if (agentPolicyState.failure) throw agentPolicyState.failure;
        } catch (error) {
            await rm(directory, {recursive: true, force: true}).catch(() => undefined);
            throw error;
        }

        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        let resolveStarted!: () => void;
        let rejectStarted!: (error: Error) => void;
        const started = new Promise<void>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
        });
        void ready.catch(() => undefined);
        void started.catch(() => undefined);
        let resolveStopped!: () => void;
        const stopped = new Promise<void>((resolve) => {
            resolveStopped = resolve;
        });
        let resolveFinished!: () => void;
        const finished = new Promise<void>((resolve) => {
            resolveFinished = resolve;
        });
        const context: MountContext = {
            token,
            directory,
            mountpoint,
            agentPolicyState,
            statsPath,
            options,
            decisionController: new AbortController(),
            ready,
            resolveReady,
            rejectReady,
            readySettled: false,
            nativeReady: false,
            snapshotSynchronized: false,
            started,
            resolveStarted,
            rejectStarted,
            startedSettled: false,
            stopped,
            resolveStopped,
            stopRequested: false,
            finished,
            resolveFinished,
            startSent: false,
            mounted: false,
            active: true,
        };
        this.contexts.set(token, context);
        return context;
    }

    private async agentPolicyState(
        policyBase: NativeFilesystemPolicyBase,
    ): Promise<AgentPolicyState> {
        const existing = this.agentPolicyStates.get(policyBase);
        if (existing) return existing;
        const creation = this.createAgentPolicyState(policyBase);
        this.agentPolicyStates.set(policyBase, creation);
        try {
            return await creation;
        } catch (error) {
            if (this.agentPolicyStates.get(policyBase) === creation) {
                this.agentPolicyStates.delete(policyBase);
            }
            throw error;
        }
    }

    private async createAgentPolicyState(
        policyBase: NativeFilesystemPolicyBase,
    ): Promise<AgentPolicyState> {
        this.assertAvailable();
        const sessionDirectory = this.directory;
        if (!sessionDirectory) throw new Error("Native FUSE session broker is not started");
        const directory = path.join(sessionDirectory, `agent-${randomUUID()}`);
        await mkdir(directory, {recursive: true, mode: 0o700});
        let unsubscribeSnapshot: (() => void) | undefined;
        let unsubscribeClose: (() => void) | undefined;
        try {
            this.assertAvailable();
            const state: AgentPolicyState = {
                policyBase,
                directory,
                snapshotPath: path.join(directory, "policy.snapshot"),
                lastRevision: -1,
                unsubscribe: () => undefined,
            };
            unsubscribeSnapshot = policyBase.onSnapshotChanged((snapshot) => {
                try {
                    this.publishAgentPolicySnapshot(state, snapshot);
                } catch (cause) {
                    const error = cause instanceof Error ? cause : new Error(String(cause));
                    state.failure = error;
                    this.failAgentContexts(state, error);
                    void this.retireAgentPolicyStateIfUnused(state).catch(() => undefined);
                }
            });
            unsubscribeClose = policyBase.onClosed(() => {
                const error = new Error(`Native filesystem policy base closed: ${policyBase.agentIdentifier}`);
                state.failure = error;
                this.failAgentContexts(state, error);
                void this.retireAgentPolicyStateIfUnused(state).catch(() => undefined);
            });
            state.unsubscribe = () => {
                unsubscribeSnapshot?.();
                unsubscribeClose?.();
            };
            this.publishAgentPolicySnapshot(state, policyBase.snapshot());
            return state;
        } catch (error) {
            unsubscribeSnapshot?.();
            unsubscribeClose?.();
            await rm(directory, {recursive: true, force: true}).catch(() => undefined);
            throw error;
        }
    }

    private publishAgentPolicySnapshot(
        state: AgentPolicyState,
        snapshot: NativeFilesystemPolicySnapshot,
    ): void {
        if (snapshot.revision <= state.lastRevision) {
            throw new Error(
                `Native filesystem base revision did not advance beyond ${state.lastRevision}: ${snapshot.revision}`,
            );
        }
        replaceNativeFilesystemSnapshotFile(state.snapshotPath, snapshot);
        state.lastRevision = snapshot.revision;
    }

    private failAgentContexts(state: AgentPolicyState, error: Error): void {
        for (const context of this.contexts.values()) {
            if (context.agentPolicyState !== state) continue;
            this.rejectReady(context, error);
            this.notifyContextError(context, error);
            context.bridge?.fail(error);
            context.socket?.destroy();
            context.decisionController.abort();
        }
    }

    private async startMount(context: MountContext): Promise<void> {
        const daemon = this.daemon;
        const socketPath = this.socketPath;
        const sessionDirectory = this.directory;
        if (!daemon || !socketPath || !sessionDirectory) throw new Error("Native FUSE session broker is unavailable");
        if (context.agentPolicyState.failure) throw context.agentPolicyState.failure;
        const fields = [
            "START",
            context.token,
            context.mountpoint,
            sessionDirectory,
            context.agentPolicyState.snapshotPath,
            context.statsPath,
            socketPath,
        ];
        if (fields.some((field) => /[\t\r\n]/.test(field))) {
            throw new Error("Native FUSE broker command contains an invalid separator");
        }
        context.startSent = true;
        await daemon.write(0, `${fields.join("\t")}\n`);
        let timeout: NodeJS.Timeout | undefined;
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(new Error("aborted"));
            context.decisionController.signal.addEventListener("abort", abortListener, {once: true});
            if (context.decisionController.signal.aborted) abortListener();
        });
        try {
            await Promise.race([
                Promise.all([context.started, context.ready]),
                aborted,
                daemon.waitForExit().then(() => {
                    throw new Error(`Native FUSE broker exited before mount: ${this.output.value()}`);
                }),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(`Native FUSE broker mount timed out: ${this.output.value()}`)),
                        READY_TIMEOUT_MILLISECONDS,
                    );
                }),
            ]);
            context.mounted = true;
        } finally {
            if (timeout) clearTimeout(timeout);
            if (abortListener) context.decisionController.signal.removeEventListener("abort", abortListener);
        }
    }

    private acceptConnection(socket: Socket): void {
        if (this.closing) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        const handshakeTimeout = setTimeout(() => socket.destroy(), READY_TIMEOUT_MILLISECONDS);
        handshakeTimeout.unref();
        let handshake = Buffer.alloc(0);
        const fail = (_error: Error) => {
            clearTimeout(handshakeTimeout);
            socket.destroy();
        };
        const onData = (chunk: Buffer) => {
            handshake = Buffer.concat([handshake, chunk]);
            if (handshake.length > MAX_HANDSHAKE_BYTES) {
                fail(new Error("Native FUSE broker handshake is too large"));
                return;
            }
            const newline = handshake.indexOf(0x0a);
            if (newline < 0) return;
            if (newline !== handshake.length - 1) {
                fail(new Error("Native FUSE broker handshake included trailing data"));
                return;
            }
            socket.off("data", onData);
            socket.off("error", fail);
            clearTimeout(handshakeTimeout);
            const token = handshake.subarray(0, newline).toString("utf8");
            const context = this.contexts.get(token);
            if (!context || context.socket || !context.active) {
                fail(new Error("Native FUSE broker supplied an unknown or duplicate mount token"));
                return;
            }
            context.socket = socket;
            let bridge: NativeFilesystemPolicyBridge;
            try {
                if (this.closing || !context.active) throw new Error("Native FUSE mount is shutting down");
                bridge = new NativeFilesystemPolicyBridge(
                    context.options.policyView,
                    socket,
                    socket,
                    (error) => {
                        this.notifyContextError(context, error);
                        context.decisionController.abort();
                    },
                    context.decisionController.signal,
                    context.options.onPolicyDeny,
                    () => this.markNativeReady(context),
                );
            } catch (cause) {
                const error = cause instanceof Error ? cause : new Error(String(cause));
                this.rejectReady(context, error);
                this.notifyContextError(context, error);
                context.decisionController.abort();
                socket.destroy();
                return;
            }
            context.bridge = bridge;
            socket.once("close", () => {
                if (!context.active || this.closing) return;
                const error = new Error("Native FUSE mount control channel disconnected");
                this.rejectReady(context, error);
                this.notifyContextError(context, error);
                context.decisionController.abort();
            });
            socket.write(Buffer.from([1]), (error) => {
                if (error) {
                    this.rejectReady(context, error);
                    return;
                }
                try {
                    void bridge.synchronizeSnapshot().then(
                        () => this.markSnapshotSynchronized(context),
                        (cause: unknown) => this.failSnapshotSynchronization(context, cause),
                    );
                } catch (cause) {
                    this.failSnapshotSynchronization(context, cause);
                }
            });
        };
        socket.on("data", onData);
        socket.once("error", fail);
    }

    private handleBrokerOutput(data: Buffer): void {
        this.brokerOutputRemainder += data.toString("utf8");
        if (this.brokerOutputRemainder.length > OUTPUT_TAIL_BYTES) {
            this.failContexts(new Error("Native FUSE broker output line is too large"));
            this.brokerOutputRemainder = "";
            return;
        }
        while (true) {
            const newline = this.brokerOutputRemainder.indexOf("\n");
            if (newline < 0) return;
            const line = this.brokerOutputRemainder.slice(0, newline).replace(/\r$/, "");
            this.brokerOutputRemainder = this.brokerOutputRemainder.slice(newline + 1);
            const fields = line.split("\t");
            const context = fields[1] ? this.contexts.get(fields[1]) : undefined;
            if (fields[0] === "STARTED" && fields.length === 3 && context) {
                const pid = Number(fields[2]);
                if (!Number.isSafeInteger(pid) || pid <= 0 || context.startedSettled) {
                    this.rejectStarted(context, new Error(`Invalid native FUSE broker STARTED message: ${line}`));
                    continue;
                }
                context.workerPid = pid;
                context.startedSettled = true;
                context.resolveStarted();
                continue;
            }
            if (fields[0] === "STOPPED" && fields.length === 2) {
                context?.resolveStopped();
                continue;
            }
            if (context) {
                const error = new Error(`Invalid native FUSE broker output: ${line}`);
                this.rejectStarted(context, error);
                this.rejectReady(context, error);
                this.notifyContextError(context, error);
                context.decisionController.abort();
            }
        }
    }

    private failSnapshotSynchronization(context: MountContext, cause: unknown): void {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.rejectReady(context, error);
        this.notifyContextError(context, error);
        context.decisionController.abort();
    }

    private markNativeReady(context: MountContext): void {
        context.nativeReady = true;
        this.resolveReadyIfSynchronized(context);
    }

    private markSnapshotSynchronized(context: MountContext): void {
        context.snapshotSynchronized = true;
        this.resolveReadyIfSynchronized(context);
    }

    private resolveReadyIfSynchronized(context: MountContext): void {
        if (context.readySettled || !context.nativeReady || !context.snapshotSynchronized) return;
        context.readySettled = true;
        context.resolveReady();
    }

    private rejectReady(context: MountContext, error: Error): void {
        if (context.readySettled) return;
        context.readySettled = true;
        context.rejectReady(error);
    }

    private rejectStarted(context: MountContext, error: Error): void {
        if (context.startedSettled) return;
        context.startedSettled = true;
        context.rejectStarted(error);
    }

    private cleanupContext(context: MountContext): Promise<void> {
        context.cleanup ??= this.performContextCleanup(context);
        return context.cleanup;
    }

    private async performContextCleanup(context: MountContext): Promise<void> {
        context.active = false;
        context.decisionController.abort();
        context.bridge?.close();
        context.socket?.destroy();
        let unmountError: unknown;
        let stopError: unknown;
        let removalError: unknown;
        if (context.mounted) {
            try {
                await unmount(context.mountpoint, false);
            } catch (error) {
                unmountError = error;
            }
        }
        try {
            await this.stopMountWorker(context);
        } catch (error) {
            stopError = error;
        }
        let mountedAfterStop: boolean | undefined;
        try {
            mountedAfterStop = await isMountedPath(context.mountpoint);
        } catch (error) {
            removalError = error;
        }
        if (mountedAfterStop) {
            try {
                await unmount(context.mountpoint, false);
                unmountError = undefined;
            } catch (error) {
                unmountError = error;
            }
        } else if (mountedAfterStop === false) {
            unmountError = undefined;
        }
        this.contexts.delete(context.token);
        try {
            await this.retireAgentPolicyStateIfUnused(context.agentPolicyState);
        } catch (error) {
            removalError ??= error;
        }
        let mountRemains = true;
        try {
            mountRemains = await hasMountedPathAtOrBelow(context.directory);
        } catch (error) {
            removalError ??= error;
        }
        if (mountRemains) {
            unmountError = new Error(
                `Refusing to remove active or unverifiable native FUSE mount at ${context.mountpoint}`,
                {cause: unmountError},
            );
        } else {
            try {
                await rm(context.directory, {recursive: true, force: true});
            } catch (error) {
                removalError = error;
            }
        }
        const errors = [unmountError, stopError, removalError].filter((error) => error !== undefined);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, `Native FUSE mount cleanup failed: ${context.token}`);
    }

    private async retireAgentPolicyStateIfUnused(state: AgentPolicyState): Promise<void> {
        if (!state.failure || state.retirement) return state.retirement;
        if ([...this.contexts.values()].some((context) => context.agentPolicyState === state)) return;
        state.retirement = (async () => {
            state.unsubscribe();
            const stored = this.agentPolicyStates.get(state.policyBase);
            if (stored && (await stored.catch(() => undefined)) === state) {
                this.agentPolicyStates.delete(state.policyBase);
            }
            await rm(state.directory, {recursive: true, force: true});
        })();
        return state.retirement;
    }

    private async stopMountWorker(context: MountContext): Promise<void> {
        const daemon = this.daemon;
        if (!context.startSent || !daemon) return;
        if (!context.stopRequested) {
            context.stopRequested = true;
            await daemon.write(0, `STOP\t${context.token}\n`);
        }
        let timeout: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                context.stopped,
                daemon.waitForExit().then(() => undefined),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(`Native FUSE broker worker stop timed out: ${context.token}`)),
                        CLEANUP_TIMEOUT_MILLISECONDS,
                    );
                }),
            ]);
        } catch (error) {
            daemon.terminate();
            await daemon.waitForExit();
            throw error;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    private failContexts(error: Error): void {
        for (const context of this.contexts.values()) {
            this.rejectStarted(context, error);
            this.rejectReady(context, error);
            this.notifyContextError(context, error);
            context.bridge?.fail(error);
            context.socket?.destroy();
            context.decisionController.abort();
        }
    }

    private notifyContextError(context: MountContext, error: unknown): void {
        try {
            context.options.onDecisionError?.(error);
        } catch {
            // Reporting must not interfere with fail-closed cleanup.
        }
    }

    private assertAvailable(signal?: AbortSignal): void {
        if (this.closing) throw new Error("Native FUSE session broker is shutting down");
        if (signal?.aborted) throw new Error("aborted");
    }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMilliseconds: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise<boolean>((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMilliseconds);
                timeout.unref();
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function listen(server: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function unmount(mountpoint: string, tolerateNotMounted: boolean): Promise<void> {
    const output = new OutputTail();
    const child = ManagedChildProcess.spawn({
        name: "native FUSE broker unmount",
        command: "/usr/bin/fusermount",
        arguments: ["-u", mountpoint],
        spawnOptions: {stdio: ["ignore", "ignore", "pipe"]},
    });
    child.stderr?.on("data", (data: Buffer) => output.append(data));
    if (!await child.settle(CLEANUP_TIMEOUT_MILLISECONDS)) {
        child.terminate();
        await child.waitForExit();
        throw new Error(`Native FUSE broker unmount timed out at ${mountpoint}`);
    }
    const result = await child.wait();
    if (result.exitCode === 0 && !result.signal) return;
    if (tolerateNotMounted && /not mounted|entry for .* not found/i.test(output.value())) return;
    throw new Error(
        `Native FUSE broker unmount failed: code=${String(result.exitCode)} `
        + `signal=${String(result.signal)} stderr=${output.value()}`,
    );
}

class OutputTail {
    private valueBuffer = Buffer.alloc(0);

    append(data: Buffer): void {
        this.valueBuffer = Buffer.concat([this.valueBuffer, data]);
        if (this.valueBuffer.length > OUTPUT_TAIL_BYTES) {
            this.valueBuffer = this.valueBuffer.subarray(this.valueBuffer.length - OUTPUT_TAIL_BYTES);
        }
    }

    value(): string {
        return this.valueBuffer.toString("utf8").trim();
    }
}
