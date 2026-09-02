import {mkdtemp, mkdir, realpath, rm} from "node:fs/promises";
import type {Readable} from "node:stream";
import path from "node:path";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";
import {resolveNativeExecutable} from "../../../runtime/NativeExecutable.js";
import {NativeFilesystemPolicyBridge} from "./NativeFilesystemPolicyBridge.js";
import {replaceNativeFilesystemSnapshotFile} from "./NativeFilesystemSnapshotFile.js";
import {hasMountedPathAtOrBelow, isMountedPath} from "./NativeFuseMountState.js";
import type {NativeFilesystemPolicyView} from "./NativeFilesystemPolicyView.js";
import type {NativeFuseSessionBroker} from "./NativeFuseSessionBroker.js";

const HOST_FILESYSTEM_ROOT = "/";
const READY_TIMEOUT_MILLISECONDS = 10_000;
const CLEANUP_TIMEOUT_MILLISECONDS = 5_000;
const OUTPUT_TAIL_BYTES = 64 * 1024;

export type NativeFuseMountOptions = {
    cwd: string;
    policyView: NativeFilesystemPolicyView;
    signal?: AbortSignal;
    onDecisionError?: (error: unknown) => void;
    onPolicyDeny?: (message: string) => void;
    sessionBroker?: NativeFuseSessionBroker;
};

export type NativeFuseMountContext = {
    mediatedHostRoot: string;
    cwd: string;
    signal?: AbortSignal;
};

export type NativeFuseRunOptions = NativeFuseMountOptions & {
    command: string[];
    env?: NodeJS.ProcessEnv;
    timeoutSeconds?: number;
    onStdout?: (data: Buffer) => void;
    onStderr?: (data: Buffer) => void;
};

export type NativeFuseRunResult = {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
};

export async function runNativeFuseSandboxedCommand(
    options: NativeFuseRunOptions,
): Promise<NativeFuseRunResult> {
    if (options.command.length === 0) throw new Error("Native FUSE sandbox command is required");
    if (options.timeoutSeconds !== undefined
        && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)) {
        throw new Error("timeout must be a positive finite number of seconds");
    }
    return withNativeFuseFilesystem(options, ({mediatedHostRoot, cwd, signal}) => (
        runWorker({...options, signal}, cwd, mediatedHostRoot)
    ));
}

export async function withNativeFuseFilesystem<T>(
    options: NativeFuseMountOptions,
    run: (context: NativeFuseMountContext) => Promise<T>,
): Promise<T> {
    if (options.sessionBroker) return options.sessionBroker.withFilesystem(options, run);
    if (options.signal?.aborted) throw new Error("aborted");

    const commandCwd = await realpath(options.cwd);
    if (options.signal?.aborted) throw new Error("aborted");
    const temporaryDirectory = await mkdtemp(path.join("/var/tmp", "pilot-native-fuse-"));
    const mountpoint = path.join(temporaryDirectory, "root");
    const snapshotPath = path.join(temporaryDirectory, "policy.snapshot");
    const statsPath = path.join(temporaryDirectory, "stats.json");
    const decisionController = new AbortController();
    const abortDecisions = () => decisionController.abort();
    options.signal?.addEventListener("abort", abortDecisions, {once: true});
    if (options.signal?.aborted) abortDecisions();

    let daemon: ManagedChildProcess | undefined;
    let bridge: NativeFilesystemPolicyBridge | undefined;
    let unsubscribePolicyBase: (() => void) | undefined;
    let mounted = false;
    let result: T | undefined;
    let runError: unknown;
    const daemonOutput = new OutputTail();
    try {
        throwIfAborted(decisionController.signal);
        await mkdir(mountpoint);
        throwIfAborted(decisionController.signal);
        unsubscribePolicyBase = options.policyView.policyBase.onSnapshotChanged((snapshot) => {
            try {
                replaceNativeFilesystemSnapshotFile(snapshotPath, snapshot);
            } catch (error) {
                try {
                    if (bridge) bridge.fail(error);
                    else options.onDecisionError?.(error);
                } finally {
                    decisionController.abort();
                }
            }
        });
        replaceNativeFilesystemSnapshotFile(snapshotPath, options.policyView.baseSnapshot());
        throwIfAborted(decisionController.signal);
        daemon = ManagedChildProcess.spawn({
            name: "native FUSE daemon",
            command: resolveNativeExecutable("pi-fuse-native"),
            arguments: [
                mountpoint,
                temporaryDirectory,
                snapshotPath,
                statsPath,
                "3",
                "4",
                "5",
            ],
            spawnOptions: {
                cwd: HOST_FILESYSTEM_ROOT,
                detached: true,
                stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"],
            },
            terminateProcessGroup: true,
            onFailure: options.onDecisionError,
        });
        daemon.stderr?.on("data", (data: Buffer) => daemonOutput.append(data));
        const requests = daemon.readable(4);
        const responses = daemon.writable(5);
        if (!requests || !responses) throw new Error("Native FUSE daemon control descriptors are unavailable");
        bridge = new NativeFilesystemPolicyBridge(
            options.policyView,
            requests,
            responses,
            (error) => {
                try {
                    options.onDecisionError?.(error);
                } finally {
                    decisionController.abort();
                }
            },
            decisionController.signal,
            options.onPolicyDeny,
        );
        await bridge.synchronizeSnapshot();
        throwIfAborted(decisionController.signal);
        await waitForReady(daemon, daemonOutput, decisionController.signal);
        mounted = true;
        result = await run({mediatedHostRoot: mountpoint, cwd: commandCwd, signal: decisionController.signal});
    } catch (error) {
        runError = error;
    } finally {
        abortDecisions();
        options.signal?.removeEventListener("abort", abortDecisions);
    }

    let unmountError: unknown;
    let daemonError: unknown;
    let removalError: unknown;
    bridge?.close();
    daemon?.beginShutdown();
    if (mounted) {
        try {
            await unmount(mountpoint);
        } catch (error) {
            unmountError = error;
        }
    }
    if (daemon) {
        try {
            await stopDaemon(daemon);
        } catch (error) {
            daemonError = error;
        }
    }
    let mountedAfterStop: boolean | undefined;
    try {
        mountedAfterStop = await isMountedPath(mountpoint);
    } catch (error) {
        removalError = error;
    }
    if (mountedAfterStop) {
        try {
            await unmount(mountpoint);
            unmountError = undefined;
        } catch (error) {
            unmountError = error;
        }
    } else if (mountedAfterStop === false) {
        unmountError = undefined;
    }
    unsubscribePolicyBase?.();
    let mountRemains = true;
    try {
        mountRemains = await hasMountedPathAtOrBelow(temporaryDirectory);
    } catch (error) {
        removalError ??= error;
    }
    if (mountRemains) {
        unmountError = new Error(
            `Refusing to remove active or unverifiable native FUSE mount at ${mountpoint}`,
            {cause: unmountError},
        );
    } else {
        try {
            await rm(temporaryDirectory, {recursive: true, force: true});
        } catch (error) {
            removalError = error;
        }
    }
    const cleanupError = daemonError ?? unmountError ?? removalError;

    if (runError && cleanupError) {
        throw new AggregateError(
            [runError, cleanupError],
            `Native FUSE worker failed and its mount could not be cleaned up: ${daemonOutput.value()}`,
        );
    }
    if (runError) throw runError;
    if (cleanupError) throw cleanupError;
    return result!;
}

async function runWorker(
    options: NativeFuseRunOptions,
    commandCwd: string,
    mountpoint: string,
): Promise<NativeFuseRunResult> {
    if (options.signal?.aborted) throw new Error("aborted");
    const child = ManagedChildProcess.spawn({
        name: "native FUSE sandbox worker",
        command: resolveNativeExecutable("pi-exec-clean-native"),
        arguments: [
            "2",
            "/usr/bin/bwrap",
            "--bind", mountpoint, HOST_FILESYSTEM_ROOT,
            "--dev", "/dev",
            "--proc", "/proc",
            "--unshare-user",
            "--unshare-pid",
            "--cap-drop", "ALL",
            "--die-with-parent",
            "--new-session",
            "--chdir", commandCwd,
            "--",
            ...options.command,
        ],
        spawnOptions: {
            cwd: HOST_FILESYSTEM_ROOT,
            env: options.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        },
        terminateProcessGroup: true,
    });
    child.stdout?.on("data", (data: Buffer) => options.onStdout?.(data));
    child.stderr?.on("data", (data: Buffer) => options.onStderr?.(data));

    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
        aborted = true;
        child.terminate();
    };
    options.signal?.addEventListener("abort", onAbort, {once: true});
    const timeout = options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.terminate();
        }, options.timeoutSeconds * 1000);
    try {
        const result = await child.wait();
        if (aborted || options.signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${options.timeoutSeconds}`);
        return result;
    } finally {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
    }
}

async function waitForReady(
    daemon: ManagedChildProcess,
    output: OutputTail,
    signal: AbortSignal,
): Promise<void> {
    const ready = daemon.readable(3);
    if (!ready) throw new Error("Native FUSE daemon did not expose its ready descriptor");
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abortListener, {once: true});
        if (signal.aborted) abortListener();
    });
    try {
        await Promise.race([
            waitForReadyByte(ready),
            aborted,
            daemon.waitForExit().then((exit) => {
                throw new Error(
                    `Native FUSE daemon exited before mount: code=${String(exit.exitCode)} `
                    + `signal=${String(exit.signal)} stderr=${output.value()}`,
                );
            }),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`Native FUSE mount timed out: ${output.value()}`)),
                    READY_TIMEOUT_MILLISECONDS,
                );
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
        if (abortListener) signal.removeEventListener("abort", abortListener);
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("aborted");
}

function waitForReadyByte(stream: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
        const onData = () => finish(resolve);
        const onError = (error: Error) => finish(() => reject(error));
        const onEnd = () => finish(() => reject(new Error("Native FUSE ready descriptor closed before mount")));
        const finish = (complete: () => void) => {
            stream.off("data", onData);
            stream.off("error", onError);
            stream.off("end", onEnd);
            complete();
        };
        stream.once("data", onData);
        stream.once("error", onError);
        stream.once("end", onEnd);
    });
}

async function unmount(mountpoint: string): Promise<void> {
    const output = new OutputTail();
    const child = ManagedChildProcess.spawn({
        name: "native FUSE unmount",
        command: "/usr/bin/fusermount",
        arguments: ["-u", mountpoint],
        spawnOptions: {stdio: ["ignore", "ignore", "pipe"]},
    });
    child.stderr?.on("data", (data: Buffer) => output.append(data));
    if (!await child.settle(CLEANUP_TIMEOUT_MILLISECONDS)) {
        child.terminate();
        await child.waitForExit();
        throw new Error(`Native FUSE unmount timed out at ${mountpoint}`);
    }
    const result = await child.wait();
    if (result.exitCode !== 0 || result.signal) {
        throw new Error(
            `Native FUSE unmount failed: code=${String(result.exitCode)} `
            + `signal=${String(result.signal)} stderr=${output.value()}`,
        );
    }
}

async function stopDaemon(daemon: ManagedChildProcess): Promise<void> {
    if (await daemon.settle(CLEANUP_TIMEOUT_MILLISECONDS)) return;
    daemon.terminate();
    await daemon.waitForExit();
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
