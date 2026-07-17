import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {Readable, Writable} from "node:stream";

export const sandboxProtocolVersion = 2 as const;

export type SandboxRunOptions = {
  command: string[];
  cwd: string;
  writableRoots?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onDecisionError?: (error: unknown) => void;
  decide: (event: SandboxEvent) => SandboxDecision | Promise<SandboxDecision>;
};

export type SandboxRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export async function runSandboxedCommand(options: SandboxRunOptions): Promise<SandboxRunResult> {
  if (options.command.length === 0) throw new Error("bubblewrap command is required");
  if (options.signal?.aborted) throw new Error("aborted");
  if (options.timeoutSeconds !== undefined && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0)) {
    throw new Error("timeout must be a positive finite number of seconds");
  }

  const nativeAdapter = resolveNativeAdapter();
  const nativeArgs = [
    "--event-fd", "3",
    "--decision-fd", "4",
    ...(options.writableRoots ?? []).flatMap((root) => ["--writable-root", root]),
    "--",
    ...options.command,
  ];
  const child = spawn(nativeAdapter, nativeArgs, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const eventStream = child.stdio[3] as Readable | null;
  const decisionStream = child.stdio[4] as Writable | null;
  if (!eventStream || !decisionStream) {
    killProcessGroup(child.pid);
    throw new Error("native adapter control pipes were not created");
  }

  child.stdout?.on("data", (data: Buffer) => options.onStdout?.(data));
  child.stderr?.on("data", (data: Buffer) => options.onStderr?.(data));

  let aborted = false;
  let timedOut = false;
  const terminate = () => killProcessGroup(child.pid);
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

  const exit = new Promise<SandboxRunResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({exitCode, signal}));
  });

  try {
    const lines = createInterface({input: eventStream});
    for await (const line of lines) {
      let decision = SandboxDecision.DENY;
      try {
        const event = parseSandboxEvent(line);
        const requestedDecision = await options.decide(event);
        if (requestedDecision !== SandboxDecision.ALLOW && requestedDecision !== SandboxDecision.DENY) {
          throw new Error(`invalid sandbox decision: ${String(requestedDecision)}`);
        }
        decision = requestedDecision;
      } catch (error) {
        options.onDecisionError?.(error);
      }

      if (!decisionStream.write(`${decision}\n`)) {
        await new Promise<void>((resolve) => decisionStream.once("drain", resolve));
      }
    }

    const result = await exit;
    if (aborted || options.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeoutSeconds}`);
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    decisionStream.end();
  }
}

function resolveNativeAdapter(): string {
  const candidates = [
    fileURLToPath(new URL("../../build/pi-bubblewrap-native", import.meta.url)),
    fileURLToPath(new URL("../../../build/pi-bubblewrap-native", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}


export enum SandboxPathAccessType {
  READ = "READ",
  WRITE = "WRITE",
  DELETE = "DELETE",
  EXECUTE = "EXECUTE",
}

export enum SandboxOperation {
  FILESYSTEM = "FILESYSTEM",
  CONNECT = "CONNECT",
  UNKNOWN = "UNKNOWN",
}

export type SandboxPathAccess = {
  access: SandboxPathAccessType;
  path: string;
  sandboxPrivate: boolean;
};

export type SandboxEvent = {
  version: typeof sandboxProtocolVersion;
  sequence: number;
  pid: number;
  syscall: string;
  operation: SandboxOperation;
  pathAccesses: SandboxPathAccess[];
  destination?: string;
  detail?: string;
};

export enum SandboxDecision {
  ALLOW = "ALLOW",
  DENY = "DENY",
}

export function parseSandboxEvent(line: string): SandboxEvent {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error("event must be an object");
  if (value.version !== sandboxProtocolVersion) throw new Error(`unsupported protocol version: ${String(value.version)}`);
  if (!Number.isSafeInteger(value.sequence)) throw new Error("event sequence must be an integer");
  if (!Number.isSafeInteger(value.pid)) throw new Error("event pid must be an integer");
  if (typeof value.syscall !== "string") throw new Error("event syscall must be a string");
  if (
    value.operation !== SandboxOperation.FILESYSTEM
    && value.operation !== SandboxOperation.CONNECT
    && value.operation !== SandboxOperation.UNKNOWN
  ) {
    throw new Error("event operation is invalid");
  }
  if (!Array.isArray(value.pathAccesses) || !value.pathAccesses.every(isSandboxPathAccess)) {
    throw new Error("event pathAccesses are invalid");
  }
  if (value.destination !== undefined && typeof value.destination !== "string") {
    throw new Error("event destination must be a string");
  }
  if (value.detail !== undefined && typeof value.detail !== "string") throw new Error("event detail must be a string");
  return value as SandboxEvent;
}

function isSandboxPathAccess(value: unknown): value is SandboxPathAccess {
  if (!isRecord(value)) return false;
  if (
    value.access !== SandboxPathAccessType.READ
    && value.access !== SandboxPathAccessType.WRITE
    && value.access !== SandboxPathAccessType.DELETE
    && value.access !== SandboxPathAccessType.EXECUTE
  ) {
    return false;
  }
  return typeof value.path === "string" && typeof value.sandboxPrivate === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
