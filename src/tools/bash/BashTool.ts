import type {BashOperations, ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {createBashTool, createBashToolDefinition} from "@earendil-works/pi-coding-agent";
import {HOST_FILESYSTEM_ROOT, withFuseFilesystem} from "../../policy/path/fuse/fuse-runner.js";
import {FuseDecision} from "../../policy/path/fuse/FuseFilesystem.js";
import {FusePathPolicyAuthorizer} from "../../policy/path/fuse/FusePathPolicyAuthorizer.js";
import type {ToolCallPathPolicyEvaluator} from "../../policy/PolicyRuntime";
import type {ToolPresentationSpec} from "../../tui/tool/ToolPresentation.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection,} from "../../tui/tool/ToolPresentation.js";
import {ToolPresentationRenderer} from "../../tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../../tui/Color.js";
import type {PilotSessionRuntimeInterface} from "../../runtime/PilotSessionRuntime";
import {runNetworkSandboxedCommand} from "../../policy/network/NetworkSandbox.js";
import {NetworkDecisionCoordinator} from "../../policy/network/NetworkPolicy.js";
import {DEFAULT_NETWORK_POLICY_GRANULARITY} from "../../policy/network/NetworkPolicy.js";
import {NetworkPolicyAuthorizer} from "../../policy/network/NetworkPolicyAuthorizer.js";
import {NetworkDecision} from "../../policy/network/network-queue-protocol.js";

const MAX_PURPOSE_LENGTH = 160;
const PURPOSE_DESCRIPTION = "A short, one-line explanation of what the command will achieve";

type FuseBashToolInput = {
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
        },
    ],
    result: {
        direction: ToolTextDirection.TAIL,
    },
} satisfies ToolPresentationSpec<FuseBashToolInput>;

export class BashTool {
    private registered = false;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly runtimeProvider: () => PilotSessionRuntimeInterface,
    ) {
    }

    register(): void {
        if (this.registered) throw new Error("FUSE bash tool is already registered");
        this.registered = true;

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
        const renderer = new ToolPresentationRenderer(BASH_PRESENTATION, {
            currentMode: () => this.runtimeProvider().toolDisplay.currentMode(),
        });
        this.pi.registerTool({
            ...bashDefinition,
            description: `${bashDefinition.description} Include a concise, one-line purpose for the command.`,
            parameters,
            prepareArguments: undefined,
            renderCall: (args, theme, context) => {
                this.runtimeProvider().toolDisplay.synchronizeExpanded(context.expanded);
                return renderer.renderCall(args, theme);
            },
            renderResult: (result, _options, theme, context) => renderer.renderResult(
                result,
                theme,
                {isError: context.isError},
            ),
            execute: async (id, params, signal, onUpdate, ctx) => {
                const runtime = this.runtimeProvider();
                const policy = runtime.policyRuntime.beginToolCall();
                const sandboxedBash = createBashTool(ctx.cwd, {
                    operations: this.createOperations(policy),
                });
                return sandboxedBash.execute(id, params, signal, onUpdate);
            },
        });
    }

    private createOperations(policy: ToolCallPathPolicyEvaluator): BashOperations {
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
                    signal,
                    timeoutSeconds: timeout,
                    onStdout: onData,
                    onStderr: onData,
                    onDecisionError: (error) => {
                        onData(Buffer.from(
                            `[pi.lot:network] decision=${NetworkDecision.DENY} error=${JSON.stringify(this.errorMessage(error))}\n`,
                        ));
                    },
                    decide: (event, decisionSignal) => decisions.decide(event, decisionSignal),
                    authorizeHttpRequest: networkAuthorizer.authorizeHttpRequest,
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
