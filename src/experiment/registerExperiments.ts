import type {BashOperations, ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {createBashTool, createBashToolDefinition} from "@earendil-works/pi-coding-agent";
import {
    NetworkAddressFamily,
    NetworkDecision,
    NetworkDecisionCoordinator,
    NetworkOperation,
    NetworkTargetKind,
    runNetworkSandboxedCommand,
} from "./network/network-runner.js";
import type {HttpRequestEvent, HttpRequestAuthorizer} from "./network/network-runner.js";
import {DEFAULT_NETWORK_POLICY_GRANULARITY} from "./network/NetworkPolicy";
import type {
    NetworkPolicyEvent,
    NetworkPolicyGranularity,
    NetworkPolicyScope,
} from "./network/NetworkPolicy";

export function registerExperiments(
    pi: ExtensionAPI,
    requireSession: () => void,
): void {
    registerBashTool(
        pi,
        "bash-network",
        "bash (Bubblewrap + network gate)",
        (ctx) => {
            requireSession();
            return createNetworkBashOperations(ctx, DEFAULT_NETWORK_POLICY_GRANULARITY);
        },
        {
            description: "Execute a bash command with approval for brokered hostname targets, direct outbound TCP or UDP targets, and each exact HTTP or HTTPS method and canonical URL. HTTPS is transparently terminated only after coarse TCP approval so the request can be held for a separate decision before any target-side connection. Approval reuse is shared across DNS/TCP/UDP operations and IPv4/IPv6 endpoint families. Unsupported opaque TCP protocols fail closed in request-aware mode. Filesystem access, environment, and local IPC retain normal host-user behavior and are not mediated by this tool. Active-flow revocation is not implemented.",
            promptSnippet: "Execute bash with network-flow and exact HTTP or HTTPS request approval while leaving filesystem and local IPC access unchanged",
            promptGuidelines: [
                "Use bash-network to catch direct IP networking and HTTP or HTTPS requests from a command and its descendants; it does not mediate filesystem access or network effects delegated through local IPC.",
            ],
        },
    );
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

function createNetworkBashOperations(
    ctx: ExtensionContext,
    granularity: NetworkPolicyGranularity,
): BashOperations {
    return {
        async exec(command, cwd, {onData, signal, timeout, env}) {
            const decisions = new NetworkDecisionCoordinator({
                granularity,
                onDecisionReuse(event, scope, decision) {
                    onData(Buffer.from(`${formatReusedNetworkDecision(event, scope, decision, command)}\n`));
                },
                async decide(event, scope, decisionSignal) {
                    const decision = await askForNetworkDecision(ctx, command, event, scope, decisionSignal);
                    onData(Buffer.from(`${formatNetworkDecision(event, scope, decision, command)}\n`));
                    return decision;
                },
            });
            const authorizeHttpRequest = createHttpRequestAuthorizer(ctx, command, onData);
            const result = await runNetworkSandboxedCommand({
                command: ["/bin/bash", "-c", command],
                cwd,
                env,
                signal,
                timeoutSeconds: timeout,
                onStdout: onData,
                onStderr: onData,
                onDecisionError(error) {
                    onData(Buffer.from(
                        `[network] decision=${NetworkDecision.DENY} error=${JSON.stringify(errorMessage(error))}\n`,
                    ));
                },
                decide(event, decisionSignal) {
                    return decisions.decide(event, decisionSignal);
                },
                authorizeHttpRequest,
            });

            if (result.signal) throw new Error(`network worker terminated by ${result.signal}`);
            return {exitCode: result.exitCode};
        },
    };
}

function createHttpRequestAuthorizer(
    ctx: ExtensionContext,
    command: string,
    onData: (data: Buffer) => void,
): HttpRequestAuthorizer {
    const decisions = new Map<string, Promise<boolean>>();
    let promptTail = Promise.resolve();
    let requestSequence = 0;

    return async (event, signal) => {
        const sequence = ++requestSequence;
        const key = `${event.method}\0${event.url}`;
        const existing = decisions.get(key);
        if (existing) {
            const allowed = await existing;
            onData(Buffer.from(`${formatHttpRequestDecision(event, sequence, allowed, command, true)}\n`));
            return allowed;
        }

        const pending = promptTail.then(() => askForHttpRequestDecision(ctx, command, event, signal));
        promptTail = pending.then(() => undefined, () => undefined);
        decisions.set(key, pending);
        try {
            const allowed = await pending;
            onData(Buffer.from(`${formatHttpRequestDecision(event, sequence, allowed, command, false)}\n`));
            return allowed;
        } catch (error) {
            decisions.delete(key);
            throw error;
        }
    };
}

async function askForHttpRequestDecision(
    ctx: ExtensionContext,
    command: string,
    event: HttpRequestEvent,
    signal: AbortSignal,
): Promise<boolean> {
    if (!ctx.hasUI || signal.aborted) return false;

    return ctx.ui.confirm(
        `Allow ${event.scheme.toUpperCase()} ${event.method}?`,
        [
            `Command: ${JSON.stringify(truncate(command, 500))}`,
            `Canonical URL: ${JSON.stringify(event.url)}`,
            `Original request target: ${JSON.stringify(event.rawTarget)}`,
            `Hostname: ${JSON.stringify(event.hostname)}`,
            `Connection family: ${familyName(event.family)}`,
            `Source: ${formatEndpoint(event.source.address, event.source.port)}`,
            `Gateway destination: ${formatEndpoint(event.destination.address, event.destination.port)}`,
            `Selected address: ${formatEndpoint(event.upstreamAddress, event.port)}`,
            `Policy scope: exact ${event.method} ${event.url}`,
            "",
            "The HTTP request is held. Allowing opens a new target-side connection and forwards this request; denying creates no target-side connection.",
        ].join("\n"),
        {signal},
    );
}

function formatHttpRequestDecision(
    event: HttpRequestEvent,
    sequence: number,
    allowed: boolean,
    command: string,
    reused: boolean,
): string {
    const decision = allowed ? NetworkDecision.ALLOW : NetworkDecision.DENY;
    const reuse = reused ? " reused=true" : "";
    return `[network] requestSequence=${sequence} decision=${decision} operation=HTTP_REQUEST scheme=${event.scheme.toUpperCase()} method=${JSON.stringify(event.method)} url=${JSON.stringify(event.url)} hostname=${JSON.stringify(event.hostname)} source=${JSON.stringify(formatEndpoint(event.source.address, event.source.port))} destination=${JSON.stringify(formatEndpoint(event.destination.address, event.destination.port))} upstream=${JSON.stringify(formatEndpoint(event.upstreamAddress, event.port))}${reuse} policyScope=${JSON.stringify(`${event.method} ${event.url}`)} command=${JSON.stringify(truncate(command, 500))}`;
}

async function askForNetworkDecision(
    ctx: ExtensionContext,
    command: string,
    event: NetworkPolicyEvent,
    scope: NetworkPolicyScope,
    signal: AbortSignal,
): Promise<NetworkDecision> {
    if (!ctx.hasUI) return NetworkDecision.DENY;

    const packetDescription = event.operation === NetworkOperation.DNS_QUERY
        ? scope.operation === "ANY" && scope.family === "ANY"
            ? "The DNS query is held; allowing authorizes this hostname across network operations, address families, and destination ports for the current command."
            : "The DNS query is held; allowing authorizes this projected DNS scope for the current command."
        : event.transport === "tcp"
            ? "The initial SYN is held; allowing releases its conntrack flow under the displayed policy scope."
            : "The first datagram is held; allowing releases its conntrack flow under the displayed policy scope.";
    const dnsContext = event.operation === NetworkOperation.DNS_QUERY
        ? [
            `DNS name: ${event.dns.name}`,
            event.dns.type === "A" || event.dns.type === "AAAA"
                ? "DNS operation: Resolve addresses (A/AAAA)"
                : `DNS record type: ${event.dns.type}`,
        ]
        : [];
    const networkContext = event.operation === NetworkOperation.DNS_QUERY
        ? [
            ...dnsContext,
            `Resolver transport: ${event.transport.toUpperCase()} over ${familyName(event.family)}`,
            `Resolver: ${formatEndpoint(event.destination.address, event.destination.port)}`,
        ]
        : [
            `Target: ${formatPolicyTarget(event)}`,
            `Connection family: ${familyName(event.family)}`,
            `Transport: ${event.transport}`,
            `Source: ${formatEndpoint(event.source.address, event.source.port)}`,
            ...(event.target.kind === NetworkTargetKind.HOSTNAME
                ? [
                    `Selected address: ${formatEndpoint(event.target.address, event.target.port)}`,
                    `Synthetic lease: ${event.target.syntheticAddress}`,
                ]
                : []),
        ];
    const allowed = await ctx.ui.confirm(
        `Allow network ${event.operation.toLowerCase()}?`,
        [
            `Command: ${JSON.stringify(truncate(command, 500))}`,
            ...networkContext,
            `Policy scope: ${formatPolicyScope(scope)}`,
            "",
            packetDescription,
        ].join("\n"),
        {signal},
    );
    return allowed ? NetworkDecision.ALLOW : NetworkDecision.DENY;
}

function formatNetworkDecision(
    event: NetworkPolicyEvent,
    scope: NetworkPolicyScope,
    decision: NetworkDecision,
    command: string,
): string {
    const commandText = JSON.stringify(truncate(command, 500));
    const policyScope = JSON.stringify(formatPolicyScope(scope));
    if (event.operation === NetworkOperation.DNS_QUERY) {
        const dns = JSON.stringify(`${event.dns.name} ${event.dns.type}`);
        const resolver = formatEndpoint(event.destination.address, event.destination.port);
        const resolverTransport = JSON.stringify(`${event.transport.toUpperCase()} over ${familyName(event.family)}`);
        return `[network] sequence=${event.sequence} decision=${decision} operation=${event.operation} dns=${dns} resolverTransport=${resolverTransport} resolver=${JSON.stringify(resolver)} policyScope=${policyScope} command=${commandText}`;
    }

    const source = formatEndpoint(event.source.address, event.source.port);
    const destination = formatEndpoint(event.target.address, event.target.port);
    const hostname = event.target.kind === NetworkTargetKind.HOSTNAME
        ? ` hostname=${JSON.stringify(event.target.hostname)} syntheticAddress=${JSON.stringify(event.target.syntheticAddress)}`
        : "";
    const familyField = event.operation === NetworkOperation.TCP_CONNECT ? "connectionFamily" : "flowFamily";
    return `[network] sequence=${event.sequence} decision=${decision} operation=${event.operation}${hostname} ${familyField}=${familyName(event.family)} transport=${event.transport} source=${JSON.stringify(source)} destination=${JSON.stringify(destination)} policyScope=${policyScope} command=${commandText}`;
}

function formatReusedNetworkDecision(
    event: NetworkPolicyEvent,
    scope: NetworkPolicyScope,
    decision: NetworkDecision,
    command: string,
): string {
    const policyScope = JSON.stringify(formatPolicyScope(scope));
    const commandText = JSON.stringify(truncate(command, 500));
    if (event.operation === NetworkOperation.DNS_QUERY) {
        const dns = JSON.stringify(`${event.dns.name} ${event.dns.type}`);
        const resolver = formatEndpoint(event.destination.address, event.destination.port);
        const resolverTransport = JSON.stringify(`${event.transport.toUpperCase()} over ${familyName(event.family)}`);
        return `[network] sequence=${event.sequence} decision=${decision} operation=${event.operation} dns=${dns} resolverTransport=${resolverTransport} resolver=${JSON.stringify(resolver)} reused=true policyScope=${policyScope} command=${commandText}`;
    }

    const source = formatEndpoint(event.source.address, event.source.port);
    const destination = formatEndpoint(event.target.address, event.target.port);
    const hostname = event.target.kind === NetworkTargetKind.HOSTNAME
        ? ` hostname=${JSON.stringify(event.target.hostname)} syntheticAddress=${JSON.stringify(event.target.syntheticAddress)}`
        : "";
    const familyField = event.operation === NetworkOperation.TCP_CONNECT ? "connectionFamily" : "flowFamily";
    return `[network] sequence=${event.sequence} decision=${decision} operation=${event.operation}${hostname} ${familyField}=${familyName(event.family)} transport=${event.transport} source=${JSON.stringify(source)} destination=${JSON.stringify(destination)} reused=true policyScope=${policyScope} command=${commandText}`;
}

function formatPolicyTarget(event: NetworkPolicyEvent): string {
    if (event.target.kind === NetworkTargetKind.HOSTNAME) {
        return event.operation === NetworkOperation.DNS_QUERY
            ? event.target.hostname
            : formatEndpoint(event.target.hostname, event.target.port);
    }
    return event.target.kind === NetworkTargetKind.LOCALHOST
        ? formatEndpoint("localhost", event.target.port)
        : formatEndpoint(event.target.address, event.target.port);
}

function formatPolicyScope(scope: NetworkPolicyScope): string {
    const target = scope.port === null ? scope.target : formatEndpoint(scope.target, scope.port);
    const dimensions = [
        scope.operation === "ANY" ? null : scope.operation,
        scope.family === "ANY"
            ? null
            : scope.family === "NONE"
                ? "family-independent"
                : familyName(scope.family),
    ].filter((dimension): dimension is string => dimension !== null);
    return dimensions.length === 0 ? target : `${target} / ${dimensions.join(" / ")}`;
}

function familyName(family: NetworkAddressFamily): string {
    return family === NetworkAddressFamily.IPV4 ? "IPv4" : "IPv6";
}

function formatEndpoint(address: string, port: number): string {
    return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
