import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, statSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {
    PolicyApprovalReviewSource,
    type AgentPolicyApprovalRequest,
} from "../src/policy/AgentPolicyDecisionFlow.js";
import {
    PolicyApprovalAuditLog,
    type PolicyApprovalAuditRecord,
} from "../src/policy/PolicyApprovalAuditLog.js";
import {PolicyEngine} from "../src/policy/PolicyEngine.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import type {PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
} from "../src/policy/types.js";

const SESSION = "approval-audit-session";

function policyDao() {
    return {
        initializeSchema() {
        },
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
    };
}

function noUserDecision(): any {
    return {
        async askForPolicy(): Promise<PolicyChoice> {
            assert.fail("The request must not reach the user");
        },
    };
}

test("ask_llm approvals append session-named JSON lines under the audit logs directory", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-approval-audit-"));
    const records: PolicyApprovalAuditRecord[] = [];
    const target = path.join(directory, "output.txt");
    try {
        const runtime = new PolicyRuntime(
            SESSION,
            policyDao(),
            noUserDecision(),
            undefined,
            undefined,
            {append: (record) => records.push(structuredClone(record))},
        );
        runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_llm);
        runtime.setAgentDecisionFlow({
            async askForPolicy(request: AgentPolicyApprovalRequest) {
                return {
                    uri: request.allowedScopes[0]!,
                    accessType: request.accessType,
                    lifetime: PolicyLifetime.ONCE,
                    status: PolicyResponse.ALLOWED,
                    reason: "The output is required by the active task.",
                };
            },
        });

        const result = await runtime.beginToolCall(SESSION, {
            toolCallId: "write-audit-1",
            toolName: "write",
            command: `write ${target}`,
            purpose: "Create the requested output",
        })(target, PolicyAccessType.FS_WRITE);

        assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.route, PolicyApprovalReviewSource.POLICY_DEFAULT_ASK_LLM);
        assert.equal(records[0]?.outcome, "DECIDED");
        assert.equal(records[0]?.sessionIdentifier, SESSION);
        assert.equal(records[0]?.requester.agentIdentifier, SESSION);
        assert.equal(records[0]?.operation.toolCall.command, `write ${target}`);
        assert.equal(records[0]?.decision.status, PolicyResponse.ALLOWED);
        assert.equal(
            records[0]?.result.resolutionSource,
            PolicyResolutionSource.NEW_DEFAULT_LLM_DECISION,
        );

        const logger = new PolicyApprovalAuditLog(SESSION, path.join(directory, "logs"));
        logger.append(records[0]!);
        logger.append({...records[0]!, timestamp: new Date().toISOString()});

        assert.equal(logger.file, path.join(directory, "logs", `${SESSION}.log`));
        const lines = readFileSync(logger.file, "utf8").trim().split("\n");
        assert.equal(lines.length, 2);
        assert.deepEqual(JSON.parse(lines[0]!), records[0]);
        assert.equal(statSync(path.dirname(logger.file)).mode & 0o777, 0o700);
        assert.equal(statSync(logger.file).mode & 0o777, 0o600);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("user and super-agent decisions are recorded with their distinct routes", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-approval-audit-routes-"));
    const records: PolicyApprovalAuditRecord[] = [];
    const audit = {append: (record: PolicyApprovalAuditRecord) => records.push(structuredClone(record))};
    const longUserReason = "x".repeat(10_000);
    try {
        const userTarget = path.join(directory, "user.txt");
        const userRuntime = new PolicyRuntime(
            "user-audit-session",
            policyDao(),
            {
                async askForPolicy(_uri: string, accessType: PolicyAccessType): Promise<PolicyChoice> {
                    return {
                        uri: userTarget,
                        accessType,
                        lifetime: PolicyLifetime.ONCE,
                        status: PolicyResponse.DENIED,
                        reason: longUserReason,
                    };
                },
            } as any,
            undefined,
            undefined,
            audit,
        );
        userRuntime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);
        await userRuntime.beginToolCall("user-audit-session")(
            userTarget,
            PolicyAccessType.FS_WRITE,
        );

        const authorityTarget = path.join(directory, "authority");
        const childTarget = path.join(authorityTarget, "file.ts");
        const authorityRuntime = new PolicyRuntime(
            "authority-audit-session",
            {
                ...policyDao(),
                loadPolicies: () => [{
                    pattern: authorityTarget,
                    info: {
                        [PolicyAccessType.FS_READ]: PolicyEngine.createStatus(
                            PolicyAccessType.FS_READ,
                            PolicyLifetime.LOCAL,
                            PolicyResponse.ALLOWED,
                            "Workspace authority",
                        ),
                    },
                }],
            },
            noUserDecision(),
            undefined,
            undefined,
            audit,
        );
        authorityRuntime.setAgentDecisionFlow({
            async askForPolicy(request) {
                return {
                    uri: request.allowedScopes[0]!,
                    accessType: request.accessType,
                    lifetime: PolicyLifetime.ONCE,
                    status: PolicyResponse.ALLOWED,
                    reason: "The child needs this exact read.",
                };
            },
        });
        authorityRuntime.registerPolicyPrincipal("child", "authority-audit-session", []);
        await authorityRuntime.beginToolCall("child")(childTarget, PolicyAccessType.FS_READ);

        assert.equal(records.length, 2);
        assert.equal(records[0]?.route, "USER");
        assert.equal(records[0]?.decision.status, PolicyResponse.DENIED);
        assert.equal(records[0]?.decision.reason.length, 2_000);
        assert.equal(records[0]?.result.reason.length, 2_000);
        assert.equal(records[1]?.route, PolicyApprovalReviewSource.ANCESTOR_AUTHORITY);
        assert.equal(records[1]?.routingOwner, "authority-audit-session");
        assert.equal(records[1]?.authority?.kind, "ANCESTOR_AUTHORITY");
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("PilotSessionRuntime wires approvals to the default file logger", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-approval-audit-runtime-"));
    const sessionIdentifier = "production-audit-session";
    const databaseFile = path.join(directory, "pilot.sqlite");
    const auditDirectory = path.join(directory, "logs");
    const target = path.join(directory, "approved.txt");
    const ctx = {
        cwd: directory,
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(title: string, options: string[]) {
                if (title.startsWith("Path policy scope")) return options[0];
                if (title.startsWith("Path policy decision")) return "Allow";
                if (title.startsWith("Path policy lifetime")) return "Once";
                return undefined;
            },
        },
        sessionManager: {getSessionId: () => sessionIdentifier},
    } as unknown as ExtensionContext;
    let runtime: PilotSessionRuntime | undefined;
    try {
        runtime = new PilotSessionRuntime(ctx, {
            openDatabase: () => SqliteDatabase.test(false, databaseFile),
            policyDefaultsStore: {
                load: () => ({
                    ...initialPolicyDefaults,
                    fs_write: PolicyFallbackResponse.ask_user,
                }),
                save() {
                },
            },
            credentialIpcConfigStore: {load: () => ({})},
            approvalAuditDirectory: auditDirectory,
        });

        const result = await runtime.policyRuntime.beginToolCall(sessionIdentifier, {
            toolCallId: "runtime-write-1",
            toolName: "write",
            purpose: "Prove production audit wiring",
        })(target, PolicyAccessType.FS_WRITE);

        assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
        const file = path.join(auditDirectory, `${sessionIdentifier}.log`);
        const records = readFileSync(file, "utf8").trim().split("\n").map((line) => (
            JSON.parse(line) as PolicyApprovalAuditRecord
        ));
        assert.equal(records.length, 1);
        assert.equal(records[0]?.route, "USER");
        assert.equal(records[0]?.operation.toolCall.purpose, "Prove production audit wiring");
    } finally {
        await runtime?.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("audit logger failures do not change policy decisions", async () => {
    const target = path.join(os.tmpdir(), "pilot-approval-audit-failure", "file.ts");
    const runtime = new PolicyRuntime(
        "audit-failure-session",
        policyDao(),
        {
            async askForPolicy(_uri: string, accessType: PolicyAccessType): Promise<PolicyChoice> {
                return {
                    uri: target,
                    accessType,
                    lifetime: PolicyLifetime.ONCE,
                    status: PolicyResponse.ALLOWED,
                    reason: "User approved despite unavailable audit storage.",
                };
            },
        } as any,
        undefined,
        undefined,
        {append: () => { throw new Error("disk unavailable"); }},
    );
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);

    const result = await runtime.beginToolCall("audit-failure-session")(
        target,
        PolicyAccessType.FS_WRITE,
    );

    assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
    assert.equal(result.matchedReason, "User approved despite unavailable audit storage.");
});

test("unsafe session identifiers cannot escape the logs directory", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-approval-audit-name-"));
    try {
        const logger = new PolicyApprovalAuditLog("../../outside/session", directory);
        assert.equal(path.dirname(logger.file), directory);
        assert.match(path.basename(logger.file), /^_+outside_session-[a-f0-9]{12}\.log$/);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
