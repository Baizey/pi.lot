import type {BashOperations, ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {createBashTool, createBashToolDefinition} from "@earendil-works/pi-coding-agent";
import {HOST_FILESYSTEM_ROOT, withFuseFilesystem} from "../../policy/path/fuse/fuse-runner";
import {FuseDecision} from "../../policy/path/fuse/FuseFilesystem";
import {FusePathPolicyAuthorizer} from "../../policy/path/fuse/FusePathPolicyAuthorizer";
import type {ToolCallPathPolicyEvaluator} from "../../policy/PolicyRuntime";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection} from "../../tui/tool/ToolPresentation";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer";
import {ThemeColor} from "../../tui/Color";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {runNetworkSandboxedCommand} from "../../policy/network/NetworkSandbox";
import {DEFAULT_NETWORK_POLICY_GRANULARITY, NetworkDecisionCoordinator} from "../../policy/network/NetworkPolicy";
import {NetworkPolicyAuthorizer} from "../../policy/network/NetworkPolicyAuthorizer";
import {NetworkDecision} from "../../policy/network/network-queue-protocol";
import type {HostCredentialIpcOptions} from "../../policy/network/ipc/HostCredentialIpc";
import {resolveToolDisplayMode} from "../../tui/tool/ToolDisplayMode";
import {ToolDisplayRows} from "../../tui/tool/ToolDisplayRows";

const MAX_PURPOSE_LENGTH = 160;
const PURPOSE_DESCRIPTION = "A short, one-line explanation of what the command will achieve";

type BashToolInput = {
    command: string;
    purpose: string;
    timeout?: number;
};

const BASH_PRESENTATION = {
    toolName: "bash",
    arguments: [
        {
            key: "purpose",
            placement: ToolArgumentPlacement.TITLE_PRIMARY,
            color: ThemeColor.text,
        },
        {
            key: "timeout",
            placement: ToolArgumentPlacement.TITLE_SECONDARY,
            format: (value) => ` (timeout ${String(value)}s)`,
            color: ThemeColor.muted,
        },
        {
            key: "command",
            layout: ToolArgumentLayout.BLOCK,
            direction: ToolTextDirection.HEAD,
            color: ThemeColor.text,
        },
    ],
    result: {
        direction: ToolTextDirection.TAIL,
    },
} satisfies ToolPresentationSpec<BashToolInput>;

export class BashTool {
    private registered = false;
    private definition: ToolDefinition<any, any> | undefined;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
        private readonly displayRows: ToolDisplayRows,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("FUSE builtin-bash tool is already registered");
        this.registered = true;
        this.pi.registerTool(this.toolDefinition());
    }

    toolDefinition(): ToolDefinition<any, any> {
        if (this.definition) return this.definition;
        const bashDefinition = createBashToolDefinition(process.cwd());
        type PurposeParameter = (typeof bashDefinition.parameters.properties)["command"] & {
            description: string;
            minLength: number;
            maxLength: number;
            pattern: string;
        };
        type Required = [...(typeof bashDefinition.parameters.required), "purpose"];
        type Properties = typeof bashDefinition.parameters.properties & {
            purpose: PurposeParameter;
        };

        // TypeBox's TString type omits schema options retained by the runtime object.
        // State the metadata contract explicitly so both the string type and its constraints are checked.
        const purposeParameter = {
            ...bashDefinition.parameters.properties.command,
            description: PURPOSE_DESCRIPTION,
            minLength: 1,
            maxLength: MAX_PURPOSE_LENGTH,
            pattern: "^[^\\r\\n]+$",
        } satisfies PurposeParameter;

        const parameters = {
            ...bashDefinition.parameters,
            properties: {...bashDefinition.parameters.properties, purpose: purposeParameter} satisfies Properties,
            required: [...bashDefinition.parameters.required, "purpose"] satisfies Required,
        };

        const presentation = new ToolPresentationRenderer(BASH_PRESENTATION);
        const definition = {
            ...bashDefinition,
            description: `${bashDefinition.description} Include a concise, one-line purpose for the command.`,
            parameters,
            prepareArguments: undefined,
            renderShell: "self",
            execute: async (id, params, signal, onUpdate, ctx) => {
                const runtime = this.runtimeProvider();
                const input = params as BashToolInput;
                const policy = runtime.policyRuntime.beginToolCall(ctx.sessionManager.getSessionId(), {
                    toolCallId: id,
                    toolName: "bash",
                    command: input.command,
                    purpose: input.purpose,
                });
                const sandboxedBash = createBashTool(ctx.cwd, {
                    operations: this.createOperations(
                        policy,
                        runtime.fullNetworkInspection,
                        runtime.hostCredentialIpc,
                    ),
                });
                return sandboxedBash.execute(id, params, signal, onUpdate);
            },

            renderCall: (args, theme, context) => {
                this.displayRows.observe("bash", args, context);
                return presentation.renderCall(
                    args,
                    theme,
                    resolveToolDisplayMode(context.expanded, context.state),
                    {isPartial: context.isPartial, isError: context.isError},
                );
            },

            renderResult: (result, options, theme, context) => presentation.renderResult(
                result,
                theme,
                {isError: context.isError},
                resolveToolDisplayMode(options.expanded, context.state),
            ),

        } as const satisfies ToolDefinition<typeof parameters, any>;

        const untyped = definition as any as ToolDefinition<typeof parameters, any>;

        this.definition = untyped;
        return untyped;
    }

    private createOperations(
        policy: ToolCallPathPolicyEvaluator,
        fullNetworkInspection: boolean,
        hostCredentialIpc?: HostCredentialIpcOptions,
    ): BashOperations {
        return {
            exec: async (command, cwd, {onData, signal, timeout, env}) => {
                const report = (message: string) => onData(Buffer.from(`${message}\n`));
                const pathAuthorizer = new FusePathPolicyAuthorizer({
                    backingRoot: HOST_FILESYSTEM_ROOT,
                    policyEvaluator: policy,
                    report,
                });
                const networkAuthorizer = new NetworkPolicyAuthorizer({policyEvaluator: policy, report});
                const decisions = new NetworkDecisionCoordinator({
                    granularity: DEFAULT_NETWORK_POLICY_GRANULARITY,
                    decide: networkAuthorizer.decide,
                });
                const result = await withFuseFilesystem({
                    cwd,
                    signal,
                    onDecisionError: (error) => {
                        onData(Buffer.from(
                            `[pi.lot:fuse] decision=${FuseDecision.DENY} error=${JSON.stringify(this.errorMessage(error))}\n`,
                        ));
                    },
                    decide: (event, decisionSignal) => pathAuthorizer.decide(event, decisionSignal),
                }, ({mediatedHostRoot, cwd: resolvedCwd}) => runNetworkSandboxedCommand({
                    command: ["/bin/bash", "-c", command],
                    cwd: resolvedCwd,
                    mediatedHostRoot,
                    env,
                    hostCredentialIpc,
                    signal,
                    timeoutSeconds: timeout,
                    onStdout: onData,
                    onStderr: onData,
                    onDecisionError: (error) => {
                        onData(Buffer.from(
                            `[pi.lot:network] decision=${NetworkDecision.DENY} error=${JSON.stringify(this.errorMessage(error))}\n`,
                        ));
                    },
                    onNetworkError: (error) => {
                        onData(Buffer.from(
                            `[pi.lot:network] error=${JSON.stringify(this.errorMessage(error))}\n`,
                        ));
                    },
                    onIpcError: (error) => {
                        onData(Buffer.from(
                            `[pi.lot:ipc] error=${JSON.stringify(this.errorMessage(error))}\n`,
                        ));
                    },
                    decide: (event, decisionSignal) => decisions.decide(event, decisionSignal),
                    authorizeHttpRequest: fullNetworkInspection
                        ? networkAuthorizer.authorizeHttpRequest
                        : undefined,
                }));

                if (result.signal) throw new Error(`network worker terminated by ${result.signal}`);
                return {exitCode: result.exitCode};
            },
        };
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
