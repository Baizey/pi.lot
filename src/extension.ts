import {realpathSync} from "node:fs";
import type {BashOperations, ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {createBashTool} from "@earendil-works/pi-coding-agent";
import {runSandboxedCommand, SandboxDecision, SandboxEvent} from "./bubblewrap/sandbox-runner.js";

export default function piSandboxExtension(pi: ExtensionAPI): void {
  const localBash = createBashTool(process.cwd());
  localBash.name = "bash-bubblewrap";
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const sandboxedBash = createBashTool(ctx.cwd, {
        operations: createSandboxedBashOperations(ctx),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });
}

function createSandboxedBashOperations(ctx: ExtensionContext): BashOperations {
  return {
    async exec(command, cwd, {onData, signal, timeout, env}) {
      const writableCwd = realpathSync(cwd);
      const result = await runSandboxedCommand({
        command: ["/bin/bash", "-c", command],
        cwd,
        writableRoots: [writableCwd],
        env,
        signal,
        timeoutSeconds: timeout,
        onStdout: onData,
        onStderr: onData,
        onDecisionError(error) {
          onData(Buffer.from(`[sandbox] decision=${SandboxDecision.DENY} error=${JSON.stringify(errorMessage(error))}\n`));
        },
        async decide(event) {
          const decision = await askForSandboxDecision(ctx, command, event, signal);
          onData(Buffer.from(`${formatDecision(event, decision)}\n`));
          return decision;
        },
      });

      if (result.signal) throw new Error(`sandbox adapter terminated by ${result.signal}`);
      return {exitCode: result.exitCode};
    },
  };
}

async function askForSandboxDecision(
  ctx: ExtensionContext,
  command: string,
  event: SandboxEvent,
  signal: AbortSignal | undefined,
): Promise<SandboxDecision> {
  if (!ctx.hasUI) return SandboxDecision.DENY;

  const allowed = await ctx.ui.confirm(
    `Allow sandbox ${event.operation.toLowerCase()}?`,
    [
      `Command: ${truncate(command, 500)}`,
      `System call: ${event.syscall}`,
      `Process: ${event.pid}`,
      ...event.pathAccesses.map((access) =>
        `${access.access}: ${access.path}${access.sandboxPrivate ? " (bubblewrap-private)" : ""}`,
      ),
      ...(event.destination ? [`Destination: ${event.destination}`] : []),
      ...(event.detail ? [`Detail: ${event.detail}`] : []),
      "",
      "The operation is paused in the kernel until you answer.",
    ].join("\n"),
    {signal},
  );
  return allowed ? SandboxDecision.ALLOW : SandboxDecision.DENY;
}

function formatDecision(event: SandboxEvent, decision: SandboxDecision): string {
  const resource = event.pathAccesses.length > 0
    ? ` pathAccesses=${JSON.stringify(event.pathAccesses)}`
    : event.destination
      ? ` destination=${JSON.stringify(event.destination)}`
      : "";
  return `[sandbox] sequence=${event.sequence} pid=${event.pid} decision=${decision} operation=${event.operation} syscall=${event.syscall}${resource}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
