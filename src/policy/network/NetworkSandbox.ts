import {spawn} from "node:child_process";
import type {ChildProcess} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {isIP} from "node:net";
import path from "node:path";
import {createInterface} from "node:readline";
import type {Readable, Writable} from "node:stream";
import {fileURLToPath} from "node:url";
import {
  formatNetworkQueueVerdict,
  NetworkAddressFamily,
  NetworkDecision,
  NetworkOperation,
  parseNetworkQueueMessage,
} from "./network-queue-protocol.js";
import type {NetworkQueueEvent} from "./network-queue-protocol.js";
import {
  NetworkTargetKind,
} from "./NetworkPolicy.js";
import type {NetworkPolicyEvent} from "./NetworkPolicy.js";
import {
  SyntheticDnsLeaseTable,
  SyntheticDnsProxy,
} from "./SyntheticDnsProxy.js";
import type {SyntheticDnsLease} from "./SyntheticDnsProxy.js";
import type {HttpRequestAuthorizer} from "./HttpRequestBroker.js";
import {TcpGatewayBroker} from "./TcpGatewayBroker.js";
import type {TcpGatewayApproval} from "./TcpGatewayBroker.js";
import {TlsCertificateAuthority} from "./TlsCertificateAuthority.js";
import {resolveNativeExecutable} from "../../runtime/NativeExecutable.js";

export {
  NetworkAddressFamily,
  NetworkDecision,
  NetworkOperation,
  parseNetworkQueueMessage,
} from "./network-queue-protocol.js";
export {
  NetworkDecisionCoordinator,
  NetworkPolicyProjector,
  NetworkTargetKind,
} from "./NetworkPolicy.js";
export type {
  NetworkEndpoint,
  NetworkQueueEvent,
  NetworkQueueMessage,
  NetworkTransport,
} from "./network-queue-protocol.js";
export type {HttpRequestEvent, HttpRequestAuthorizer} from "./HttpRequestBroker.js";
export type {
  NetworkHostnameFlowTarget,
  NetworkHostnameResolutionTarget,
  NetworkIpTarget,
  NetworkLocalhostTarget,
  NetworkPolicyEvent,
  NetworkPolicyGranularity,
  NetworkPolicyScope,
  NetworkPolicyTarget,
} from "./NetworkPolicy.js";

const BWRAP_PATH = "/usr/bin/bwrap";
const IP_PATH = "/usr/bin/ip";
const NFT_PATH = "/usr/sbin/nft";
const NSENTER_PATH = "/usr/bin/nsenter";
const SLIRP4NETNS_PATH = "/usr/bin/slirp4netns";
const SYSCTL_PATH = "/usr/sbin/sysctl";
const UNSHARE_PATH = "/usr/bin/unshare";

const GATEWAY_LINK = "pi-gate0";
const WORKER_LINK = "pi-work0";
const GATEWAY_IPV4 = "10.200.0.1";
const GATEWAY_IPV4_CIDR = `${GATEWAY_IPV4}/30`;
const WORKER_IPV4_CIDR = "10.200.0.2/30";
const GATEWAY_IPV6 = "fd42:7069::1";
const GATEWAY_IPV6_CIDR = `${GATEWAY_IPV6}/64`;
const WORKER_IPV6_CIDR = "fd42:7069::2/64";
const POLICY_ROUTE_TABLE = "100";

const ALLOW_MARK = "0x50490001";
const DENY_MARK = "0x50490002";
const PENDING_MARK = "0x50490003";
const DNS_ALLOW_MARK = "0x50490004";
const DNS_DENY_MARK = "0x50490005";
const TCP_GATEWAY_MARK = "0x50490006";

export type NetworkRunOptions = {
  command: string[];
  cwd: string;
  mediatedHostRoot?: string;
  env?: NodeJS.ProcessEnv;
  dnsUpstream?: {address: string; port: number};
  additionalUpstreamCa?: string;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onDecisionError?: (error: unknown) => void;
  authorizeHttpRequest?: HttpRequestAuthorizer;
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
  private outerStderr = "";
  private releaseWorker: Writable | undefined;
  private workerNamespacePid: number | undefined;
  private queueHelper: ChildProcess | undefined;
  private queueInput: Writable | undefined;
  private queueLines: ReturnType<typeof createInterface> | undefined;
  private queueReady = false;
  private pendingEvent = false;
  private lastSequence = 0;
  private readonly dnsLeases: SyntheticDnsLeaseTable;
  private dnsProxy: SyntheticDnsProxy | undefined;
  private readonly tlsCertificateAuthority: TlsCertificateAuthority | undefined;
  private readonly tcpBroker: TcpGatewayBroker;
  private tcpIngress: ChildProcess | undefined;
  private tcpIngressLines: ReturnType<typeof createInterface> | undefined;
  private slirp: ChildProcess | undefined;
  private slirpExit: Writable | undefined;
  private fatalError: unknown;
  private stopping = false;
  private aborted = false;
  private timedOut = false;
  private timeout: NodeJS.Timeout | undefined;
  private onAbort: (() => void) | undefined;
  private temporaryDirectory: string | undefined;
  private resolverFile: string | undefined;
  private resolverDestination: string | undefined;
  private nsswitchFile: string | undefined;
  private nsswitchDestination: string | undefined;
  private caBundleFile: string | undefined;

  constructor(options: NetworkRunOptions) {
    this.options = options;
    this.dnsLeases = new SyntheticDnsLeaseTable({
      install: (lease) => this.installSyntheticLease(lease),
    });
    this.tlsCertificateAuthority = options.authorizeHttpRequest
      ? new TlsCertificateAuthority()
      : undefined;
    this.tcpBroker = new TcpGatewayBroker({
      authorizeHttpRequest: options.authorizeHttpRequest,
      certificateAuthority: this.tlsCertificateAuthority,
      additionalUpstreamCa: options.additionalUpstreamCa,
      onError: (error) => this.reportDecisionError(error),
      onFatalError: (error) => this.fail(error),
    });
  }

  async run(): Promise<NetworkRunResult> {
    this.validateOptions();
    if (this.options.signal?.aborted) throw new Error("aborted");

    const [cwd, mediatedHostRoot] = await Promise.all([
      realpath(this.options.cwd),
      realpath(this.options.mediatedHostRoot ?? "/"),
    ]);
    try {
      await this.prepareRuntimeFiles();
      this.startOuterProcess(cwd, mediatedHostRoot);
      this.installCancellation();
      const status = await this.waitForBubblewrapStatus();
      this.workerNamespacePid = status["child-pid"];
      await this.completeSetupStep(this.configureNamespaceTopology(), "network namespace topology setup");
      await this.completeSetupStep(
        this.runWorkerNft(baseRuleset(this.dnsProxyPort(), this.tcpBroker.port)),
        "worker nftables setup",
      );
      const tcpIngressPort = await this.startTcpIngress();
      await this.completeSetupStep(this.configureGateway(tcpIngressPort), "gateway setup");
      await this.startQueueHelper();
      await this.startSlirp();
      await this.waitForIpv6Ready();
      this.unblockWorker();

      const outerExit = this.outerExit;
      if (!outerExit) throw new Error("network sandbox exit monitor is unavailable");
      const result = await outerExit;
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

  private async prepareRuntimeFiles(): Promise<void> {
    const temporaryDirectory = await mkdtemp(path.join("/var/tmp", "pilot-network-"));
    this.temporaryDirectory = temporaryDirectory;
    this.resolverFile = path.join(temporaryDirectory, "resolv.conf");
    this.nsswitchFile = path.join(temporaryDirectory, "nsswitch.conf");
    const managedTrust = this.tlsCertificateAuthority !== undefined || this.options.additionalUpstreamCa !== undefined;
    this.caBundleFile = managedTrust ? path.join(temporaryDirectory, "ca-bundle.pem") : undefined;
    const [hostNsswitch, hostResolver, resolverDestination, nsswitchDestination, hostCaBundle] = await Promise.all([
      readFile("/etc/nsswitch.conf", "utf8"),
      readFile("/etc/resolv.conf", "utf8"),
      realpath("/etc/resolv.conf"),
      realpath("/etc/nsswitch.conf"),
      managedTrust ? readHostCaBundle(this.options.env) : Promise.resolve(undefined),
    ]);
    this.resolverDestination = resolverDestination;
    this.nsswitchDestination = nsswitchDestination;
    const hostsEntry = /^\s*hosts\s*:.*$/m;
    const workerNsswitch = hostsEntry.test(hostNsswitch)
      ? hostNsswitch.replace(hostsEntry, "hosts:      files myhostname dns")
      : `${hostNsswitch.trimEnd()}\nhosts:      files myhostname dns\n`;
    const runtimeWrites = [
      writeFile(
        this.resolverFile,
        "nameserver 10.0.2.3\nnameserver fd00::3\noptions edns0\n",
        {mode: 0o400},
      ),
      writeFile(this.nsswitchFile, workerNsswitch, {mode: 0o400}),
    ];
    if (this.caBundleFile && hostCaBundle) {
      runtimeWrites.push(writeFile(
        this.caBundleFile,
        [
          hostCaBundle.trimEnd(),
          this.options.additionalUpstreamCa?.trim(),
          this.tlsCertificateAuthority?.certificatePem.trim(),
          "",
        ].filter((certificate): certificate is string => Boolean(certificate)).join("\n"),
        {mode: 0o400},
      ));
    }
    await Promise.all(runtimeWrites);

    this.dnsProxy = new SyntheticDnsProxy({
      upstreamAddress: this.options.dnsUpstream?.address ?? parseUpstreamDnsAddress(hostResolver),
      upstreamPort: this.options.dnsUpstream?.port,
      leases: this.dnsLeases,
      onError: (error) => this.reportDecisionError(error),
      onFatalError: (error) => this.fail(error),
    });
    await Promise.all([
      this.dnsProxy.start(),
      this.tcpBroker.start(),
    ]);
  }

  private startOuterProcess(cwd: string, mediatedHostRoot: string): void {
    if (
      !this.resolverFile
      || !this.resolverDestination
      || !this.nsswitchFile
      || !this.nsswitchDestination
    ) {
      throw new Error("network sandbox runtime configuration is not available");
    }
    const bwrapArguments = [
      "--unshare-net",
      "--unshare-pid",
      "--bind", mediatedHostRoot, "/",
      "--proc", "/proc",
      "--ro-bind", this.resolverFile, this.resolverDestination,
      "--ro-bind", this.nsswitchFile, this.nsswitchDestination,
      ...(this.caBundleFile ? ["--ro-bind", this.caBundleFile, this.caBundleFile] : []),
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

    const child = spawn(resolveNativeExecutable("pi-exec-clean-native"), [
      "4",
      UNSHARE_PATH,
      "--user", "--map-current-user", "--net", "--",
      BWRAP_PATH,
      ...bwrapArguments,
    ], {
      cwd,
      env: this.workerEnvironment(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });

    this.outerProcess = child;
    this.releaseWorker = child.stdio[4] as Writable;
    child.stdout?.on("data", (data: Buffer) => this.options.onStdout?.(data));
    child.stderr?.on("data", (data: Buffer) => {
      this.outerStderr += data.toString();
      this.options.onStderr?.(data);
    });
    this.outerExit = waitForChild(child);
  }

  private workerEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      GIT_CREDENTIAL_INTERACTIVE: "never",
      GCM_INTERACTIVE: "Never",
      GH_PROMPT_DISABLED: "1",
      SSH_ASKPASS: "/bin/false",
      SSH_ASKPASS_REQUIRE: "never",
    };
    if (!this.caBundleFile) return environment;
    return {
      ...environment,
      SSL_CERT_FILE: this.caBundleFile,
      CURL_CA_BUNDLE: this.caBundleFile,
      GIT_SSL_CAINFO: this.caBundleFile,
      NODE_EXTRA_CA_CERTS: this.caBundleFile,
      NPM_CONFIG_CAFILE: this.caBundleFile,
      REQUESTS_CA_BUNDLE: this.caBundleFile,
    };
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

  private async completeSetupStep<T>(step: Promise<T>, description: string): Promise<T> {
    if (!this.outerExit) throw new Error("network sandbox exit monitor is unavailable");
    return Promise.race([
      step,
      this.outerExit.then((result) => {
        const detail = this.outerStderr.trim();
        throw new Error(
          `network sandbox exited during ${description}: ${formatExit(result)}${detail ? `: ${detail}` : ""}`,
        );
      }),
    ]);
  }

  private async configureNamespaceTopology(): Promise<void> {
    const gatewayPid = this.gatewayPid();
    const workerPid = this.workerPid();
    await this.runNamespaceCommand(
      gatewayPid,
      IP_PATH,
      ["link", "add", GATEWAY_LINK, "type", "veth", "peer", "name", WORKER_LINK, "netns", String(workerPid)],
      "create workload gateway link",
    );
    await this.runNamespaceCommand(gatewayPid, IP_PATH, ["link", "set", "lo", "up"], "enable gateway loopback");
    await this.runNamespaceCommand(
      gatewayPid,
      IP_PATH,
      ["address", "add", GATEWAY_IPV4_CIDR, "dev", GATEWAY_LINK],
      "configure gateway IPv4 address",
    );
    await this.runNamespaceCommand(
      gatewayPid,
      IP_PATH,
      ["-6", "address", "add", GATEWAY_IPV6_CIDR, "dev", GATEWAY_LINK, "nodad"],
      "configure gateway IPv6 address",
    );
    await this.runNamespaceCommand(
      gatewayPid,
      IP_PATH,
      ["link", "set", GATEWAY_LINK, "up"],
      "enable gateway link",
    );

    await this.runNamespaceCommand(workerPid, IP_PATH, ["link", "set", "lo", "up"], "enable worker loopback");
    await this.runNamespaceCommand(
      workerPid,
      IP_PATH,
      ["address", "add", WORKER_IPV4_CIDR, "dev", WORKER_LINK],
      "configure worker IPv4 address",
    );
    await this.runNamespaceCommand(
      workerPid,
      IP_PATH,
      ["-6", "address", "add", WORKER_IPV6_CIDR, "dev", WORKER_LINK, "nodad"],
      "configure worker IPv6 address",
    );
    await this.runNamespaceCommand(workerPid, IP_PATH, ["link", "set", WORKER_LINK, "up"], "enable worker link");
    await this.runNamespaceCommand(
      workerPid,
      IP_PATH,
      ["route", "add", "default", "via", GATEWAY_IPV4, "dev", WORKER_LINK],
      "configure worker IPv4 route",
    );
    await this.runNamespaceCommand(
      workerPid,
      IP_PATH,
      ["-6", "route", "add", "default", "via", GATEWAY_IPV6, "dev", WORKER_LINK],
      "configure worker IPv6 route",
    );
  }

  private async configureGateway(tcpIngressPort: number): Promise<void> {
    await this.runNamespaceCommand(
      this.gatewayPid(),
      SYSCTL_PATH,
      [
        "-q",
        "-w",
        "net.ipv4.ip_forward=1",
        "net.ipv6.conf.all.forwarding=1",
        "net.ipv6.conf.all.accept_ra=2",
        "net.ipv6.conf.default.accept_ra=2",
        "net.ipv6.conf.all.accept_dad=0",
        "net.ipv6.conf.default.accept_dad=0",
      ],
      "enable gateway forwarding",
    );
    await this.runNamespaceCommand(
      this.gatewayPid(),
      IP_PATH,
      ["rule", "add", "priority", "100", "fwmark", TCP_GATEWAY_MARK, "table", POLICY_ROUTE_TABLE],
      "configure gateway IPv4 policy rule",
    );
    await this.runNamespaceCommand(
      this.gatewayPid(),
      IP_PATH,
      ["route", "add", "local", "0.0.0.0/0", "dev", "lo", "table", POLICY_ROUTE_TABLE],
      "configure gateway IPv4 local route",
    );
    await this.runNamespaceCommand(
      this.gatewayPid(),
      IP_PATH,
      ["-6", "rule", "add", "priority", "100", "fwmark", TCP_GATEWAY_MARK, "table", POLICY_ROUTE_TABLE],
      "configure gateway IPv6 policy rule",
    );
    await this.runNamespaceCommand(
      this.gatewayPid(),
      IP_PATH,
      ["-6", "route", "add", "local", "::/0", "dev", "lo", "table", POLICY_ROUTE_TABLE],
      "configure gateway IPv6 local route",
    );
    await this.runGatewayNft(gatewayRuleset(tcpIngressPort));
  }

  private async startTcpIngress(): Promise<number> {
    const child = spawn(NSENTER_PATH, [
      ...namespaceArguments(this.gatewayPid()),
      resolveTcpGatewayAdapter(),
      "10.0.2.2",
      String(this.tcpBroker.port),
    ], {stdio: ["ignore", "pipe", "pipe"]});
    this.tcpIngress = child;

    let stderr = "";
    let readyPort: number | undefined;
    let resolveReady!: (port: number) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => {
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
        `TCP gateway ingress exited unexpectedly: ${formatExit({exitCode: code, signal})}${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });

    const stdout = child.stdout;
    if (!stdout) throw new Error("TCP gateway ingress stdout was not created");
    this.tcpIngressLines = createInterface({input: stdout});
    this.tcpIngressLines.on("line", (line) => {
      try {
        if (readyPort !== undefined) throw new Error("TCP gateway ingress sent unexpected output after readiness");
        readyPort = parseTcpIngressReady(line);
        resolveReady(readyPort);
      } catch (error) {
        failHelper(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return ready;
  }

  private async startQueueHelper(): Promise<void> {
    const child = spawn(NSENTER_PATH, [
      ...namespaceArguments(this.workerPid()),
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
      "--enable-ipv6",
      "--disable-dns",
      "--ready-fd=3",
      "--exit-fd=4",
      String(this.gatewayPid()),
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

  private onQueueEvent(event: NetworkQueueEvent): void {
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

  private async resolveAttempt(queueEvent: NetworkQueueEvent): Promise<void> {
    let decision = NetworkDecision.DENY;
    try {
      const event = this.attributePolicyEvent(queueEvent);
      const requested = await this.options.decide(event, this.decisionAbort.signal);
      if (requested !== NetworkDecision.ALLOW && requested !== NetworkDecision.DENY) {
        throw new Error(`invalid network decision: ${String(requested)}`);
      }
      if (
        requested === NetworkDecision.ALLOW
        && queueEvent.operation === NetworkOperation.TCP_CONNECT
        && event.operation === NetworkOperation.TCP_CONNECT
        && event.target.kind !== NetworkTargetKind.LOCALHOST
      ) {
        this.tcpBroker.approve(this.tcpGatewayApproval(queueEvent, event));
      }
      decision = requested;
    } catch (error) {
      this.reportDecisionError(error);
    }

    if (this.stopping || this.decisionAbort.signal.aborted) return;
    if (!this.queueInput) throw new Error("network queue helper verdict stream is unavailable");
    await writeToStream(this.queueInput, formatNetworkQueueVerdict(queueEvent.sequence, decision));
  }

  private tcpGatewayApproval(
    queueEvent: Extract<NetworkQueueEvent, {operation: NetworkOperation.TCP_CONNECT}>,
    event: Extract<NetworkPolicyEvent, {operation: NetworkOperation.TCP_CONNECT}>,
  ): TcpGatewayApproval {
    const destination = queueEvent.destination;
    return {
      family: event.family,
      source: queueEvent.source,
      destination,
      upstream: {
        address: hostAddressForGateway(event.target.address),
        port: event.target.port,
      },
      hostname: event.target.kind === NetworkTargetKind.HOSTNAME
        ? event.target.hostname
        : undefined,
    };
  }

  private attributePolicyEvent(event: NetworkQueueEvent): NetworkPolicyEvent {
    if (event.operation === NetworkOperation.DNS_QUERY) {
      const expectedResolver = event.family === NetworkAddressFamily.IPV4 ? "10.0.2.3" : "fd00::3";
      if (event.destination.address !== expectedResolver) {
        throw new Error(`direct DNS to an untrusted resolver is denied: ${event.destination.address}`);
      }
      return {
        ...event,
        target: {kind: NetworkTargetKind.HOSTNAME, hostname: event.dns.name},
      };
    }

    const lease = this.dnsLeases.lookup(event.destination.address);
    if (lease) {
      if (lease.family !== event.family) throw new Error("synthetic DNS lease family mismatch");
      return {
        ...event,
        target: {
          kind: NetworkTargetKind.HOSTNAME,
          hostname: lease.hostname,
          port: event.destination.port,
          address: lease.realAddress,
          syntheticAddress: lease.syntheticAddress,
        },
      };
    }
    if (this.dnsLeases.isSyntheticAddress(event.destination.address)) {
      throw new Error(`expired or unknown synthetic DNS lease: ${event.destination.address}`);
    }
    return {
      ...event,
      target: {
        kind: isLoopbackAddress(event.destination.address)
          ? NetworkTargetKind.LOCALHOST
          : NetworkTargetKind.IP,
        address: event.destination.address,
        port: event.destination.port,
      },
    };
  }

  private reportDecisionError(error: unknown): void {
    try {
      this.options.onDecisionError?.(error);
    } catch {
      // Error reporting must not turn a denied flow into an allowed one.
    }
  }

  private async waitForIpv6Ready(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const addresses = await this.runNamespaceCommand(
          this.gatewayPid(),
          IP_PATH,
          ["-6", "-o", "address", "show", "dev", "tap0", "scope", "global"],
          "IPv6 readiness check",
        );
        if (addresses.includes(" inet6 fd00:") && !addresses.includes(" tentative ")) return;
      } catch (error) {
        if (
          this.aborted
          || this.timedOut
          || this.fatalError
          || !(error instanceof Error)
          || !error.message.includes('Device "tap0" does not exist')
        ) {
          throw error;
        }
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`slirp4netns did not configure IPv6 before the worker startup deadline${detail}`);
  }

  private async installSyntheticLease(lease: SyntheticDnsLease): Promise<void> {
    const rule = lease.family === NetworkAddressFamily.IPV4
      ? `add rule inet pi_network destination_nat meta l4proto udp ip daddr ${lease.syntheticAddress} dnat ip to ${lease.realAddress}\n`
      : `add rule inet pi_network destination_nat meta l4proto udp ip6 daddr ${lease.syntheticAddress} dnat ip6 to ${lease.realAddress}\n`;
    await this.runWorkerNft(rule);
  }

  private dnsProxyPort(): number {
    if (!this.dnsProxy) throw new Error("synthetic DNS proxy is unavailable");
    return this.dnsProxy.port;
  }

  private async runWorkerNft(input: string): Promise<void> {
    await this.runNamespaceCommand(
      this.workerPid(),
      NFT_PATH,
      ["-f", "-"],
      "worker nftables configuration",
      input,
    );
  }

  private async runGatewayNft(input: string): Promise<void> {
    await this.runNamespaceCommand(
      this.gatewayPid(),
      NFT_PATH,
      ["-f", "-"],
      "gateway nftables configuration",
      input,
    );
  }

  private async runNamespaceCommand(
    namespacePid: number,
    executable: string,
    arguments_: string[],
    description: string,
    input?: string,
  ): Promise<string> {
    const child = spawn(NSENTER_PATH, [
      ...namespaceArguments(namespacePid),
      executable,
      ...arguments_,
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      const detail = stderr.trim() || stdout.trim();
      const outerDetail = this.outerStderr.trim();
      throw new Error(
        `${description} failed: ${formatExit(result)}`
        + `${detail ? `: ${detail}` : ""}`
        + `${outerDetail ? `; worker: ${outerDetail}` : ""}`,
      );
    }
    return stdout;
  }

  private installCancellation(): void {
    this.onAbort = () => {
      this.aborted = true;
      this.decisionAbort.abort();
      this.terminate();
    };
    this.options.signal?.addEventListener("abort", this.onAbort, {once: true});
    if (this.options.signal?.aborted) this.onAbort();

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
    killProcess(this.tcpIngress);
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
    this.tcpIngressLines?.close();
    this.tcpIngressLines = undefined;
    this.slirpExit?.end();
    this.slirpExit = undefined;
    killProcess(this.queueHelper);
    killProcess(this.tcpIngress);
    killProcess(this.slirp);
    killProcessGroup(this.outerProcess?.pid);
    await Promise.allSettled([
      settleChild(this.queueHelper),
      settleChild(this.tcpIngress),
      settleChild(this.slirp),
      this.outerExit,
      this.dnsProxy?.close(),
      this.tcpBroker.close(),
    ]);
    this.dnsProxy = undefined;
    this.tcpIngress = undefined;
    this.workerNamespacePid = undefined;
    const temporaryDirectory = this.temporaryDirectory;
    this.temporaryDirectory = undefined;
    this.resolverFile = undefined;
    this.resolverDestination = undefined;
    this.nsswitchFile = undefined;
    this.nsswitchDestination = undefined;
    this.caBundleFile = undefined;
    if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
  }

  private gatewayPid(): number {
    const pid = this.outerProcess?.pid;
    if (!pid) throw new Error("gateway namespace process has no pid");
    return pid;
  }

  private workerPid(): number {
    const pid = this.workerNamespacePid;
    if (!pid) throw new Error("worker network namespace has no pid");
    return pid;
  }
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  return address.split(".", 1)[0] === "127";
}

function parseUpstreamDnsAddress(resolverConfiguration: string): string {
  for (const line of resolverConfiguration.split("\n")) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    if (match?.[1] && isIP(match[1]) !== 0) return match[1];
  }
  throw new Error("host resolver configuration contains no supported nameserver");
}

async function readHostCaBundle(environment: NodeJS.ProcessEnv | undefined): Promise<string> {
  const candidates = [
    environment?.SSL_CERT_FILE,
    process.env.SSL_CERT_FILE,
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const contents = await readFile(candidate, "utf8");
      if (contents.includes("-----BEGIN CERTIFICATE-----")) return contents;
    } catch {
      // Try the next host trust-bundle location.
    }
  }
  throw new Error("network sandbox could not locate a host CA bundle");
}

function resolveNetworkQueueAdapter(): string {
  const candidates = [
    fileURLToPath(new URL("../../build/pi-network-queue-native", import.meta.url)),
    fileURLToPath(new URL("../../../build/pi-network-queue-native", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function resolveTcpGatewayAdapter(): string {
  const candidates = [
    fileURLToPath(new URL("../../build/pi-tcp-gateway-native", import.meta.url)),
    fileURLToPath(new URL("../../../build/pi-tcp-gateway-native", import.meta.url)),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function parseTcpIngressReady(line: string): number {
  const fields = line.split("\t");
  if (
    fields.length !== 4
    || fields[0] !== "PI_TCP_GATEWAY"
    || fields[1] !== "1"
    || fields[2] !== "READY"
    || !fields[3]
    || !/^[1-9][0-9]*$/.test(fields[3])
  ) {
    throw new Error("TCP gateway ingress sent an invalid readiness record");
  }
  const port = Number(fields[3]);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("TCP gateway ingress sent an invalid readiness port");
  }
  return port;
}

function hostAddressForGateway(address: string): string {
  if (address === "10.0.2.2") return "127.0.0.1";
  if (address === "fd00::2") return "::1";
  return address;
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

function baseRuleset(dnsProxyPort: number, tcpBrokerPort: number): string {
  if (!Number.isSafeInteger(dnsProxyPort) || dnsProxyPort < 1 || dnsProxyPort > 65_535) {
    throw new Error("synthetic DNS proxy returned an invalid port");
  }
  if (!Number.isSafeInteger(tcpBrokerPort) || tcpBrokerPort < 1 || tcpBrokerPort > 65_535) {
    throw new Error("TCP gateway broker returned an invalid port");
  }
  return `table inet pi_network {
  chain output {
    type filter hook output priority -150; policy drop;
    oifname "lo" meta mark ${ALLOW_MARK} ct mark set ${ALLOW_MARK} accept
    oifname "lo" meta mark ${DENY_MARK} ct mark set ${DENY_MARK}
    oifname "lo" ct mark ${ALLOW_MARK} accept
    oifname "lo" ct mark ${DENY_MARK} meta l4proto tcp tcp flags & (fin | syn | rst | ack) == syn reject with tcp reset
    oifname "lo" ct mark ${DENY_MARK} meta l4proto udp reject
    oifname "lo" ct mark ${PENDING_MARK} drop
    oifname "lo" meta l4proto udp udp dport 53 reject
    oifname "lo" meta l4proto tcp tcp dport 53 reject with tcp reset
    oifname "lo" ct mark 0x0 meta l4proto tcp tcp flags & (fin | syn | rst | ack) == syn ct mark set ${PENDING_MARK} queue num 0
    oifname "lo" ct mark 0x0 meta l4proto udp ct mark set ${PENDING_MARK} queue num 0
    oifname "lo" meta l4proto tcp tcp flags & rst == rst accept
    oifname "lo" ct state related meta l4proto { icmp, ipv6-icmp } accept
    ip6 hoplimit 255 icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
    meta mark ${DNS_ALLOW_MARK} accept
    meta mark ${DNS_DENY_MARK} meta l4proto udp reject
    meta mark ${ALLOW_MARK} ct mark set ${ALLOW_MARK} accept
    meta mark ${DENY_MARK} ct mark set ${DENY_MARK}
    ct mark ${ALLOW_MARK} accept
    ct mark ${DENY_MARK} meta l4proto tcp reject with tcp reset
    ct mark ${DENY_MARK} meta l4proto udp reject
    ct mark ${PENDING_MARK} drop
    ct mark 0x0 ip daddr 10.0.2.3 udp dport 53 queue num 0
    ct mark 0x0 ip6 daddr fd00::3 udp dport 53 queue num 0
    meta l4proto udp udp dport 53 reject
    meta l4proto tcp tcp dport 53 reject with tcp reset
    ip daddr 10.0.2.2 udp dport ${dnsProxyPort} reject
    ip6 daddr fd00::2 udp dport ${dnsProxyPort} reject
    ip daddr 10.0.2.2 tcp dport ${tcpBrokerPort} reject with tcp reset
    ip6 daddr fd00::2 tcp dport ${tcpBrokerPort} reject with tcp reset
    ct mark 0x0 meta l4proto tcp tcp flags & (fin | syn | rst | ack) == syn ct mark set ${PENDING_MARK} queue num 0
    ct mark 0x0 meta l4proto udp ct mark set ${PENDING_MARK} queue num 0
  }

  chain destination_nat {
    type nat hook output priority dstnat; policy accept;
    ip daddr 10.0.2.3 udp dport 53 dnat ip to 10.0.2.2:${dnsProxyPort}
    ip6 daddr fd00::3 udp dport 53 dnat ip6 to [fd00::2]:${dnsProxyPort}
  }
}
`;
}

function gatewayRuleset(tcpIngressPort: number): string {
  if (!Number.isSafeInteger(tcpIngressPort) || tcpIngressPort < 1 || tcpIngressPort > 65_535) {
    throw new Error("TCP gateway ingress returned an invalid port");
  }
  return `table inet pi_gateway {
  chain prerouting {
    type filter hook prerouting priority mangle; policy accept;
    iifname "${GATEWAY_LINK}" meta l4proto tcp meta mark set ${TCP_GATEWAY_MARK} tproxy to :${tcpIngressPort} accept
  }

  chain input {
    type filter hook input priority filter; policy drop;
    iifname "lo" accept
    iifname "${GATEWAY_LINK}" meta mark ${TCP_GATEWAY_MARK} accept
    iifname "${GATEWAY_LINK}" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
    iifname "tap0" ct state established,related accept
    iifname "tap0" ip6 hoplimit 255 icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
    iifname "${GATEWAY_LINK}" oifname "tap0" meta l4proto udp accept
    iifname "tap0" oifname "${GATEWAY_LINK}" ct state established,related meta l4proto udp accept
    iifname "tap0" oifname "${GATEWAY_LINK}" ct state related meta l4proto { icmp, ipv6-icmp } accept
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }

  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "tap0" masquerade
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
