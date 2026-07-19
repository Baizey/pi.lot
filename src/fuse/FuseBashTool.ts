import type {BashOperations, ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {createBashTool, createBashToolDefinition} from "@earendil-works/pi-coding-agent";
import {HOST_FILESYSTEM_ROOT, runFuseSandboxedCommand} from "./fuse-runner.js";
import {FuseDecision} from "./FuseFilesystem.js";
import type {PathPolicyRuntime, PathPolicyToolCall} from "../policy/path/PathPolicyRuntime.js";
import type {UiDecisionFlowManager} from "../tui/UiDecisionFlowManager.js";
import {FusePathPolicyAuthorizer} from "./FusePathPolicyAuthorizer.js";

export type FuseBashToolRuntime = {
    pathPolicy: PathPolicyRuntime;
    decisionFlows: UiDecisionFlowManager;
};

export type FuseBashToolRuntimeProvider = {
    current(): FuseBashToolRuntime;
};

export class FuseBashTool {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: FuseBashToolRuntimeProvider,
    ) {}

    register(): void {
        if (this.registered) throw new Error("FUSE bash tool is already registered");
        this.registered = true;

        const bashDefinition = createBashToolDefinition(process.cwd());
        this.pi.registerTool({
            ...bashDefinition,
            execute: async (id, params, signal, onUpdate, ctx) => {
                const runtime = this.runtimeProvider.current();
                const policy = runtime.pathPolicy.beginToolCall();
                const sandboxedBash = createBashTool(ctx.cwd, {
                    operations: this.createOperations(policy, runtime.decisionFlows),
                });
                return sandboxedBash.execute(id, params, signal, onUpdate);
            },
        });
    }

    private createOperations(
        policy: PathPolicyToolCall,
        decisionFlows: UiDecisionFlowManager,
    ): BashOperations {
        return {
            exec: async (command, cwd, {onData, signal, timeout, env}) => {
                const authorizer = new FusePathPolicyAuthorizer({
                    backingRoot: HOST_FILESYSTEM_ROOT,
                    command,
                    decisionFlows,
                    signal,
                    policy,
                    report: (message) => onData(Buffer.from(`${message}\n`)),
                });
                const result = await runFuseSandboxedCommand({
                    command: ["/bin/bash", "-c", command],
                    cwd,
                    env,
                    signal,
                    timeoutSeconds: timeout,
                    onStdout: onData,
                    onStderr: onData,
                    onDecisionError: (error) => {
                        onData(Buffer.from(
                            `[pi.lot:fuse] decision=${FuseDecision.DENY} error=${JSON.stringify(this.errorMessage(error))}\n`,
                        ));
                    },
                    decide: (event) => authorizer.decide(event),
                });

                if (result.signal) throw new Error(`FUSE worker terminated by ${result.signal}`);
                return {exitCode: result.exitCode};
            },
        };
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
