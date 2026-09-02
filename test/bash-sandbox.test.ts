import assert from "node:assert/strict";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {NetworkPolicyAuthorizer} from "../src/policy/network/NetworkPolicyAuthorizer.js";
import {NetworkDecisionCoordinator, DEFAULT_NETWORK_POLICY_GRANULARITY} from "../src/policy/network/NetworkPolicy.js";
import {runNetworkSandboxedCommand} from "../src/policy/network/NetworkSandbox.js";
import {withNativeFuseFilesystem} from "../src/policy/path/native/native-fuse-runner.js";
import {
    NativeFilesystemPolicyBase,
    NativeFilesystemPolicyView,
} from "../src/policy/path/native/NativeFilesystemPolicyView.js";
import {NativeFuseSessionBroker} from "../src/policy/path/native/NativeFuseSessionBroker.js";
import type {ToolCallPathPolicyEvaluator} from "../src/policy/PolicyRuntime.js";
import type {Policy} from "../src/policy/types.js";
import {PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse, PolicyResult} from "../src/policy/types.js";

test("one sandbox mediates the complete host filesystem and outbound network", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pilot-combined-sandbox-"));
    const deniedFile = path.join(workspace, "blocked.txt");
    const socketPath = path.join(workspace, "host-agent.sock");
    const server = createServer((socket) => {
        socket.once("data", () => {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
        });
    });
    const agentServer = createServer((socket) => {
        socket.once("data", () => {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nAGENT");
        });
    });
    await Promise.all([
        new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        }),
        new Promise<void>((resolve, reject) => {
            agentServer.once("error", reject);
            agentServer.listen(socketPath, resolve);
        }),
    ]);
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const evaluatedAccessTypes: PolicyAccessType[] = [];
    const output: Buffer[] = [];
    const report = (message: string) => output.push(Buffer.from(`${message}\n`));
    const oncePolicies: Policy[] = [];
    const evaluator: ToolCallPathPolicyEvaluator = async (uri, accessType) => {
        evaluatedAccessTypes.push(accessType);
        const status = accessType === PolicyAccessType.FS_WRITE
            ? PolicyResponse.DENIED
            : PolicyResponse.ALLOWED;
        if (accessType === PolicyAccessType.FS_WRITE) {
            oncePolicies.push(policy(uri, accessType, status));
        }
        return policyResult(uri, accessType, status);
    };
    const policyBase = new NativeFilesystemPolicyBase("combined-sandbox-test", () => [{
        policies: [policy("/", PolicyAccessType.FS_READ, PolicyResponse.ALLOWED)],
        resolutionSource: PolicyResolutionSource.SYSTEM,
    }]);
    const policyView = new NativeFilesystemPolicyView(
        policyBase,
        evaluator,
        () => ({
            policies: structuredClone(oncePolicies),
            resolutionSource: PolicyResolutionSource.SYSTEM,
        }),
        () => undefined,
    );
    const broker = new NativeFuseSessionBroker();
    const networkAuthorizer = new NetworkPolicyAuthorizer({policyEvaluator: evaluator, report});
    const networkDecisions = new NetworkDecisionCoordinator({
        granularity: DEFAULT_NETWORK_POLICY_GRANULARITY,
        decide: networkAuthorizer.decide,
    });

    try {
        await broker.start();
        const result = await withNativeFuseFilesystem({
            cwd: workspace,
            policyView,
            sessionBroker: broker,
            onPolicyDeny: report,
        }, ({mediatedHostRoot, cwd}) => runNetworkSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    "unshare --user --map-current-user --net -- /bin/true || exit 92",
                    "for descriptor in /proc/$$/fd/*; do if [ \"$(readlink \"$descriptor\")\" = /dev/fuse ]; then echo LEAKED_FUSE_FD; exit 91; fi; done",
                    `printf blocked > ${shellQuote(deniedFile)}`,
                    `curl --noproxy '*' --silent http://10.0.2.2:${address.port}`,
                    "curl --unix-socket \"$SSH_AUTH_SOCK\" --silent http://localhost",
                ].join("; "),
            ],
            cwd,
            mediatedHostRoot,
            env: {...process.env, SSH_AUTH_SOCK: socketPath},
            hostCredentialIpc: {
                unixSockets: [{id: "test-agent", environment: "SSH_AUTH_SOCK"}],
            },
            timeoutSeconds: 15,
            onStdout: (data) => output.push(data),
            onStderr: (data) => output.push(data),
            decide: (event, signal) => networkDecisions.decide(event, signal),
            authorizeHttpRequest: networkAuthorizer.authorizeHttpRequest,
        }));

        assert.equal(result.exitCode, 0);
        assert.equal(existsSync(deniedFile), false);
        assert.match(Buffer.concat(output).toString(), /ACCESS DENIED/);
        assert.match(Buffer.concat(output).toString(), /OK/);
        assert.match(Buffer.concat(output).toString(), /AGENT/);
        assert.doesNotMatch(Buffer.concat(output).toString(), /LEAKED_FUSE_FD/);
        assert.equal(evaluatedAccessTypes.includes(PolicyAccessType.FS_WRITE), true);
        assert.equal(evaluatedAccessTypes.includes(PolicyAccessType.TCP_ACCESS), true);
        assert.equal(evaluatedAccessTypes.includes(PolicyAccessType.HTTP_GET), true);
    } finally {
        policyView.close();
        policyBase.close();
        await Promise.all([
            broker.close(),
            new Promise<void>((resolve) => server.close(() => resolve())),
            new Promise<void>((resolve) => agentServer.close(() => resolve())),
        ]);
        rmSync(workspace, {recursive: true, force: true});
    }
});

function policy(
    pattern: string,
    accessType: PolicyAccessType,
    status: PolicyResponse,
): Policy {
    return {
        pattern,
        info: {
            [accessType]: {
                accessType,
                lifetime: PolicyLifetime.ONCE,
                status,
                reason: "combined sandbox test",
            },
        },
    };
}

function policyResult(
    uri: string,
    accessType: PolicyAccessType,
    status: PolicyResponse,
): PolicyResult {
    return PolicyResult.of({
        evaluatedUri: uri,
        evaluatedAccessType: accessType,
        matchedPattern: uri,
        matchedLifetime: PolicyLifetime.ONCE,
        matchedStatus: status,
        matchedReason: "test",
        resolutionSource: PolicyResolutionSource.SYSTEM,
    });
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
