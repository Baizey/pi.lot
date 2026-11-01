import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";
import type {BindingResponse} from "../src/server/ArchiveProtocol.js";
import {decodeArchiveBindingResponse} from "../src/server/ArchiveProtocol.js";
import {ConfigSyncClient, ConfigSyncClientError} from "../src/server/config-sync/ConfigSyncClient.js";
import {
    canonicalConfigContent, CONFIG_KEYS, CONFIG_SYNC_CAPABILITY, configHash, ConfigSyncProtocolError,
    decodeConfigCheckResult, decodeConfigExchange, decodeConfigKey, decodeConfigState, decodeGlobalPolicyRules,
    validateConfigContent, type ConfigCheck, type ConfigCheckResult, type ConfigExchange, type ConfigKey, type ConfigState,
} from "../src/server/config-sync/ConfigSyncProtocol.js";

type Document = {id: string; key: ConfigKey; value: unknown; canonical: string; content: string; sha256: string};
type CanonicalVector = {id: string; value: unknown; canonical: string; sha256: string};
type CheckPair = {id: string; request: ConfigCheck; response: ConfigCheckResult};
type ExchangePair = {id: string; request: ConfigExchange; response: ConfigState};
type InvalidCase = {id: string; target: "check" | "check_result" | "exchange" | "state" | "content" | "canonical"; value: unknown};
type MismatchedResponse =
    | {id: string; method: "check"; request: ConfigCheck; response: ConfigCheckResult}
    | {id: string; method: "sync"; request: ConfigExchange; response: ConfigState};
type PolicyScenario = {
    id: string; base: ConfigState; current: ConfigState; exchange_id: string;
    retained_patterns: string[]; added_patterns: string[]; removed_patterns: string[];
};
type WireFixture = {
    fixture_version: number; protocol: string; notes: string[]; binding_response: BindingResponse; null_sha256: string;
    documents: Document[]; canonical_vectors: CanonicalVector[]; checks: CheckPair[]; exchanges: ExchangePair[];
    policy_scenarios: PolicyScenario[]; invalid: InvalidCase[]; mismatched_responses: MismatchedResponse[];
};

const FIXTURE_SHA256 = "24332388ddd42c8d1b0293f277bfbb0052ec72fa8cca9fd6d4e28d9b725586da";
const fixtureBytes = readFileSync(new URL("./fixtures/config-sync-v1.json", import.meta.url));
// This assertion describes the golden test corpus, not a replacement decoder for wire data.
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as WireFixture;
const CONFIG = {url: "https://interop.example.test", apiKey: "fixture-only-transport-key"};

function mockedClient(path: string, response: unknown, sent?: (value: unknown, bytes: Buffer) => void): ConfigSyncClient {
    return new ConfigSyncClient(CONFIG, {fetch: async (input, init) => {
        assert.equal(String(input), `${CONFIG.url}${path}`);
        assert.equal(init?.method, path === "/v1/binding" ? "GET" : "POST");
        assert.equal(init?.redirect, "manual");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-apikey"), CONFIG.apiKey);
        assert.equal(headers.get("accept"), "application/json");
        if (path === "/v1/binding") assert.equal(init?.body, undefined);
        else {
            assert.equal(headers.get("content-type"), "application/json");
            const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
            assert.equal(headers.get("content-length"), String(bytes.length));
            sent?.(JSON.parse(bytes.toString("utf8")), bytes);
        }
        return Response.json(response);
    }});
}

function protocolFailure(error: unknown): boolean {
    assert.ok(error instanceof ConfigSyncClientError);
    assert.equal(error.kind, "protocol");
    assert.equal(error.code, undefined);
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes(CONFIG.apiKey), false);
    return true;
}

test("cross-language corpus identity, vocabulary, and coverage are pinned", () => {
    assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), FIXTURE_SHA256);
    assert.equal(fixture.fixture_version, 1);
    assert.equal(fixture.protocol, CONFIG_SYNC_CAPABILITY);
    assert.deepEqual(new Set(fixture.documents.map((entry) => entry.key)), new Set(CONFIG_KEYS));
    assert.deepEqual(new Set(fixture.checks.map((entry) => entry.request.key)), new Set(CONFIG_KEYS));
    assert.deepEqual(new Set(fixture.exchanges.map((entry) => entry.request.key)), new Set(CONFIG_KEYS));
    assert.deepEqual(new Set(fixture.exchanges.map((entry) => entry.response.outcome)),
        new Set(["client_won", "server_won", "merged", "unchanged"]));
    assert.ok(fixture.exchanges.some((entry) => entry.request.base_revision === null));
    assert.ok(fixture.exchanges.some((entry) => entry.request.base_revision === "0"));
    assert.ok(fixture.exchanges.some((entry) => entry.response.revision === "0" && entry.response.content === null && entry.response.updated_at === null));
    assert.ok(fixture.exchanges.some((entry) => BigInt(entry.response.revision) > 0n && entry.response.content === null && entry.response.updated_at !== null));
    assert.ok(fixture.checks.some((entry) => entry.request.known_revision === "9223372036854775807"));
    assert.equal(configHash(null), fixture.null_sha256);
    assert.equal(fixture.null_sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    for (const entries of [fixture.documents, fixture.canonical_vectors, fixture.checks, fixture.exchanges,
        fixture.policy_scenarios, fixture.invalid, fixture.mismatched_responses]) {
        assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
    }
});

test("binding fixture is accepted by the real decoder and mocked HTTP client", async () => {
    assert.deepEqual(decodeArchiveBindingResponse(fixture.binding_response), fixture.binding_response);
    assert.deepEqual(await mockedClient("/v1/binding", fixture.binding_response).binding(), fixture.binding_response);
});

for (const document of fixture.documents) {
    test(`document ${document.id}: approved schema, exact canonical bytes, and SHA-256`, () => {
        assert.equal(decodeConfigKey(document.key), document.key);
        validateConfigContent(document.key, document.content);
        assert.deepEqual(JSON.parse(document.content), document.value);
        assert.equal(canonicalConfigContent(document.value), document.canonical);
        assert.equal(configHash(document.content), document.sha256);
        assert.equal(createHash("sha256").update(Buffer.from(document.content, "utf8")).digest("hex"), document.sha256);
        if (document.key === "global-policies") {
            assert.equal(canonicalConfigContent({rules: decodeGlobalPolicyRules(document.content)}), document.content);
        }
    });
}

for (const vector of fixture.canonical_vectors) {
    test(`canonical vector ${vector.id}: language-independent ordering and escaping`, () => {
        assert.equal(canonicalConfigContent(vector.value), vector.canonical);
        assert.deepEqual(JSON.parse(vector.canonical), vector.value);
        assert.equal(configHash(vector.canonical), vector.sha256);
    });
}

test("ordinary JSON formatting is opaque on the wire and changes the exact content hash", () => {
    const compact = fixture.documents.find((entry) => entry.id === "display");
    const formatted = fixture.documents.find((entry) => entry.id === "display-formatted");
    assert.ok(compact && formatted);
    assert.equal(compact.canonical, formatted.canonical);
    assert.notEqual(compact.content, formatted.content);
    assert.notEqual(compact.sha256, formatted.sha256);
});

for (const pair of fixture.checks) {
    test(`${pair.id}: actual check client sends the fixture envelope and validates its response`, async () => {
        const before = structuredClone(pair.request);
        let calls = 0;
        const client = mockedClient("/v1/config/check", pair.response, (value) => {
            calls++;
            assert.deepEqual(value, pair.request);
        });
        assert.deepEqual(decodeConfigCheckResult(pair.response), pair.response);
        assert.deepEqual(await client.check(pair.request), pair.response);
        assert.equal(calls, 1);
        assert.deepEqual(pair.request, before);
    });
}

for (const pair of fixture.exchanges) {
    test(`${pair.id}: exported exchange/state decoders and actual HTTP serialization agree`, async () => {
        const before = structuredClone(pair.request);
        const normalized = decodeConfigExchange(pair.request);
        assert.deepEqual(normalized, pair.request);
        assert.deepEqual(decodeConfigState(pair.response), pair.response);
        const wires: Buffer[] = [];
        const client = mockedClient("/v1/config/sync", pair.response, (value, bytes) => {
            assert.deepEqual(value, pair.request);
            wires.push(bytes);
        });
        assert.deepEqual(await client.sync(normalized), pair.response);
        assert.deepEqual(await client.sync(structuredClone(normalized)), pair.response);
        assert.equal(wires.length, 2);
        assert.deepEqual(wires[0], wires[1]);
        assert.deepEqual(pair.request, before);
    });
}

for (const scenario of fixture.policy_scenarios) {
    test(`${scenario.id}: fixed policy merge envelopes retain the declared adds/deletes`, async () => {
        const base = decodeConfigState(scenario.base);
        const current = decodeConfigState(scenario.current);
        const pair = fixture.exchanges.find((entry) => entry.id === scenario.exchange_id);
        assert.ok(pair);
        assert.equal(base.key, "global-policies");
        assert.equal(current.key, "global-policies");
        assert.equal(pair.request.key, "global-policies");
        assert.equal(pair.request.base_revision, base.revision);
        assert.ok(BigInt(current.revision) > BigInt(base.revision));
        assert.ok(BigInt(pair.response.revision) > BigInt(current.revision));
        assert.equal(pair.response.outcome, "merged");
        // Validate a golden result only. Arbitration itself belongs to the Rust implementation.
        const result = await mockedClient("/v1/config/sync", pair.response).sync(pair.request);
        const patterns = decodeGlobalPolicyRules(result.content).map((rule) => rule.pattern);
        for (const pattern of [...scenario.retained_patterns, ...scenario.added_patterns]) assert.ok(patterns.includes(pattern));
        for (const pattern of scenario.removed_patterns) assert.equal(patterns.includes(pattern), false);
        assert.equal(patterns.length, scenario.retained_patterns.length + scenario.added_patterns.length);
    });
}

for (const invalid of fixture.invalid) {
    test(`malformed ${invalid.id}: actual protocol/client boundaries reject`, async () => {
        let fetched = false;
        const localClient = new ConfigSyncClient(CONFIG, {fetch: async () => {
            fetched = true;
            assert.fail("Malformed local fixtures must be rejected before HTTP");
        }});
        switch (invalid.target) {
            case "exchange":
                assert.throws(() => decodeConfigExchange(invalid.value), ConfigSyncProtocolError);
                // Malformed fixtures deliberately cross the typed public boundary from untrusted JSON.
                await assert.rejects(localClient.sync(invalid.value as ConfigExchange), protocolFailure);
                break;
            case "check":
                // No public check-request decoder exists; exercise its production validation through the client.
                await assert.rejects(localClient.check(invalid.value as ConfigCheck), protocolFailure);
                break;
            case "state":
                assert.throws(() => decodeConfigState(invalid.value), ConfigSyncProtocolError);
                await assert.rejects(mockedClient("/v1/config/sync", invalid.value).sync(fixture.exchanges[0].request), protocolFailure);
                break;
            case "check_result":
                assert.throws(() => decodeConfigCheckResult(invalid.value), ConfigSyncProtocolError);
                await assert.rejects(mockedClient("/v1/config/check", invalid.value).check(fixture.checks[0].request), protocolFailure);
                break;
            case "content": {
                const value = invalid.value as {key: ConfigKey; content: unknown};
                assert.throws(() => validateConfigContent(value.key, value.content), ConfigSyncProtocolError);
                const exchange = {...fixture.exchanges[0].request, key: value.key, content: value.content,
                    sha256: configHash(typeof value.content === "string" ? value.content : null)};
                assert.throws(() => decodeConfigExchange(exchange), ConfigSyncProtocolError);
                break;
            }
            case "canonical":
                assert.throws(() => canonicalConfigContent(invalid.value), ConfigSyncProtocolError);
                break;
            default:
                assert.fail(`Unknown fixture target: ${String(invalid.target)}`);
        }
        assert.equal(fetched, false);
    });
}

for (const pair of fixture.mismatched_responses) {
    test(`${pair.id}: standalone-valid response is rejected when correlated to its request`, async () => {
        if (pair.method === "check") {
            assert.deepEqual(decodeConfigCheckResult(pair.response), pair.response);
            await assert.rejects(mockedClient("/v1/config/check", pair.response).check(pair.request), protocolFailure);
        } else {
            assert.deepEqual(decodeConfigExchange(pair.request), pair.request);
            assert.deepEqual(decodeConfigState(pair.response), pair.response);
            await assert.rejects(mockedClient("/v1/config/sync", pair.response).sync(pair.request), protocolFailure);
        }
    });
}
