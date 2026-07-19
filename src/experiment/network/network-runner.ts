import {spawn} from "node:child_process";
import type {ChildProcess} from "node:child_process";
import {existsSync} from "node:fs";
import {realpath} from "node:fs/promises";
import {createInterface} from "node:readline";
import type {Readable, Writable} from "node:stream";
import {fileURLToPath} from "node:url";
import {
  formatNetworkQueueVerdict,
  NetworkDecision,
  parseNetworkQueueMessage,
} from "./network-queue-protocol";
import type {NetworkPolicyEvent} from "./network-queue-protocol";

export {
  NetworkAddressFamily,
  NetworkDecision,
  NetworkOperation,
  parseNetworkQueueMessage,
} from "./network-queue-protocol";
export type {NetworkEndpoint, NetworkPolicyEvent, NetworkQueueMessage} from "./network-queue-protocol";

const BWRAP_PATH = "/usr/bin/bwrap";
const NFT_PATH = "/usr/sbin/nft";
const NSENTER_PATH = "/usr/bin/nsenter";
const SLIRP4NETNS_PATH = "/usr/bin/slirp4netns";
const UNSHARE_PATH = "/usr/bin/unshare";

const ALLOW_MARK = "0x50490001";
const DENY_MARK = "0x50490002";
const PENDING_MARK = "0x50490003";

export type NetworkRunOptions = {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onDecisionError?: (error: unknown) => void;
  decide: (event: NetworkPolicyEvent, signal: AbortSignal) => NetworkDecision | Promise<NetworkDecision>;
};

export type NetworkRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type BubblewrapStatus = {
  "child-pid": number;
  "mnt-namespace": number;
  "net-namespace"?: number;
  "pid-namespace"?: number;
};

export async function runNetworkSandboxedCommand(options: NetworkRunOptions): Promise<NetworkRunResult> {
  const runner = new NetworkSandboxRunner(options);
  return runner.run();
}

class NetworkSandboxRunner {
  private readonly options: NetworkRunOptions;
  private readonly decisionAbort = new AbortController();

  private outerProcess: ChildProcess | undefined;
  private outerExit: Promise<NetworkRunResult> | undefined;
  private releaseWorker: Writable | undefined;
  private queueHelper: ChildProcess | undefined;
  private queueInput: Writable | undefined;
  private queueLines: ReturnType<typeof createInterface> | undefined;
  private queueReady = false;
  private pendingEvent = false;
  private lastSequence = 0;
  private slirp: ChildProcess | undefined;
  private slirpExit: Writable | undefined;
  private fatalError: unknown;
  private stopping = false;
  private aborted = false;
  private timedOut = false;
  private timeout: NodeJS.Timeout | undefined;
  private onAbort: (() => void) | undefined;

  constructor(options: NetworkRunOptions) {
    this.options = options;
  }

  async run(): Promise<NetworkRunResult> {
    this.validateOptions();
    if (this.options.signal?.aborted) throw new Error("aborted");

    const cwd = await realpath(this.options.cwd);
    this.startOuterProcess(cwd);
    this.installCancellation();

    try {
      await this.waitForBubblewrapStatus();
      await this.runNft(baseRuleset());
      await this.startQueueHelper();
      await this.startSlirp();
      this.unblockWorker();

      const result = await this.outerExit!;
      if (this.aborted || this.options.signal?.aborted) throw new Error("aborted");
      if (this.timedOut) throw new Error(`timeout:${this.options.timeoutSeconds}`);
      if (this.fatalError) throw this.fatalError;
      return result;
    } finally {
      await this.cleanup();
    }
  }

  private validateOptions(): void {
    if (this.options.command.length === 0) throw new Error("network sandbox command is required");
    if (
      this.options.timeoutSeconds !== undefined
      && (!Number.isFinite(this.options.timeoutSeconds) || this.options.timeoutSeconds <= 0)
    ) {
      throw new Error("timeout must be a positive finite number of seconds");
    }
  }

  private startOuterProcess(cwd: string): void {
    const bwrapArguments = [
      "--bind", "/", "/",
      "--dev-bind", "/dev", "/dev",
      "--cap-drop", "ALL",
      "--die-with-parent",
      "--new-session",
      "--chdir", cwd,
      "--json-status-fd", "3",
      "--block-fd", "4",
      "--",
      ...this.options.command,
    ];

    const child = spawn(UNSHARE_PATH, [
      "--user", "--map-current-user", "--net", "--",
      BWRAP_PATH,
      ...bwrapArguments,
    ], {
      cwd,
      env: this.options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });

    this.outerProcess = child;
    this.releaseWorker = child.stdio[4] as Writable;
    child.stdout?.on("data", (data: Buffer) => this.options.onStdout?.(data));
    child.stderr?.on("data", (data: Buffer) => this.options.onStderr?.(data));
    this.outerExit = waitForChild(child);
  }

  private async waitForBubblewrapStatus(): Promise<BubblewrapStatus> {
    const statusStream = this.outerProcess?.stdio[3] as Readable | undefined;
    if (!statusStream || !this.outerExit) throw new Error("bubblewrap status pipe was not created");

    const status = await Promise.race([
      readJsonLine(statusStream),
      this.outerExit.then((result) => {
        throw new Error(`network sandbox exited before namespace setup: ${formatExit(result)}`);
      }),
    ]);
    if (!isBubblewrapStatus(status)) throw new Error("bubblewrap returned invalid namespace status");
    return status;
  }

  private async startQueueHelper(): Promise<void> {
    const child = spawn(NSENTER_PATH, [
      ...namespaceArguments(this.outerPid()),
      resolveNetworkQueueAdapter(),
    ], {stdio: ["pipe", "pipe", "pipe"]});
    this.queueHelper = child;
    this.queueInput = child.stdin ?? undefined;

    let stderr = "";
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const failHelper = (error: Error) => {
      rejectReady(error);
      this.fail(error);
    };

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", failHelper);
    child.once("close", (code, signal) => {
      if (this.stopping || this.aborted || this.timedOut) return;
      failHelper(new Error(
        `network queue helper exited unexpectedly: ${formatExit({exitCode: code, signal})}${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });

    if (!this.queueInput) throw new Error("network queue helper stdin was not created");
    const stdout = child.stdout;
    if (!stdout) throw new Error("network queue helper stdout was not created");
    this.queueLines = createInterface({input: stdout});
    this.queueLines.on("line", (line) => {
      try {
        const message = parseNetworkQueueMessage(line);
        if (message.type === "READY") {
          if (this.queueReady) throw new Error("network queue helper sent duplicate readiness");
          this.queueReady = true;
          resolveReady();
          return;
        }
        if (!this.queueReady) throw new Error("network queue helper sent an event before readiness");
        this.onQueueEvent(message.event);
      } catch (error) {
        failHelper(error instanceof Error ? error : new Error(String(error)));
      }
    });

    await ready;
  }

  private async startSlirp(): Promise<void> {
    const child = spawn(SLIRP4NETNS_PATH, [
      "--configure",
      "--ready-fd=3",
      "--exit-fd=4",
      String(this.outerPid()),
      "tap0",
    ], {stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]});
    this.slirp = child;
    this.slirpExit = child.stdio[4] as Writable;

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => {
      if (!this.stopping && !this.aborted && !this.timedOut) {
        this.fail(new Error(`slirp4netns exited unexpectedly: ${formatExit({exitCode: code, signal})}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });

    const ready = child.stdio[3] as Readable | undefined;
    if (!ready) throw new Error("slirp4netns ready pipe was not created");
    await Promise.race([
      waitForData(ready),
      waitForChild(child).then((result) => {
        throw new Error(`slirp4netns exited before becoming ready: ${formatExit(result)}${stderr ? `: ${stderr.trim()}` : ""}`);
      }),
    ]);
  }

  private unblockWorker(): void {
    if (!this.releaseWorker) throw new Error("bubblewrap block pipe was not created");
    this.releaseWorker.write(Buffer.from([1]));
    this.releaseWorker.end();
    this.releaseWorker = undefined;
  }

  private onQueueEvent(event: NetworkPolicyEvent): void {
    if (this.pendingEvent) {
      this.fail(new Error("network queue helper sent concurrent policy events"));
      return;
    }
    if (event.sequence !== this.lastSequence + 1) {
      this.fail(new Error(`network queue helper sent unexpected sequence ${event.sequence}`));
      return;
    }

    this.lastSequence = event.sequence;
    this.pendingEvent = true;
    void this.resolveAttempt(event).then(
      () => {
        this.pendingEvent = false;
      },
      (error) => {
        this.pendingEvent = false;
        this.fail(error);
      },
    );
  }

  private async resolveAttempt(event: NetworkPolicyEvent): Promise<void> {
    let decision = NetworkDecision.DENY;
    try {
      const requested = await this.options.decide(event, this.decisionAbort.signal);
      if (requested !== NetworkDecision.ALLOW && requested !== NetworkDecision.DENY) {
        throw new Error(`invalid network decision: ${String(requested)}`);
      }
      decision = requested;
    } catch (error) {
      try {
        this.options.onDecisionError?.(error);
      } catch {
        // Error reporting must not turn a denied flow into an allowed one.
      }
    }

    if (this.stopping || this.decisionAbort.signal.aborted) return;
    if (!this.queueInput) throw new Error("network queue helper verdict stream is unavailable");
    await writeToStream(this.queueInput, formatNetworkQueueVerdict(event.sequence, decision));
  }

  private async runNft(input: string): Promise<void> {
    const child = spawn(NSENTER_PATH, [
      ...namespaceArguments(this.outerPid()),
      NFT_PATH,
      "-f", "-",
    ], {stdio: ["pipe", "pipe", "pipe"]});

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.stdin?.end(input);

    const result = await waitForChild(child);
    if (result.exitCode !== 0 || result.signal) {
      const detail = stderr.trim() || stdout.trim();
      throw new Error(`nftables command failed: ${formatExit(result)}${detail ? `: ${detail}` : ""}`);
    }
  }

  private installCancellation(): void {
    this.onAbort = () => {
      this.aborted = true;
      this.decisionAbort.abort();
      this.terminate();
    };
    this.options.signal?.addEventListener("abort", this.onAbort, {once: true});

    if (this.options.timeoutSeconds !== undefined) {
      this.timeout = setTimeout(() => {
        this.timedOut = true;
        this.decisionAbort.abort();
        this.terminate();
      }, this.options.timeoutSeconds * 1000);
    }
  }

  private fail(error: unknown): void {
    if (this.stopping || this.fatalError) return;
    this.fatalError = error;
    this.decisionAbort.abort();
    this.terminate();
  }

  private terminate(): void {
    killProcessGroup(this.outerProcess?.pid);
    this.queueInput?.end();
    killProcess(this.queueHelper);
    this.slirpExit?.end();
    killProcess(this.slirp);
  }

  private async cleanup(): Promise<void> {
    this.stopping = true;
    this.decisionAbort.abort();
    if (this.timeout) clearTimeout(this.timeout);
    if (this.onAbort) this.options.signal?.removeEventListener("abort", this.onAbort);
    this.onAbort = undefined;
    this.releaseWorker?.end();
    this.releaseWorker = undefined;
    this.queueLines?.close();
    this.queueLines = undefined;
    this.queueInput?.end();
    this.queueInput = undefined;
    this.slirpExit?.end();
    this.slirpExit = undefined;
    killProcess(this.queueHelper);
    killProcess(this.slirp);
    if (this.outerProcess?.exitCode === null && this.outerProcess.signalCode === null) {
      killProcessGroup(this.outerProcess.pid);
    }
    await Promise.allSettled([
      settleChild(this.queueHelper),
      settleChild(this.slirp),
      this.outerExit,
    ]);
  }

  private outerPid(): number {
    const pid = this.outerProcess?.pid;
    if (!pid) throw new Error("network namespace process has no pid");
    return pid;
  }
}

function resolveNetworkQueueAdapter(): string {
  const candidates = [
    fileURLToPath(new URL("../../build/pi-network-queue-native", import.meta.url)),
    fileURLToPath(new URL("../../../build/pi-network-queue-native", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function namespaceArguments(pid: number): string[] {
  return [
    "--target", String(pid),
    "--user",
    "--preserve-credentials",
    "--keep-caps",
    "--net",
  ];
}

function baseRuleset(): string {
  return `table inet pi_network {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    meta mark ${ALLOW_MARK} ct mark set ${ALLOW_MARK} accept
    meta mark ${DENY_MARK} ct mark set ${DENY_MARK} reject with tcp reset
    ct mark ${ALLOW_MARK} accept
    ct mark ${DENY_MARK} reject with tcp reset
    ct mark ${PENDING_MARK} drop
    ct mark 0x0 ip protocol tcp tcp flags & (fin | syn | rst | ack) == syn ct mark set ${PENDING_MARK} queue num 0
  }
}
`;
}

async function readJsonLine(stream: Readable): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      stream.resume();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("bubblewrap status pipe closed before a complete status record"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function isBubblewrapStatus(value: unknown): value is BubblewrapStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Partial<BubblewrapStatus>;
  return Number.isSafeInteger(status["child-pid"])
    && Number.isSafeInteger(status["mnt-namespace"])
    && (status["net-namespace"] === undefined || Number.isSafeInteger(status["net-namespace"]))
    && (status["pid-namespace"] === undefined || Number.isSafeInteger(status["pid-namespace"]));
}

async function waitForData(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = () => {
      cleanup();
      stream.resume();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("stream closed before readiness notification"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    stream.once("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

async function waitForChild(child: ChildProcess): Promise<NetworkRunResult> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({exitCode, signal}));
  });
}

async function settleChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function formatExit(result: NetworkRunResult): string {
  return result.signal ? `signal ${result.signal}` : `exit code ${String(result.exitCode)}`;
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

function killProcess(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function writeToStream(stream: Writable, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
