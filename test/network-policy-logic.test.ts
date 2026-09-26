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
import {policyScopeCovers, policyScopeHierarchy} from "../src/policy/PolicyScope.js";
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

test("policy selection keeps specificity and access-type filtering independent of insertion order", () => {
    const rules = [
        policy("*", PolicyAccessType.HTTP_GET, PolicyLifetime.SESSION, PolicyResponse.DENIED, "fallback"),
        policy("example.com", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "domain"),
        policy("api.example.com", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "host"),
        policy("api.example.com/v1", PolicyAccessType.HTTP_GET, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "path"),
        policy("api.example.com/v1/users", PolicyAccessType.HTTP_POST, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "write"),
        policy("api.example.com:443/v1", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "port"),
    ];
    const cases: Array<[string, PolicyAccessType, string | undefined]> = [
        ["api.example.com/v1/users", PolicyAccessType.HTTP_GET, "path"],
        ["api.example.com/v1/users", PolicyAccessType.HTTP_POST, "write"],
        ["api.example.com/v10", PolicyAccessType.HTTP_GET, "host"],
        ["node.api.example.com/v1", PolicyAccessType.HTTP_GET, "host"],
        ["other.example.com/v1", PolicyAccessType.HTTP_GET, "domain"],
        ["api.example.com:443/v1/users", PolicyAccessType.HTTP_GET, "port"],
        ["api.example.com:8443/v1/users", PolicyAccessType.HTTP_GET, "fallback"],
        ["notexample.com", PolicyAccessType.HTTP_GET, "fallback"],
        ["api.example.com/v1", PolicyAccessType.HTTP_DELETE, undefined],
        ["api.example.com:invalid", PolicyAccessType.HTTP_GET, undefined],
    ];

    for (let offset = 0; offset < rules.length; offset++) {
        const rotated = [...rules.slice(offset), ...rules.slice(0, offset)];
        for (const ordering of [rotated, [...rotated].reverse()]) {
            const engine = new PolicyEngine(ordering);
            const before = engine.allPolicies();
            for (const [uri, accessType, reason] of cases) {
                const result = engine.evaluate(uri, accessType);
                assert.equal(result?.matchedReason, reason, `${uri} (${accessType})`);
                if (reason) {
                    const expected = before.find((rule) => rule.info[accessType]?.reason === reason)!;
                    assert.equal(result?.matchedPattern, expected.pattern);
                    assert.equal(result?.matchedStatus, expected.info[accessType]?.status);
                    assert.equal(result?.matchedLifetime, expected.info[accessType]?.lifetime);
                }
            }
            assert.deepEqual(engine.allPolicies(), before);
        }
    }
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

test("portless localhost scopes cover all ports without widening other hosts or explicit ports", () => {
    const cases: Array<[string, string, boolean]> = [
        ["localhost", "localhost", true],
        ["localhost", "localhost:1", true],
        ["localhost", "localhost:3000", true],
        ["localhost", "localhost:65535", true],
        ["LOCALHOST", "http://LOCALHOST:3000/api?ignored=true", true],
        ["localhost:3000", "localhost:3000", true],
        ["localhost:3000", "localhost:4000", false],
        ["localhost:3000", "localhost", false],
        ["localhost", "sub.localhost:3000", false],
        ["localhost", "localhost.example:3000", false],
        ["localhost", "127.0.0.1:3000", false],
        ["localhost", "0.0.0.0:3000", false],
        ["localhost", "[::1]:3000", false],
        ["localhost/api", "localhost:3000/api/users", true],
        ["localhost/api", "localhost:4000/api/users", true],
        ["localhost/api", "localhost:3000/apiary", false],
        ["localhost/api", "localhost:3000", false],
        ["localhost:3000/api", "localhost:4000/api/users", false],
        ["localhost:3000/api", "localhost/api", false],
        ["example.com", "example.com:3000", false],
        ["example.com", "sub.example.com:3000", false],
        ["example.com:3000", "sub.example.com:3000", true],
    ];
    for (const [scope, target, expected] of cases) {
        assert.equal(policyScopeCovers(PolicyAccessType.HTTP_GET, scope, target), expected, `${scope} covers ${target}`);
    }
});

test("IP policy scopes still require exact addresses and ports", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "0.0.0.0", "192.0.2.1", "[::1]", "[2001:db8::1]"]) {
        const scope = `${host}:3000`;
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, scope, scope), true);
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, host, scope), false);
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, scope, host), false);
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, scope, `${host}:4000`), false);
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, scope, "localhost:3000"), false);
    }
    assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, "127.0.0.1:3000", "127.0.0.2:3000"), false);
    assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, "[::1]:3000", "[::2]:3000"), false);
});

test("localhost port coverage rejects invalid ports and does not introduce wildcard syntax", () => {
    for (const target of ["localhost:", "localhost:0", "localhost:65536", "localhost:-1", "localhost:1.5", "localhost:invalid", "localhost:*"]) {
        assert.equal(new ParsedUri(target).isValid, false, target);
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, "localhost", target), false, target);
        assert.equal(policyScopeCovers(PolicyAccessType.TCP_ACCESS, target, "localhost:3000"), false, target);
    }
});

test("specific localhost port and path policies override all-port policies in either insertion order", () => {
    for (const [broad, narrow] of [
        [PolicyResponse.ALLOWED, PolicyResponse.DENIED],
        [PolicyResponse.DENIED, PolicyResponse.ALLOWED],
    ] as const) {
        const rules = [
            policy("localhost", PolicyAccessType.HTTP_GET, PolicyLifetime.LOCAL, broad, "all ports"),
            policy("localhost:3000", PolicyAccessType.HTTP_GET, PolicyLifetime.SESSION, narrow, "one port"),
            policy("localhost:3000/api", PolicyAccessType.HTTP_GET, PolicyLifetime.SESSION, broad, "one path"),
        ];
        for (const ordering of [rules, [...rules].reverse()]) {
            const engine = new PolicyEngine(ordering);
            assert.equal(engine.evaluate("localhost:4000/api", PolicyAccessType.HTTP_GET)?.matchedStatus, broad);
            assert.equal(engine.evaluate("localhost:3000/other", PolicyAccessType.HTTP_GET)?.matchedStatus, narrow);
            assert.equal(engine.evaluate("localhost:3000/api/users", PolicyAccessType.HTTP_GET)?.matchedReason, "one path");
            assert.equal(engine.evaluate("localhost:3000/apiary", PolicyAccessType.HTTP_GET)?.matchedReason, "one port");
            assert.equal(engine.evaluate("localhost:4000/api", PolicyAccessType.HTTP_POST), null);
        }
    }
});

test("only localhost gains an all-port parent in the policy scope hierarchy", () => {
    assert.deepEqual(
        new ParsedUri("http://LOCALHOST:3000/api/users?ignored=true").scopeHierarchy(),
        ["localhost", "localhost:3000", "localhost:3000/api", "localhost:3000/api/users"],
    );
    assert.deepEqual(policyScopeHierarchy("localhost:3000", PolicyAccessType.TCP_ACCESS), ["localhost:3000", "localhost"]);
    assert.deepEqual(policyScopeHierarchy("localhost", PolicyAccessType.TCP_ACCESS), ["localhost"]);
    assert.deepEqual(
        policyScopeHierarchy("localhost:3000/api/users", PolicyAccessType.HTTP_GET, 2),
        ["localhost:3000/api/users", "localhost"],
    );
    for (const host of ["127.0.0.1", "0.0.0.0", "[::1]", "example.com", "sub.localhost"]) {
        assert.deepEqual(policyScopeHierarchy(`${host}:3000`, PolicyAccessType.TCP_ACCESS), [`${host}:3000`]);
    }
});

test("localhost approval offers an all-port scope that can be selected", async () => {
    const ctx = {
        hasUI: true,
        mode: "rpc",
        ui: {
            async select(title: string, options: string[]): Promise<string | undefined> {
                if (title.startsWith("Network policy scope")) {
                    assert.deepEqual(options, ["localhost:3000", "localhost"]);
                    return "localhost";
                }
                if (title.startsWith("Network policy decision")) return "Allow";
                if (title.startsWith("Network policy lifetime")) return "Once";
                assert.fail(`Unexpected policy prompt: ${title}`);
            },
        },
    } as unknown as ExtensionContext;
    const flow = new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(ctx)});
    const choice = await flow.askForPolicy("localhost:3000", PolicyAccessType.TCP_ACCESS);
    assert.equal(choice.uri, "localhost");
    assert.equal(choice.status, PolicyResponse.ALLOWED);
    assert.equal(choice.lifetime, PolicyLifetime.ONCE);
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
