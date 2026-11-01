import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {
    canonicalConfigContent,
    compareConfigText,
    CONFIG_KEYS,
    CONFIG_SYNC_CAPABILITY,
    configHash,
    ConfigSyncProtocolError,
    decodeConfigCheckResult,
    decodeConfigExchange,
    decodeConfigKey,
    decodeConfigState,
    decodeConfigTimestamp,
    decodeGlobalPolicyRules,
    MAX_CONFIG_CONTENT_BYTES,
    MAX_CONFIG_WIRE_BYTES,
    validateConfigContent,
    type ConfigExchange,
    type ConfigKey,
    type ConfigState,
    type GlobalPolicyRule,
} from "../src/server/config-sync/ConfigSyncProtocol.js";
import {initialDisplayDefaults} from "../src/tui/tool/DisplayDefaults.js";
import {initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {PolicyAccessType, PolicyResponse} from "../src/policy/types.js";

const binding = {server_id: "server", namespace_id: "namespace", history_generation: "generation"};
const timestamp = "2025-01-02T03:04:05.006Z";
const changeId = "01234567-89ab-cdef-0123-456789abcdef";
// Match the complete saved source fixtures used by config-sync-adapters.test.ts.
const savedSources: Readonly<Record<ConfigKey, unknown>> = {
    "display-defaults": initialDisplayDefaults,
    "subagent-defaults": initialSubagentDefaults,
    "policy-defaults": initialPolicyDefaults,
    "web-search": {version: 1, providers: ["brave"], brave: {apiKey: "saved-secret"}},
    "global-policies": {rules: [rule("example.com:443")]},
};

for (const key of CONFIG_KEYS) {
    test(`${key}: complete saved source and null reset validate and round-trip through both envelopes`, () => {
        const content = canonicalConfigContent(savedSources[key]);
        for (const saved of [content, null]) {
            assert.doesNotThrow(() => validateConfigContent(key, saved));
            const request = exchange(key, saved);
            assert.deepEqual(decodeConfigExchange(request), request);
            const response = state(key, saved);
            assert.deepEqual(decodeConfigState(response), response);
        }
        // File formatting is not itself a schema error for ordinary settings.
        if (key !== "global-policies") {
            assert.doesNotThrow(() => validateConfigContent(key, JSON.stringify(savedSources[key], null, 4)));
        }
    });

    test(`${key}: malformed JSON, missing required fields, foreign fields, and non-string content fail closed`, () => {
        for (const content of ["{", "", "null", "[]", "{}", "true", "42", '{"unexpected":true}', 1, false, {}, []]) {
            rejects(() => validateConfigContent(key, content));
        }
        const withExtra = {...savedSourceObject(key), unexpected: "not approved"};
        rejects(() => validateConfigContent(key, JSON.stringify(withExtra)));
        for (const field of Object.keys(savedSourceObject(key))) {
            // Web-search provider credentials are optional; its required fields are version/providers.
            if (key === "web-search" && field === "brave") continue;
            rejects(() => validateConfigContent(key, JSON.stringify(without(savedSourceObject(key), field))));
        }
    });
}

test("configuration capability and key vocabulary are fixed, with no unrelated settings admitted", () => {
    assert.equal(CONFIG_SYNC_CAPABILITY, "config_sync_v1");
    assert.deepEqual(CONFIG_KEYS, ["display-defaults", "subagent-defaults", "policy-defaults", "web-search", "global-policies"]);
    for (const key of CONFIG_KEYS) assert.equal(decodeConfigKey(key), key);
    for (const key of [null, undefined, 1, {}, [], "", "server", "server.json", "resources", "compaction", "Display-defaults", "web-search\n"]) {
        rejects(() => decodeConfigKey(key));
    }
});

test("canonical JSON recursively sorts UTF-8 keys, preserves array order, and does not mutate its source", () => {
    const source = Object.freeze({
        "\u{10000}": "astral", "\ue000": "bmp", z: Object.freeze({z: false, a: null}),
        a: Object.freeze([Object.freeze({z: 2, a: 1}), "é", true, -1]),
    });
    assert.equal(
        canonicalConfigContent(source),
        '{"a":[{"a":1,"z":2},"é",true,-1],"z":{"a":null,"z":false},"\ue000":"bmp","\u{10000}":"astral"}',
    );
    assert.deepEqual(Object.keys(source), ["\u{10000}", "\ue000", "z", "a"]);
    assert.ok(compareConfigText("\ue000", "\u{10000}") < 0);
    assert.ok(compareConfigText("z", "é") < 0);
    assert.equal(compareConfigText("same", "same"), 0);
    assert.equal(canonicalConfigContent(Object.assign(Object.create(null), {z: 1, a: 2})), '{"a":2,"z":1}');
    assert.equal(canonicalConfigContent(JSON.parse('{"__proto__":{"z":1,"a":2},"a":3}')), '{"__proto__":{"a":2,"z":1},"a":3}');
});

test("canonical JSON sorts integer-looking property names by UTF-8 bytes, not JavaScript enumeration order", () => {
    assert.equal(canonicalConfigContent({"2": "two", "10": "ten", "1": {"20": true, "3": false}}),
        '{"1":{"20":true,"3":false},"10":"ten","2":"two"}');
});

test("canonical JSON admits only safe integers, booleans, strings, null, arrays, and plain records", () => {
    for (const value of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1, true, false, null, "text"]) {
        assert.equal(canonicalConfigContent(value), JSON.stringify(value));
    }
    for (const value of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1,
        undefined, 1n, Symbol("unsupported"), () => 1, new Date(), new Map(), new Set(), /pattern/]) {
        rejects(() => canonicalConfigContent(value));
        rejects(() => canonicalConfigContent({nested: value}));
        rejects(() => canonicalConfigContent([value]));
    }
});

test("canonical JSON rejects lone UTF-16 surrogates in values and keys without rejecting valid astral characters", () => {
    for (const text of ["\ud800", "\udfff", "before\ud800after", "\udfff\ud800"]) {
        rejects(() => canonicalConfigContent(text));
        rejects(() => canonicalConfigContent({[text]: true}));
        rejects(() => validateConfigContent("web-search", JSON.stringify({version: 1, providers: ["brave"], brave: {apiKey: text}})));
    }
    assert.equal(canonicalConfigContent({"😀": "𐀀"}), '{"😀":"𐀀"}');
});

test("canonical JSON bounds nesting at 32 and rejects deeper or cyclic input with protocol errors", () => {
    const nested = (depth: number): unknown => {
        let value: unknown = "leaf";
        for (let index = 0; index < depth; index++) value = [value];
        return value;
    };
    assert.doesNotThrow(() => canonicalConfigContent(nested(32)));
    rejects(() => canonicalConfigContent(nested(33)));
    rejects(() => canonicalConfigContent(new Array(1)));
    const cycle: unknown[] = [];
    cycle.push(cycle);
    rejects(() => canonicalConfigContent(cycle));
    rejects(() => validateConfigContent("web-search", JSON.stringify({
        version: 1, providers: ["brave"], brave: {apiKey: "secret"}, unexpected: nested(33),
    })));
});

test("content limits count UTF-8 bytes including JSON framing, and exact-limit input remains valid", () => {
    assert.equal(MAX_CONFIG_CONTENT_BYTES, 256 * 1024);
    assert.equal(MAX_CONFIG_WIRE_BYTES, 2 * MAX_CONFIG_CONTENT_BYTES + 8192);
    const exact = "é".repeat((MAX_CONFIG_CONTENT_BYTES - 2) / 2);
    assert.equal(Buffer.byteLength(canonicalConfigContent(exact)), MAX_CONFIG_CONTENT_BYTES);
    rejects(() => canonicalConfigContent(exact + "a"));
    const compact = canonicalConfigContent(initialDisplayDefaults);
    assert.doesNotThrow(() => validateConfigContent("display-defaults", compact.padEnd(MAX_CONFIG_CONTENT_BYTES)));
    rejects(() => validateConfigContent("display-defaults", compact.padEnd(MAX_CONFIG_CONTENT_BYTES + 1)));
    rejects(() => validateConfigContent("display-defaults", compact + "é".repeat(MAX_CONFIG_CONTENT_BYTES / 2)));
    const maximumRequest = exchange("display-defaults", compact.padEnd(MAX_CONFIG_CONTENT_BYTES));
    assert.doesNotThrow(() => decodeConfigExchange(maximumRequest));
    assert.ok(Buffer.byteLength(JSON.stringify(maximumRequest)) <= MAX_CONFIG_WIRE_BYTES);
    const excessive = compact.padEnd(MAX_CONFIG_CONTENT_BYTES + 1);
    rejects(() => decodeConfigExchange({...maximumRequest, content: excessive, sha256: configHash(excessive)}));
});

test("the wire budget accommodates exact-limit saved content with nearly double JSON-string escaping", () => {
    const fixture = {version: 1, providers: ["brave"], brave: {apiKey: "x"}};
    const overhead = Buffer.byteLength(canonicalConfigContent(fixture)) - 1;
    const payloadBytes = MAX_CONFIG_CONTENT_BYTES - overhead;
    const apiKey = '"'.repeat(Math.floor(payloadBytes / 2)) + (payloadBytes % 2 ? "x" : "");
    const content = canonicalConfigContent({...fixture, brave: {apiKey}});
    assert.equal(Buffer.byteLength(content), MAX_CONFIG_CONTENT_BYTES);
    const request = exchange("web-search", content);
    assert.deepEqual(decodeConfigExchange(request), request);
    const wireBytes = Buffer.byteLength(JSON.stringify(request));
    assert.ok(wireBytes > 1.9 * MAX_CONFIG_CONTENT_BYTES);
    assert.ok(wireBytes <= MAX_CONFIG_WIRE_BYTES);
});

test("digests identify exact UTF-8 content bytes, with a shared empty digest only for null and empty bytes", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.equal(configHash(null), empty);
    assert.equal(configHash(""), empty);
    assert.notEqual(configHash("null"), empty);
    assert.equal(configHash("é😀"), createHash("sha256").update(Buffer.from("é😀", "utf8")).digest("hex"));
    const compact = canonicalConfigContent(initialDisplayDefaults);
    const formatted = JSON.stringify(initialDisplayDefaults, null, 4);
    assert.notEqual(configHash(compact), configHash(formatted));
    assert.equal(configHash(canonicalConfigContent(JSON.parse(formatted))), configHash(compact));
    const request = exchange("display-defaults", compact);
    for (const digest of [null, undefined, 1, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), configHash(null), request.sha256 + "\n"]) {
        rejects(() => decodeConfigExchange({...request, sha256: digest}));
        rejects(() => decodeConfigState({...state("display-defaults", compact), sha256: digest}));
    }
    rejects(() => decodeConfigExchange({...request, content: formatted}));
});

test("exchange envelopes require exactly the documented fields and own binding identity fields", () => {
    const request = exchange();
    for (const field of Object.keys(request)) rejects(() => decodeConfigExchange(without(request, field)));
    rejects(() => decodeConfigExchange({...request, token: "not allowed"}));
    rejects(() => decodeConfigExchange(Object.assign(Object.create(request), {content: request.content})));
    for (const value of [null, [], true, 1, "request"]) rejects(() => decodeConfigExchange(value));
    for (const field of Object.keys(binding)) rejects(() => decodeConfigExchange({...request, binding: without(binding, field)}));
    rejects(() => decodeConfigExchange({...request, binding: {...binding, extra: "not allowed"}}));
});

test("state and check-result envelopes require exactly their documented fields", () => {
    const response = state();
    const check = {binding, key: "web-search", sync_needed: true};
    assert.deepEqual(decodeConfigCheckResult(check), check);
    assert.deepEqual(decodeConfigCheckResult({...check, sync_needed: false}), {...check, sync_needed: false});
    for (const field of Object.keys(response)) rejects(() => decodeConfigState(without(response, field)));
    for (const field of Object.keys(check)) rejects(() => decodeConfigCheckResult(without(check, field)));
    rejects(() => decodeConfigState({...response, extra: "not allowed"}));
    rejects(() => decodeConfigCheckResult({...check, extra: "not allowed"}));
    for (const syncNeeded of [null, undefined, 0, 1, "true", [], {}]) {
        rejects(() => decodeConfigCheckResult({...check, sync_needed: syncNeeded}));
    }
});

test("binding IDs are nonempty, control-free, well-formed Unicode and bounded by UTF-8 bytes", () => {
    for (const field of Object.keys(binding)) {
        for (const id of [null, undefined, 1, "", "bad\n", "bad\u0000", "bad\u0085", "\ud800", "x".repeat(513), "é".repeat(257)]) {
            const invalidBinding = {...binding, [field]: id};
            rejects(() => decodeConfigExchange({...exchange(), binding: invalidBinding}));
            rejects(() => decodeConfigState({...state(), binding: invalidBinding}));
            rejects(() => decodeConfigCheckResult({binding: invalidBinding, key: "web-search", sync_needed: false}));
        }
    }
    assert.doesNotThrow(() => decodeConfigExchange({...exchange(), binding: {...binding, server_id: "é".repeat(256)}}));
});

test("revisions stay canonical decimal strings through the complete i64 range without JS number conversion", () => {
    for (const revision of ["0", "1", "9007199254740993", "9223372036854775807"]) {
        assert.equal(decodeConfigExchange({...exchange(), base_revision: revision}).base_revision, revision);
        const response = revision === "0" ? {...state("web-search", null), revision, updated_at: null} : {...state(), revision};
        assert.equal(decodeConfigState(response).revision, revision);
    }
    assert.equal(decodeConfigExchange({...exchange(), base_revision: null}).base_revision, null);
    for (const revision of [undefined, 0, 1, 1n, "", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ", "1\n", "9223372036854775808", "99999999999999999999"]) {
        rejects(() => decodeConfigExchange({...exchange(), base_revision: revision}));
        rejects(() => decodeConfigState({...state(), revision}));
    }
    rejects(() => decodeConfigState({...state(), revision: null}));
});

test("change IDs are complete lowercase canonical UUID strings without whitespace or suffixes", () => {
    assert.equal(decodeConfigExchange(exchange()).change_id, changeId);
    for (const id of [null, undefined, 1, "", changeId.toUpperCase(), changeId.replaceAll("-", ""),
        " " + changeId, changeId + " ", changeId + "\n", changeId + "\r\n", changeId + "x",
        "g1234567-89ab-cdef-0123-456789abcdef"]) {
        rejects(() => decodeConfigExchange({...exchange(), change_id: id}));
    }
});

test("timestamps require real UTC calendar dates with exact millisecond precision", () => {
    for (const value of ["1970-01-01T00:00:00.000Z", timestamp, "2024-02-29T23:59:59.999Z", "9999-12-31T23:59:59.999Z"]) {
        assert.equal(decodeConfigTimestamp(value), value);
        assert.equal(decodeConfigExchange({...exchange(), modified_at: value}).modified_at, value);
    }
    for (const value of [null, undefined, 1, "", "1969-12-31T23:59:59.999Z", "2025-02-29T00:00:00.000Z",
        "2025-04-31T00:00:00.000Z", "2025-01-01T24:00:00.000Z", "2025-01-01T00:00:60.000Z",
        "2025-13-01T00:00:00.000Z", "2025-01-00T00:00:00.000Z", "2025-01-01t00:00:00.000z",
        "2025-01-01T00:00:00Z", "2025-01-01T00:00:00.00Z", "2025-01-01T00:00:00.0000Z",
        "2025-01-01T00:00:00.000+00:00", timestamp + "\n"]) {
        rejects(() => decodeConfigTimestamp(value));
        rejects(() => decodeConfigExchange({...exchange(), modified_at: value}));
        rejects(() => decodeConfigState({...state(), updated_at: value}));
    }
});

test("revision zero is absent, while positive revisions can carry explicit resets but must have timestamps", () => {
    const absent = {...state("web-search", null), revision: "0", updated_at: null};
    assert.deepEqual(decodeConfigState(absent), absent);
    const reset = state("web-search", null);
    assert.deepEqual(decodeConfigState(reset), reset);
    rejects(() => decodeConfigState({...absent, updated_at: timestamp}));
    rejects(() => decodeConfigState({...state(), revision: "0", updated_at: null}));
    rejects(() => decodeConfigState({...reset, updated_at: null}));
    rejects(() => decodeConfigState({...state(), updated_at: null}));
    for (const outcome of ["client_won", "server_won", "merged", "unchanged"]) {
        assert.equal(decodeConfigState({...reset, outcome}).outcome, outcome);
    }
    for (const outcome of [null, undefined, 1, "", "CLIENT_WON", "accepted"]) rejects(() => decodeConfigState({...reset, outcome}));
});

test("schema versions, keys, and digest identity are validated on requests and responses", () => {
    for (const version of [null, undefined, "1", 0, 2, 1.5, true]) {
        rejects(() => decodeConfigExchange({...exchange(), schema_version: version}));
        rejects(() => decodeConfigState({...state(), schema_version: version}));
    }
    for (const key of [null, undefined, "unknown", "web-search.json"]) {
        rejects(() => decodeConfigExchange({...exchange(), key}));
        rejects(() => decodeConfigState({...state(), key}));
        rejects(() => decodeConfigCheckResult({binding, key, sync_needed: false}));
    }
});

test("each saved settings schema rejects unsupported values rather than merely accepting JSON", () => {
    for (const value of [{normal: "unsupported", alternate: "minimal"}, {normal: 1, alternate: "minimal"}]) {
        rejects(() => validateConfigContent("display-defaults", JSON.stringify(value)));
    }
    for (const preference of [null, false, "", "not-canonical", "provider/with space"]) {
        rejects(() => validateConfigContent("subagent-defaults", JSON.stringify({...initialSubagentDefaults, high: preference})));
    }
    for (const response of [null, false, "ALLOWED", "allow\n", "unsupported"]) {
        rejects(() => validateConfigContent("policy-defaults", JSON.stringify({...initialPolicyDefaults, fs_read: response})));
    }
    for (const value of [
        {version: 2, providers: ["brave"]}, {version: 1, providers: []}, {version: 1, providers: ["brave", "brave"]},
        {version: 1, providers: ["unsupported"]}, {version: 1, providers: ["brave"], brave: {apiKey: " "}},
        {version: 1, providers: ["brave"], requestTimeoutMs: 999},
        {version: 1, providers: ["brave"], requestTimeoutMs: 120001},
        {version: 1, providers: ["brave"], maxResponseBytes: 1023},
        {version: 1, providers: ["brave"], maxResponseBytes: 10 * 1024 * 1024 + 1},
        {version: 1, providers: ["searxng"], searxng: {baseUrl: "https://user:secret@example.com/"}},
    ]) rejects(() => validateConfigContent("web-search", JSON.stringify(value)));
    assert.doesNotThrow(() => validateConfigContent("subagent-defaults", canonicalConfigContent({
        ...initialSubagentDefaults, high: "unavailable-provider/still-saved-model",
    })));
});

test("GLOBAL rules decode in UTF-8 pattern/access-type order and retain every supported access type and status", () => {
    const entries = [rule("\u{10000}"), rule("\ue000"), rule("z"), rule("a"),
        {...rule("a"), accessType: PolicyAccessType.FS_READ, status: PolicyResponse.DENIED}];
    assert.deepEqual(decodeGlobalPolicyRules(JSON.stringify({rules: entries})), [entries[4], entries[3], entries[2], entries[1], entries[0]]);
    assert.deepEqual(decodeGlobalPolicyRules(null), []);
    assert.deepEqual(decodeGlobalPolicyRules('{"rules":[]}'), []);
    const allTypes = Object.values(PolicyAccessType).map((accessType, index) => ({
        ...rule("example.com:443"), accessType, status: index % 2 ? PolicyResponse.ALLOWED : PolicyResponse.DENIED,
    }));
    assert.equal(decodeGlobalPolicyRules(JSON.stringify({rules: allTypes})).length, Object.values(PolicyAccessType).length);
});

test("GLOBAL rule identities are unique by pattern and access type, independent of status or reason", () => {
    const first = rule("example.com:443");
    const duplicate = {...first, status: PolicyResponse.DENIED, reason: "different decision"};
    rejects(() => decodeGlobalPolicyRules(JSON.stringify({rules: [first, first]})));
    rejects(() => decodeGlobalPolicyRules(JSON.stringify({rules: [first, duplicate]})));
    assert.equal(decodeGlobalPolicyRules(JSON.stringify({rules: [first, {...first, accessType: PolicyAccessType.HTTP_POST}]})).length, 2);
    assert.equal(decodeGlobalPolicyRules(JSON.stringify({rules: [first, {...first, pattern: "other.example:443"}]})).length, 2);
});

test("GLOBAL rules require exact root/rule fields, supported enum values, and no lifetime", () => {
    const valid = rule("example.com:443");
    for (const value of [{rules: [valid], extra: true}, {rules: {}}, {rules: null}, {rules: [null]}, {rules: [[]]},
        {rules: [{...valid, lifetime: "GLOBAL"}]}, {rules: [{...valid, accessType: "TRACE"}]},
        {rules: [{...valid, status: "allow"}]}, {rules: [{...valid, reason: 1}]}]) {
        rejects(() => decodeGlobalPolicyRules(JSON.stringify(value)));
        rejects(() => validateConfigContent("global-policies", JSON.stringify(value)));
    }
    for (const field of Object.keys(valid)) rejects(() => decodeGlobalPolicyRules(JSON.stringify({rules: [without(valid, field)]})));
});

test("GLOBAL pattern/reason bounds are UTF-8 byte bounds; patterns reject empty/control/malformed text", () => {
    for (const pattern of ["", "bad\u0000", "bad\n", "bad\u007f", "bad\u009f", "\ud800", "é".repeat(2049)]) {
        rejects(() => decodeGlobalPolicyRules(JSON.stringify({rules: [rule(pattern)]})));
    }
    for (const reason of ["\udfff", "é".repeat(2049)]) {
        rejects(() => decodeGlobalPolicyRules(JSON.stringify({rules: [{...rule("valid"), reason}]})));
    }
    const bounded = {...rule("é".repeat(2048)), reason: "é".repeat(2048)};
    assert.deepEqual(decodeGlobalPolicyRules(JSON.stringify({rules: [bounded]})), [bounded]);
    assert.doesNotThrow(() => decodeGlobalPolicyRules(JSON.stringify({rules: [{...rule("😀"), reason: ""}]})));
});

test("GLOBAL bundles bound rule count and total serialized bytes independently", () => {
    const entries = Array.from({length: 1024}, (_, index) => rule(`host-${index}.example:443`));
    assert.equal(decodeGlobalPolicyRules(JSON.stringify({rules: entries})).length, 1024);
    rejects(() => decodeGlobalPolicyRules(JSON.stringify({rules: [...entries, rule("extra.example:443")]})));
    const oversized = JSON.stringify({rules: entries.map((entry) => ({...entry, reason: "x".repeat(4096)}))});
    assert.ok(Buffer.byteLength(oversized) > MAX_CONFIG_CONTENT_BYTES);
    rejects(() => decodeGlobalPolicyRules(oversized));
});

test("GLOBAL wire content uses null for empty bundles and otherwise requires canonical sorted rules", () => {
    const ordered = {rules: [rule("a"), rule("z")]};
    const invalidContents = [
        '{"rules":[]}',
        canonicalConfigContent({rules: [rule("z"), rule("a")]}),
        canonicalConfigContent({rules: [rule("a"), {...rule("a"), accessType: PolicyAccessType.FS_READ}]}),
        JSON.stringify(ordered, null, 4),
        canonicalConfigContent(ordered) + "\n",
    ];
    for (const content of invalidContents) {
        rejects(() => validateConfigContent("global-policies", content));
        rejects(() => decodeConfigExchange(exchange("global-policies", content)));
        rejects(() => decodeConfigState(state("global-policies", content)));
    }
    assert.doesNotThrow(() => validateConfigContent("global-policies", canonicalConfigContent(ordered)));
});

test("parser errors never disclose web-search secrets, unknown field names, JSON excerpts, or nested causes", () => {
    const secret = "private-web-credential-do-not-disclose";
    const contents = [
        `{"version":1,"providers":["brave"],"brave":{"apiKey":"${secret}"},`,
        JSON.stringify({version: secret, providers: ["brave"]}),
        JSON.stringify({version: 1, providers: [secret]}),
        JSON.stringify({version: 1, providers: ["brave"], [secret]: true}),
        JSON.stringify({version: 1, providers: ["brave"], brave: {apiKey: "key", [secret]: true}}),
        JSON.stringify({version: 1, providers: ["searxng"], searxng: {baseUrl: secret}}),
    ];
    for (const content of contents) {
        for (const decode of [
            () => validateConfigContent("web-search", content),
            () => decodeConfigExchange(exchange("web-search", content)),
            () => decodeConfigState(state("web-search", content)),
        ]) {
            assert.throws(decode, (error: unknown) => {
                assert.ok(error instanceof ConfigSyncProtocolError);
                assert.equal(error.message, "Invalid configuration synchronization data.");
                assert.equal(error.cause, undefined);
                assert.equal(JSON.stringify(error).includes(secret), false);
                assert.equal(String(error.stack).includes(secret), false);
                return true;
            });
        }
    }
});

function rule(pattern: string): GlobalPolicyRule {
    return {pattern, accessType: PolicyAccessType.HTTP_GET, status: PolicyResponse.ALLOWED, reason: "saved reason"};
}

function savedSourceObject(key: ConfigKey): Record<string, unknown> {
    return savedSources[key] as Record<string, unknown>;
}

function exchange(key: ConfigKey = "web-search", content: string | null = canonicalConfigContent(savedSources[key])): ConfigExchange {
    return {binding, key, base_revision: null, change_id: changeId, modified_at: timestamp,
        schema_version: 1, content, sha256: configHash(content)};
}

function state(key: ConfigKey = "web-search", content: string | null = canonicalConfigContent(savedSources[key])): ConfigState {
    return {binding, key, revision: "1", schema_version: 1, content, sha256: configHash(content),
        updated_at: timestamp, outcome: "unchanged"};
}

function without(value: object, field: string): Record<string, unknown> {
    const result: Record<string, unknown> = {...value};
    delete result[field];
    return result;
}

function rejects(action: () => unknown): void {
    assert.throws(action, (error: unknown) => {
        assert.ok(error instanceof ConfigSyncProtocolError);
        assert.equal(error.message, "Invalid configuration synchronization data.");
        assert.equal(error.cause, undefined);
        return true;
    });
}
