import {mkdtemp, mkdir, realpath, rm} from "node:fs/promises";
import path from "node:path";
import {FuseDecision, FuseFilesystem} from "./FuseFilesystem.js";
import type {FusePolicyEvent} from "./FuseFilesystem.js";
import {resolveNativeExecutable} from "../../../runtime/NativeExecutable.js";
import {ManagedChildProcess} from "../../../runtime/ManagedChildProcess.js";

export const HOST_FILESYSTEM_ROOT = "/";

export type FuseRunOptions = {
    command: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutSeconds?: number;
    onStdout?: (data: Buffer) => void;
    onStderr?: (data: Buffer) => void;
    onDecisionError?: (error: unknown) => void;
    decide: (event: FusePolicyEvent, signal: AbortSignal) => FuseDecision | Promise<FuseDecision>;
};

export type FuseRunResult = {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
};

export type FuseMountOptions = Pick<
    FuseRunOptions,
    "cwd" | "signal" | "onDecisionError" | "decide"
>;

export type FuseMountContext = {
    mediatedHostRoot: string;
    cwd: string;
    abortDecisions(): void;
};

export async function runFuseSandboxedCommand(options: FuseRunOptions): Promise<FuseRunResult> {
    if (options.command.length === 0) throw new Error("FUSE sandbox command is required");
    if (options.timeoutSeconds !== undefined
        && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)) {
        throw new Error("timeout must be a positive finite number of seconds");
    }

    return withFuseFilesystem(options, ({mediatedHostRoot, cwd, abortDecisions}) => (
        runWorker(options, cwd, mediatedHostRoot, abortDecisions)
    ));
}

export async function withFuseFilesystem<T>(
    options: FuseMountOptions,
    run: (context: FuseMountContext) => Promise<T>,
): Promise<T> {
    if (options.signal?.aborted) throw new Error("aborted");

    const commandCwd = await realpath(options.cwd);
    const temporaryDirectory = await mkdtemp(path.join("/var/tmp", "pilot-fuse-"));
    const mountpoint = path.join(temporaryDirectory, "root");
    const decisionController = new AbortController();
    const abortDecisions = () => decisionController.abort();
    options.signal?.addEventListener("abort", abortDecisions, {once: true});
    let filesystem: FuseFilesystem | undefined;
    let mounted = false;
    let result: T | undefined;
    let runError: unknown;
    try {
        await mkdir(mountpoint);
        filesystem = new FuseFilesystem({
            backingRoot: HOST_FILESYSTEM_ROOT,
            mountpoint,
            hiddenFusePaths: [temporaryDirectory],
            decide: (event) => decideUntilAborted(options.decide, event, decisionController.signal),
            onDecisionError: options.onDecisionError,
        });
        await filesystem.mount();
        mounted = true;
        result = await run({mediatedHostRoot: mountpoint, cwd: commandCwd, abortDecisions});
    } catch (error) {
        runError = error;
    } finally {
        abortDecisions();
        options.signal?.removeEventListener("abort", abortDecisions);
    }

    let cleanupError: unknown;
    try {
        if (mounted) await filesystem!.unmount();
        await rm(temporaryDirectory, {recursive: true, force: true});
    } catch (error) {
        cleanupError = error;
    }

    if (runError && cleanupError) {
        throw new AggregateError([runError, cleanupError], "FUSE worker failed and its mount could not be cleaned up");
    }
    if (runError) throw runError;
    if (cleanupError) throw cleanupError;
    return result!;
}

async function runWorker(
    options: FuseRunOptions,
    commandCwd: string,
    mountpoint: string,
    abortDecisions: () => void,
): Promise<FuseRunResult> {
    if (options.signal?.aborted) throw new Error("aborted");

    const bubblewrapArguments = [
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
    ];
    const child = ManagedChildProcess.spawn({
        name: "FUSE sandbox worker",
        command: resolveNativeExecutable("pi-exec-clean-native"),
        arguments: [
            "2",
            "/usr/bin/bwrap",
            ...bubblewrapArguments,
        ],
        spawnOptions: {
            cwd: HOST_FILESYSTEM_ROOT,
            env: options.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        },
        terminateProcessGroup: true,
    });

    let aborted = false;
    let timedOut = false;
    const terminate = () => {
        abortDecisions();
        child.terminate();
    };
    child.stdout?.on("data", (data: Buffer) => options.onStdout?.(data));
    child.stderr?.on("data", (data: Buffer) => options.onStderr?.(data));

    const onAbort = () => {
        aborted = true;
        terminate();
    };
    options.signal?.addEventListener("abort", onAbort, {once: true});
    const timeout = options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
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

function decideUntilAborted(
    decide: FuseRunOptions["decide"],
    event: FusePolicyEvent,
    signal: AbortSignal,
): Promise<FuseDecision> {
    if (signal.aborted) return Promise.resolve(FuseDecision.DENY);

    return new Promise<FuseDecision>((resolve, reject) => {
        let settled = false;
        const finish = (decision: FuseDecision) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(decision);
        };
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(error);
        };
        const onAbort = () => finish(FuseDecision.DENY);

        signal.addEventListener("abort", onAbort, {once: true});
        if (signal.aborted) return onAbort();
        void Promise.resolve().then(() => decide(event, signal)).then(finish, fail);
    });
}
