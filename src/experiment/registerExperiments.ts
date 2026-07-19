import type {BashOperations, ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {createBashTool, createBashToolDefinition} from "@earendil-works/pi-coding-agent";
import {runFuseSandboxedCommand} from "../fuse/fuse-runner.js";
import {FuseDecision} from "../fuse/FuseFilesystem.js";
import type {FusePolicyEvent} from "../fuse/FuseFilesystem.js";
import {runNetworkSandboxedCommand, NetworkDecision} from "./network/network-runner.js";
import type {NetworkPolicyEvent} from "./network/network-runner.js";

export function registerExperiments(pi: ExtensionAPI): void {
  registerBashTool(pi, "bash-fuse", "bash (Bubblewrap + FUSE)", createFuseBashOperations);
  registerBashTool(pi, "bash-network", "bash (Bubblewrap + network gate)", createNetworkBashOperations, {
    description: "Execute a bash command with approval for direct outbound IPv4 TCP attempts. Filesystem access, environment, and local IPC retain normal host-user behavior and are not mediated by this tool. DNS, UDP, externally routed IPv6, and active revocation are not implemented.",
    promptSnippet: "Execute bash with direct IPv4 TCP approval while leaving filesystem and local IPC access unchanged",
    promptGuidelines: [
      "Use bash-network only when direct IPv4 TCP approval is needed; bash-network does not mediate filesystem access or local IPC.",
    ],
  });
}

type BashToolMetadata = {
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
};

function registerBashTool(
  pi: ExtensionAPI,
  name: string,
  label: string,
  createOperations: (ctx: ExtensionContext) => BashOperations,
  metadata: BashToolMetadata = {},
): void {
  const localBash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...localBash,
    name,
    label,
    ...metadata,
    async execute(id, params, signal, onUpdate, ctx) {
      const sandboxedBash = createBashTool(ctx.cwd, {operations: createOperations(ctx)});
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });
}

function createFuseBashOperations(ctx: ExtensionContext): BashOperations {
  return {
    async exec(command, cwd, {onData, signal, timeout, env}) {
      const result = await runFuseSandboxedCommand({
        command: ["/bin/bash", "-c", command],
        cwd,
        env,
        signal,
        timeoutSeconds: timeout,
        onStdout: onData,
        onStderr: onData,
        onDecisionError(error) {
          onData(Buffer.from(`[fuse] decision=${FuseDecision.DENY} error=${JSON.stringify(errorMessage(error))}\n`));
        },
        async decide(event) {
          const decision = await askForFuseDecision(ctx, command, event, signal);
          onData(Buffer.from(`${formatFuseDecision(event, decision)}\n`));
          return decision;
        },
      });

      if (result.signal) throw new Error(`FUSE worker terminated by ${result.signal}`);
      return {exitCode: result.exitCode};
    },
  };
}

function createNetworkBashOperations(ctx: ExtensionContext): BashOperations {
  return {
    async exec(command, cwd, {onData, signal, timeout, env}) {
      const result = await runNetworkSandboxedCommand({
        command: ["/bin/bash", "-c", command],
        cwd,
        env,
        signal,
        timeoutSeconds: timeout,
        onStdout: onData,
        onStderr: onData,
        onDecisionError(error) {
          onData(Buffer.from(`[network] decision=${NetworkDecision.DENY} error=${JSON.stringify(errorMessage(error))}\n`));
        },
        async decide(event, decisionSignal) {
          const decision = await askForNetworkDecision(ctx, command, event, decisionSignal);
          onData(Buffer.from(`${formatNetworkDecision(event, decision)}\n`));
          return decision;
        },
      });

      if (result.signal) throw new Error(`network worker terminated by ${result.signal}`);
      return {exitCode: result.exitCode};
    },
  };
}

async function askForFuseDecision(
  ctx: ExtensionContext,
  command: string,
  event: FusePolicyEvent,
  signal: AbortSignal | undefined,
): Promise<FuseDecision> {
  if (!ctx.hasUI) return FuseDecision.DENY;

  const allowed = await ctx.ui.confirm(
    `Allow FUSE ${event.operation.toLowerCase()}?`,
    [
      `Command: ${JSON.stringify(truncate(command, 500))}`,
      ...event.pathAccesses.map((access) => `${access.access}: ${access.path}`),
      "",
      "The filesystem request is paused in the kernel until you answer.",
    ].join("\n"),
    {signal},
  );
  return allowed ? FuseDecision.ALLOW : FuseDecision.DENY;
}

async function askForNetworkDecision(
  ctx: ExtensionContext,
  command: string,
  event: NetworkPolicyEvent,
  signal: AbortSignal,
): Promise<NetworkDecision> {
  if (!ctx.hasUI) return NetworkDecision.DENY;

  const allowed = await ctx.ui.confirm(
    `Allow network ${event.operation.toLowerCase()}?`,
    [
      `Command: ${JSON.stringify(truncate(command, 500))}`,
      `Protocol: ${event.protocol}`,
      `Source: ${event.source.address}:${event.source.port}`,
      `Destination: ${event.destination.address}:${event.destination.port}`,
      "",
      "The SYN is held; allowing releases that queued packet and authorizes only its conntrack flow.",
    ].join("\n"),
    {signal},
  );
  return allowed ? NetworkDecision.ALLOW : NetworkDecision.DENY;
}

function formatFuseDecision(event: FusePolicyEvent, decision: FuseDecision): string {
  return `[fuse] sequence=${event.sequence} decision=${decision} operation=${event.operation} pathAccesses=${JSON.stringify(event.pathAccesses)}`;
}

function formatNetworkDecision(event: NetworkPolicyEvent, decision: NetworkDecision): string {
  const source = `${event.source.address}:${event.source.port}`;
  const destination = `${event.destination.address}:${event.destination.port}`;
  return `[network] sequence=${event.sequence} decision=${decision} operation=${event.operation} protocol=${event.protocol} source=${JSON.stringify(source)} destination=${JSON.stringify(destination)}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
