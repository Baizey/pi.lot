import assert from "node:assert/strict";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {NetworkPolicyAuthorizer} from "../src/policy/network/NetworkPolicyAuthorizer.js";
import {NetworkDecisionCoordinator, DEFAULT_NETWORK_POLICY_GRANULARITY} from "../src/policy/network/NetworkPolicy.js";
import {runNetworkSandboxedCommand} from "../src/policy/network/NetworkSandbox.js";
import {FusePathPolicyAuthorizer} from "../src/policy/path/fuse/FusePathPolicyAuthorizer.js";
import {withFuseFilesystem} from "../src/policy/path/fuse/fuse-runner.js";
import type {ToolCallPathPolicyEvaluator} from "../src/policy/PolicyRuntime.js";
import {PolicyAccessType, PolicyLifetime, PolicyResolutionSource, PolicyResponse, PolicyResult} from "../src/policy/types.js";

test("one sandbox mediates the complete host filesystem and outbound network", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pilot-combined-sandbox-"));
    const deniedFile = path.join(workspace, "blocked.txt");
    const server = createServer((socket) => {
        socket.once("data", () => {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const evaluatedAccessTypes: PolicyAccessType[] = [];
    const output: Buffer[] = [];
    const report = (message: string) => output.push(Buffer.from(`${message}\n`));
    const evaluator: ToolCallPathPolicyEvaluator = async (uri, accessType) => {
        evaluatedAccessTypes.push(accessType);
        return policyResult(
            uri,
            accessType,
            accessType === PolicyAccessType.FS_WRITE ? PolicyResponse.DENIED : PolicyResponse.ALLOWED,
        );
    };
    const pathAuthorizer = new FusePathPolicyAuthorizer({
        backingRoot: "/",
        policyEvaluator: evaluator,
        report,
    });
    const networkAuthorizer = new NetworkPolicyAuthorizer({policyEvaluator: evaluator, report});
    const networkDecisions = new NetworkDecisionCoordinator({
        granularity: DEFAULT_NETWORK_POLICY_GRANULARITY,
        decide: networkAuthorizer.decide,
    });

    try {
        const result = await withFuseFilesystem({
            cwd: workspace,
            decide: (event, signal) => pathAuthorizer.decide(event, signal),
        }, ({mediatedHostRoot, cwd}) => runNetworkSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                `printf blocked > ${shellQuote(deniedFile)}; curl --noproxy '*' --silent http://10.0.2.2:${address.port}`,
            ],
            cwd,
            mediatedHostRoot,
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
        assert.equal(evaluatedAccessTypes.includes(PolicyAccessType.FS_WRITE), true);
        assert.equal(evaluatedAccessTypes.includes(PolicyAccessType.TCP_ACCESS), true);
        assert.equal(evaluatedAccessTypes.includes(PolicyAccessType.HTTP_GET), true);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(workspace, {recursive: true, force: true});
    }
});

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
