import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {PolicyEngine} from "../src/policy/PolicyEngine";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import type {PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import {ParsedUri, UNIVERSAL_NETWORK_POLICY_PATTERN} from "../src/policy/network/ParsedUri.js";
import type {Policy} from "../src/policy/types.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
    PolicyFallbackResponse
} from "../src/policy/types.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import {PolicyDao} from "../src/storage/PolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";

const TEST_AGENT_IDENTIFIER = "network-policy-test-agent";

function policy(
    uri: string,
    accessType: PolicyAccessType,
    lifetime: PolicyLifetime,
    status: PolicyResponse,
    reason: string,
): Policy {
    return {
        pattern: uri,
        info: {
            [accessType]: PolicyEngine.createStatus(accessType, lifetime, status, reason),
        },
    };
}

function networkPolicyDao(
    overrides: Partial<Pick<PolicyDao, "loadPolicies" | "upsertPolicies" | "deletePolicy">> = {},
): PolicyDao {
    return {
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
        ...overrides,
    } as unknown as PolicyDao;
}

function scriptedDecisionFlow(choices: PolicyChoice[]): {
    flow: PolicyDecisionFlow;
    callCount(): number;
} {
    let calls = 0;
    const flow = {
        async askForPolicy(_uri: string, accessType: PolicyAccessType): Promise<PolicyChoice> {
            const choice = choices[calls++];
            assert.ok(choice, "Unexpected network policy decision request");
            assert.equal(choice.accessType, accessType);
            return choice;
        },
    } as unknown as PolicyDecisionFlow;
    return {flow, callCount: () => calls};
}

test("a URI and access type identify one policy whose properties can be replaced", () => {
    const logic = new PolicyEngine([
        policy(
            "https://API.Example.com:0443/v1?ignored=true",
            PolicyAccessType.HTTP_GET,
            PolicyLifetime.LOCAL,
            PolicyResponse.ALLOWED,
            "initial",
        ),
    ]);

    logic.addPolicies([
        policy(
            "api.example.com:443/v1/",
            PolicyAccessType.HTTP_GET,
            PolicyLifetime.SESSION,
            PolicyResponse.DENIED,
            "replacement",
        ),
    ]);

    const snapshot = logic.allPolicies();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.pattern, "api.example.com:443/v1/");
    assert.deepEqual(snapshot[0]?.info[PolicyAccessType.HTTP_GET], {
        accessType: PolicyAccessType.HTTP_GET,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.DENIED,
        reason: "replacement",
    });
});

test("different access types coexist at one URI", () => {
    const logic = new PolicyEngine();
    logic.addPolicies([
        policy("example.com", PolicyAccessType.HTTP_GET, PolicyLifetime.SESSION, PolicyResponse.ALLOWED, "read"),
        policy("example.com", PolicyAccessType.HTTP_POST, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "write"),
    ]);

    const snapshot = logic.allPolicies();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.info[PolicyAccessType.HTTP_GET]?.reason, "read");
    assert.equal(snapshot[0]?.info[PolicyAccessType.HTTP_POST]?.reason, "write");
});

test("the most-specific hostname or path policy wins", () => {
    const logic = new PolicyEngine([
        policy("example.com", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "domain"),
        policy("api.example.com", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "host"),
        policy("api.example.com/v1", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "path"),
    ]);

    const result = logic.evaluate("https://API.EXAMPLE.COM/v1/users?ignored=true", PolicyAccessType.HTTP_GET);
    assert.equal(result?.evaluatedUri, "api.example.com/v1/users/");
    assert.equal(result?.matchedPattern, "api.example.com/v1/");
    assert.equal(result?.matchedReason, "path");

    assert.equal(
        logic.evaluate("other.example.com/resource", PolicyAccessType.HTTP_GET)?.matchedReason,
        "domain",
    );
    assert.equal(logic.evaluate("notexample.com/resource", PolicyAccessType.HTTP_GET), null);
});

test("the universal network pattern applies only after concrete valid targets", () => {
    const logic = new PolicyEngine([
        policy(
            UNIVERSAL_NETWORK_POLICY_PATTERN,
            PolicyAccessType.HTTP_GET,
            PolicyLifetime.SESSION,
            PolicyResponse.ALLOWED,
            "fallback",
        ),
        policy(
            "example.com",
            PolicyAccessType.HTTP_GET,
            PolicyLifetime.SESSION,
            PolicyResponse.DENIED,
            "specific",
        ),
    ]);

    assert.equal(logic.evaluate("other.example", PolicyAccessType.HTTP_GET)?.matchedReason, "fallback");
    assert.equal(logic.evaluate("example.com", PolicyAccessType.HTTP_GET)?.matchedReason, "specific");
    assert.equal(logic.evaluate("example.com:invalid", PolicyAccessType.HTTP_GET), null);
    assert.equal(logic.evaluate(UNIVERSAL_NETWORK_POLICY_PATTERN, PolicyAccessType.HTTP_GET), null);
});

test("ports are exact and path scopes respect segment boundaries", () => {
    const logic = new PolicyEngine([
        policy("example.com:443", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "port"),
        policy("api.example.com:443/v1", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "path"),
    ]);

    assert.equal(logic.evaluate("api.example.com:443/other", PolicyAccessType.HTTP_GET)?.matchedReason, "port");
    assert.equal(logic.evaluate("api.example.com:444/other", PolicyAccessType.HTTP_GET), null);
    assert.equal(logic.evaluate("api.example.com:443/v1/users", PolicyAccessType.HTTP_GET)?.matchedReason, "path");
    assert.equal(logic.evaluate("api.example.com:443/v10", PolicyAccessType.HTTP_GET)?.matchedReason, "port");
});

test("IPv6 policy targets retain bracketed ports", () => {
    const logic = new PolicyEngine([
        policy(
            "[2001:db8::8]:443",
            PolicyAccessType.TCP_ACCESS,
            PolicyLifetime.SESSION,
            PolicyResponse.ALLOWED,
            "IPv6 endpoint",
        ),
    ]);

    const result = logic.evaluate("[2001:db8::8]:443", PolicyAccessType.TCP_ACCESS);
    assert.equal(result?.evaluatedUri, "[2001:db8::8]:443");
    assert.equal(result?.matchedPattern, "[2001:db8::8]:443");
    assert.equal(logic.evaluate("[2001:db8::8]:80", PolicyAccessType.TCP_ACCESS), null);
});

test("deletion is per access type and persistence includes only local and global policies", () => {
    const logic = new PolicyEngine([
        policy("example.com", PolicyAccessType.HTTP_GET, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "get"),
        policy("example.com", PolicyAccessType.HTTP_POST, PolicyLifetime.SESSION, PolicyResponse.DENIED, "post"),
        policy("other.example", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "local"),
        policy("once.example", PolicyAccessType.HTTP_GET, PolicyLifetime.ONCE, PolicyResponse.ALLOWED, "once"),
    ]);

    logic.removePolicies([{uri: "HTTPS://EXAMPLE.COM", accessTypes: [PolicyAccessType.HTTP_GET]}]);
    assert.equal(logic.evaluate("example.com", PolicyAccessType.HTTP_GET), null);
    assert.equal(logic.evaluate("example.com", PolicyAccessType.HTTP_POST)?.matchedReason, "post");

    assert.deepEqual(
        logic.persistedPolicies().map((item) => item.pattern),
        ["other.example"],
    );
});

test("local and global network policies round-trip through SQLite", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-network-policy-dao-"));
    const database = SqliteDatabase.test(false, path.join(directory, "policies.sqlite"));

    try {
        const saved = new PolicyEngine([
            policy(
                "api.example.com/v1",
                PolicyAccessType.HTTP_GET,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "local get",
            ),
            policy(
                "api.example.com/v1",
                PolicyAccessType.HTTP_POST,
                PolicyLifetime.GLOBAL,
                PolicyResponse.DENIED,
                "global post",
            ),
            policy(
                "api.example.com/v1",
                PolicyAccessType.HTTP_DELETE,
                PolicyLifetime.SESSION,
                PolicyResponse.DENIED,
                "session delete",
            ),
        ]);
        const dao = new PolicyDao(database);
        dao.initializeSchema();
        dao.upsertPolicies(saved.persistedPolicies());

        const loaded = new PolicyEngine(dao.loadPolicies());
        assert.equal(
            loaded.evaluate("api.example.com/v1/resource", PolicyAccessType.HTTP_GET)?.matchedLifetime,
            PolicyLifetime.LOCAL,
        );
        assert.equal(
            loaded.evaluate("api.example.com/v1/resource", PolicyAccessType.HTTP_POST)?.matchedLifetime,
            PolicyLifetime.GLOBAL,
        );
        assert.equal(
            loaded.evaluate("api.example.com/v1/resource", PolicyAccessType.HTTP_DELETE),
            null,
        );
    } finally {
        database.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("session runtime loads persisted network policies from its database", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-network-policy-runtime-"));
    const databaseFile = path.join(directory, "pilot.sqlite");
    const ctx = {
        cwd: directory,
        hasUI: false,
        mode: "print",
        ui: {},
        sessionManager: {getSessionId: () => TEST_AGENT_IDENTIFIER},
    } as unknown as ExtensionContext;
    let runtime: PilotSessionRuntime | null = null;

    try {
        const setupDatabase = SqliteDatabase.test(false, databaseFile);
        const dao = new PolicyDao(setupDatabase);
        dao.initializeSchema();
        dao.upsertPolicies([
            policy(
                "persistent.example/api",
                PolicyAccessType.HTTP_GET,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "remembered",
            ),
        ]);
        setupDatabase.close();

        runtime = new PilotSessionRuntime(ctx, {
            openDatabase: () => SqliteDatabase.test(false, databaseFile),
            policyDefaultsStore: {
                load: () => structuredClone(initialPolicyDefaults), save() {
                }
            },
        });
        const result = await runtime.policyRuntime.beginToolCall(TEST_AGENT_IDENTIFIER)(
            "https://persistent.example/api/resource",
            PolicyAccessType.HTTP_GET,
        );
        assert.equal(result.matchedLifetime, PolicyLifetime.LOCAL);
        assert.equal(result.matchedReason, "remembered");
    } finally {
        await runtime?.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("network policy decisions use network-specific prompts", async () => {
    const titles: string[] = [];
    const ctx = {
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(title: string, options: string[]): Promise<string | undefined> {
                titles.push(title);
                if (title.startsWith("Network policy scope")) return options[0];
                if (title.startsWith("Network policy decision")) return "Allow";
                if (title.startsWith("Network policy lifetime")) return "Once";
                return undefined;
            },
        },
    } as unknown as ExtensionContext;
    const flow = new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)});

    const choice = await flow.askForPolicy("example.com:443", PolicyAccessType.TCP_ACCESS);

    assert.equal(choice.status, PolicyResponse.ALLOWED);
    assert.equal(choice.lifetime, PolicyLifetime.ONCE);
    assert.equal(titles.length, 3);
    assert.equal(titles.every((title) => title.startsWith("Network policy")), true);
});

test("runtime policy ownership follows tool-call, session, and persistent lifetimes", async () => {
    let persisted: Policy[] = [];
    const decisions = scriptedDecisionFlow([
        {
            uri: "once.example",
            accessType: PolicyAccessType.HTTP_GET,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "once",
        },
        {
            uri: "once.example",
            accessType: PolicyAccessType.HTTP_GET,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.DENIED,
            reason: "second call",
        },
        {
            uri: "session.example",
            accessType: PolicyAccessType.HTTP_POST,
            lifetime: PolicyLifetime.SESSION,
            status: PolicyResponse.DENIED,
            reason: "session",
        },
        {
            uri: "local.example",
            accessType: PolicyAccessType.HTTP_GET,
            lifetime: PolicyLifetime.LOCAL,
            status: PolicyResponse.ALLOWED,
            reason: "local",
        },
    ]);
    const runtime = new PolicyRuntime(TEST_AGENT_IDENTIFIER, networkPolicyDao({
        loadPolicies: () => structuredClone(persisted),
        upsertPolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    }), decisions.flow);
    runtime.setDefaultResponse(PolicyArea.web_read, PolicyFallbackResponse.ask_user);
    const firstCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER);
    const secondCall = runtime.beginToolCall(TEST_AGENT_IDENTIFIER);

    assert.equal((await firstCall("once.example", PolicyAccessType.HTTP_GET)).matchedLifetime, PolicyLifetime.ONCE);
    assert.equal((await firstCall("once.example", PolicyAccessType.HTTP_GET)).matchedReason, "once");
    assert.equal((await secondCall("once.example", PolicyAccessType.HTTP_GET)).matchedReason, "second call");

    assert.equal(
        (await firstCall("session.example", PolicyAccessType.HTTP_POST)).matchedLifetime,
        PolicyLifetime.SESSION,
    );
    assert.equal(
        (await secondCall("session.example", PolicyAccessType.HTTP_POST)).matchedLifetime,
        PolicyLifetime.SESSION,
    );
    assert.deepEqual(persisted, []);

    const recorded = await firstCall("local.example", PolicyAccessType.HTTP_GET);
    assert.equal(recorded.resolutionSource, PolicyResolutionSource.NEW_USER_DECISION);
    assert.equal(decisions.callCount(), 4);

    const nextSessionDecisions = scriptedDecisionFlow([{
        uri: "session.example",
        accessType: PolicyAccessType.HTTP_POST,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "new session",
    }]);
    const nextSession = new PolicyRuntime(TEST_AGENT_IDENTIFIER, networkPolicyDao({
        loadPolicies: () => structuredClone(persisted),
    }), nextSessionDecisions.flow);
    nextSession.setDefaultResponse(PolicyArea.web_read, PolicyFallbackResponse.ask_user);
    assert.equal(
        (
            await nextSession.beginToolCall(TEST_AGENT_IDENTIFIER)("local.example", PolicyAccessType.HTTP_GET)
        ).matchedLifetime,
        PolicyLifetime.LOCAL,
    );
    assert.equal(
        (
            await nextSession.beginToolCall(TEST_AGENT_IDENTIFIER)("session.example", PolicyAccessType.HTTP_POST)
        ).matchedReason,
        "new session",
    );
});

test("URI scope hierarchy is ordered from broadest to most specific", () => {
    assert.deepEqual(
        new ParsedUri("https://api.example.com/v1/users?ignored=true").scopeHierarchy(),
        ["com", "example.com", "api.example.com", "api.example.com/v1", "api.example.com/v1/users"],
    );
});
