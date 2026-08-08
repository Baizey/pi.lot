import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {NetworkPolicyLogic} from "../src/policy/network/NetworkPolicyLogic.js";
import {NetworkPolicyRuntime} from "../src/policy/network/NetworkPolicyRuntime.js";
import {NetworkPolicyDecisionFlow} from "../src/policy/network/NetworkPolicyDecisionFlow.js";
import type {NetworkPolicyChoice} from "../src/policy/network/NetworkPolicyDecisionFlow.js";
import {ParsedUri} from "../src/policy/network/ParsedUri.js";
import {NetworkAccessType} from "../src/policy/network/types.js";
import type {NetworkPolicy} from "../src/policy/network/types.js";
import {sanitizeNetworkPolicySnapshot} from "../src/policy/network/validation.js";
import {PolicyLifetime, PolicyResolutionSource, PolicyResponse} from "../src/policy/types.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import {NetworkPolicyDao} from "../src/storage/NetworkPolicyDao.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

function policy(
    uri: string,
    accessType: NetworkAccessType,
    lifetime: PolicyLifetime,
    status: PolicyResponse,
    reason: string,
): NetworkPolicy {
    return {
        uri,
        info: {
            [accessType]: NetworkPolicyLogic.createStatus(accessType, lifetime, status, reason),
        },
    };
}

function networkPolicyDao(
    overrides: Partial<Pick<NetworkPolicyDao, "loadPolicies" | "upsertPolicies" | "deletePolicy">> = {},
): NetworkPolicyDao {
    return {
        loadPolicies: () => [],
        upsertPolicies() {},
        deletePolicy() {},
        ...overrides,
    } as unknown as NetworkPolicyDao;
}

function scriptedDecisionFlow(choices: NetworkPolicyChoice[]): {
    flow: NetworkPolicyDecisionFlow;
    callCount(): number;
} {
    let calls = 0;
    const flow = {
        async askForPolicy(_uri: string, accessType: NetworkAccessType): Promise<NetworkPolicyChoice> {
            const choice = choices[calls++];
            assert.ok(choice, "Unexpected network policy decision request");
            assert.equal(choice.accessType, accessType);
            return choice;
        },
    } as unknown as NetworkPolicyDecisionFlow;
    return {flow, callCount: () => calls};
}

test("a URI and access type identify one policy whose properties can be replaced", () => {
    const logic = new NetworkPolicyLogic({
        policies: [
            policy(
                "https://API.Example.com:0443/v1?ignored=true",
                NetworkAccessType.HTTP_GET,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "initial",
            ),
        ],
    });

    logic.addPolicies([
        policy(
            "api.example.com:443/v1/",
            NetworkAccessType.HTTP_GET,
            PolicyLifetime.SESSION,
            PolicyResponse.DENIED,
            "replacement",
        ),
    ]);

    const snapshot = logic.allPolicies();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.uri, "api.example.com:443/v1/");
    assert.deepEqual(snapshot[0]?.info[NetworkAccessType.HTTP_GET], {
        accessType: NetworkAccessType.HTTP_GET,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.DENIED,
        reason: "replacement",
    });
});

test("different access types coexist at one URI", () => {
    const logic = new NetworkPolicyLogic();
    logic.addPolicies([
        policy("example.com", NetworkAccessType.HTTP_GET, PolicyLifetime.SESSION, PolicyResponse.ALLOWED, "read"),
        policy("example.com", NetworkAccessType.HTTP_POST, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "write"),
    ]);

    const snapshot = logic.allPolicies();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.info[NetworkAccessType.HTTP_GET]?.reason, "read");
    assert.equal(snapshot[0]?.info[NetworkAccessType.HTTP_POST]?.reason, "write");
});

test("the most-specific hostname or path policy wins", () => {
    const logic = new NetworkPolicyLogic({
        policies: [
            policy("example.com", NetworkAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "domain"),
            policy("api.example.com", NetworkAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "host"),
            policy("api.example.com/v1", NetworkAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "path"),
        ],
    });

    const result = logic.evaluate("https://API.EXAMPLE.COM/v1/users?ignored=true", NetworkAccessType.HTTP_GET);
    assert.equal(result?.evaluatedUri, "api.example.com/v1/users/");
    assert.equal(result?.matchedPattern, "api.example.com/v1/");
    assert.equal(result?.matchedReason, "path");

    assert.equal(
        logic.evaluate("other.example.com/resource", NetworkAccessType.HTTP_GET)?.matchedReason,
        "domain",
    );
    assert.equal(logic.evaluate("notexample.com/resource", NetworkAccessType.HTTP_GET), null);
});

test("ports are exact and path scopes respect segment boundaries", () => {
    const logic = new NetworkPolicyLogic({
        policies: [
            policy("example.com:443", NetworkAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "port"),
            policy("api.example.com:443/v1", NetworkAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.DENIED, "path"),
        ],
    });

    assert.equal(logic.evaluate("api.example.com:443/other", NetworkAccessType.HTTP_GET)?.matchedReason, "port");
    assert.equal(logic.evaluate("api.example.com:444/other", NetworkAccessType.HTTP_GET), null);
    assert.equal(logic.evaluate("api.example.com:443/v1/users", NetworkAccessType.HTTP_GET)?.matchedReason, "path");
    assert.equal(logic.evaluate("api.example.com:443/v10", NetworkAccessType.HTTP_GET)?.matchedReason, "port");
});

test("deletion is per access type and persistence includes only local and global policies", () => {
    const logic = new NetworkPolicyLogic({
        policies: [
            policy("example.com", NetworkAccessType.HTTP_GET, PolicyLifetime.GLOBAL, PolicyResponse.ALLOWED, "get"),
            policy("example.com", NetworkAccessType.HTTP_POST, PolicyLifetime.SESSION, PolicyResponse.DENIED, "post"),
            policy("other.example", NetworkAccessType.HTTP_GET, PolicyLifetime.LOCAL, PolicyResponse.ALLOWED, "local"),
            policy("once.example", NetworkAccessType.HTTP_GET, PolicyLifetime.ONCE, PolicyResponse.ALLOWED, "once"),
        ],
    });

    logic.removePolicies([{uri: "HTTPS://EXAMPLE.COM", accessTypes: [NetworkAccessType.HTTP_GET]}]);
    assert.equal(logic.evaluate("example.com", NetworkAccessType.HTTP_GET), null);
    assert.equal(logic.evaluate("example.com", NetworkAccessType.HTTP_POST)?.matchedReason, "post");

    assert.deepEqual(
        logic.persistedPolicies().map((item) => item.uri),
        ["other.example"],
    );
});

test("local and global network policies round-trip through SQLite", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-network-policy-dao-"));
    const database = SqliteDatabase.test(false, path.join(directory, "policies.sqlite"));

    try {
        const saved = new NetworkPolicyLogic({
            policies: [
                policy(
                    "api.example.com/v1",
                    NetworkAccessType.HTTP_GET,
                    PolicyLifetime.LOCAL,
                    PolicyResponse.ALLOWED,
                    "local get",
                ),
                policy(
                    "api.example.com/v1",
                    NetworkAccessType.HTTP_POST,
                    PolicyLifetime.GLOBAL,
                    PolicyResponse.DENIED,
                    "global post",
                ),
                policy(
                    "api.example.com/v1",
                    NetworkAccessType.HTTP_DELETE,
                    PolicyLifetime.SESSION,
                    PolicyResponse.DENIED,
                    "session delete",
                ),
            ],
        });
        const dao = new NetworkPolicyDao(database).initializeSchema();
        dao.upsertPolicies(saved.persistedPolicies());

        const loaded = new NetworkPolicyLogic({policies: dao.loadPolicies()});
        assert.equal(
            loaded.evaluate("api.example.com/v1/resource", NetworkAccessType.HTTP_GET)?.matchedLifetime,
            PolicyLifetime.LOCAL,
        );
        assert.equal(
            loaded.evaluate("api.example.com/v1/resource", NetworkAccessType.HTTP_POST)?.matchedLifetime,
            PolicyLifetime.GLOBAL,
        );
        assert.equal(
            loaded.evaluate("api.example.com/v1/resource", NetworkAccessType.HTTP_DELETE),
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
    } as unknown as ExtensionContext;
    let runtime: PilotSessionRuntime | null = null;

    try {
        const setupDatabase = SqliteDatabase.test(false, databaseFile);
        const dao = new NetworkPolicyDao(setupDatabase).initializeSchema();
        dao.upsertPolicies([
            policy(
                "persistent.example/api",
                NetworkAccessType.HTTP_GET,
                PolicyLifetime.LOCAL,
                PolicyResponse.ALLOWED,
                "remembered",
            ),
        ]);
        setupDatabase.close();

        runtime = new PilotSessionRuntime(ctx, {
            openDatabase: () => SqliteDatabase.test(false, databaseFile),
        });
        const result = await runtime.networkPolicy.beginToolCall()(
            "https://persistent.example/api/resource",
            NetworkAccessType.HTTP_GET,
        );
        assert.equal(result.matchedLifetime, PolicyLifetime.LOCAL);
        assert.equal(result.matchedReason, "remembered");
    } finally {
        runtime?.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("deny-by-default results are system decisions", () => {
    const result = new NetworkPolicyLogic().evaluate("example.com", NetworkAccessType.HTTP_GET, true);
    assert.equal(result?.matchedPattern, "(none)");
    assert.equal(result?.matchedStatus, PolicyResponse.DENIED);
    assert.equal(result?.resolutionSource, PolicyResolutionSource.SYSTEM);
});

test("runtime policy ownership follows tool-call, session, and persistent lifetimes", async () => {
    let persisted: NetworkPolicy[] = [];
    const decisions = scriptedDecisionFlow([
        {
            uri: "once.example",
            accessType: NetworkAccessType.HTTP_GET,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "once",
        },
        {
            uri: "once.example",
            accessType: NetworkAccessType.HTTP_GET,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.DENIED,
            reason: "second call",
        },
        {
            uri: "session.example",
            accessType: NetworkAccessType.HTTP_POST,
            lifetime: PolicyLifetime.SESSION,
            status: PolicyResponse.DENIED,
            reason: "session",
        },
        {
            uri: "local.example",
            accessType: NetworkAccessType.HTTP_GET,
            lifetime: PolicyLifetime.LOCAL,
            status: PolicyResponse.ALLOWED,
            reason: "local",
        },
    ]);
    const runtime = new NetworkPolicyRuntime(networkPolicyDao({
        loadPolicies: () => structuredClone(persisted),
        upsertPolicies: (policies) => {
            persisted = structuredClone(policies);
        },
    }), decisions.flow);
    const firstCall = runtime.beginToolCall();
    const secondCall = runtime.beginToolCall();

    assert.equal((await firstCall("once.example", NetworkAccessType.HTTP_GET)).matchedLifetime, PolicyLifetime.ONCE);
    assert.equal((await firstCall("once.example", NetworkAccessType.HTTP_GET)).matchedReason, "once");
    assert.equal((await secondCall("once.example", NetworkAccessType.HTTP_GET)).matchedReason, "second call");

    assert.equal(
        (await firstCall("session.example", NetworkAccessType.HTTP_POST)).matchedLifetime,
        PolicyLifetime.SESSION,
    );
    assert.equal(
        (await secondCall("session.example", NetworkAccessType.HTTP_POST)).matchedLifetime,
        PolicyLifetime.SESSION,
    );
    assert.deepEqual(persisted, []);

    const recorded = await firstCall("local.example", NetworkAccessType.HTTP_GET);
    assert.equal(recorded.resolutionSource, PolicyResolutionSource.NEW_USER_DECISION);
    assert.equal(decisions.callCount(), 4);

    const nextSessionDecisions = scriptedDecisionFlow([{
        uri: "session.example",
        accessType: NetworkAccessType.HTTP_POST,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "new session",
    }]);
    const nextSession = new NetworkPolicyRuntime(networkPolicyDao({
        loadPolicies: () => structuredClone(persisted),
    }), nextSessionDecisions.flow);
    assert.equal(
        (await nextSession.beginToolCall()("local.example", NetworkAccessType.HTTP_GET)).matchedLifetime,
        PolicyLifetime.LOCAL,
    );
    assert.equal(
        (await nextSession.beginToolCall()("session.example", NetworkAccessType.HTTP_POST)).matchedReason,
        "new session",
    );
});

test("network policy snapshots discard malformed policies and statuses", () => {
    const sanitized = sanitizeNetworkPolicySnapshot({
        policies: [
            {
                uri: "example.com",
                info: {
                    GET: {
                        accessType: NetworkAccessType.HTTP_GET,
                        lifetime: PolicyLifetime.LOCAL,
                        status: PolicyResponse.ALLOWED,
                        reason: "valid",
                    },
                    POST: {
                        accessType: NetworkAccessType.HTTP_GET,
                        lifetime: PolicyLifetime.LOCAL,
                        status: PolicyResponse.ALLOWED,
                        reason: "wrong access type",
                    },
                },
            },
            {uri: "", info: {}},
        ],
    });

    assert.deepEqual(sanitized, {
        policies: [
            {
                uri: "example.com",
                info: {
                    GET: {
                        accessType: NetworkAccessType.HTTP_GET,
                        lifetime: PolicyLifetime.LOCAL,
                        status: PolicyResponse.ALLOWED,
                        reason: "valid",
                    },
                },
            },
        ],
    });
});

test("URI scope hierarchy is ordered from broadest to most specific", () => {
    assert.deepEqual(
        new ParsedUri("https://api.example.com/v1/users?ignored=true").scopeHierarchy(),
        ["com", "example.com", "api.example.com", "api.example.com/v1", "api.example.com/v1/users"],
    );
});
