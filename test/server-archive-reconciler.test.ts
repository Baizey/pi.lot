import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {
    type ArchiveCandidate, type ArchiveCanonicalSnapshot, reconcileArchive,
} from "../src/server/ArchiveReconciler.js";
import {type ArchiveMetadata, type Revision, ArchiveProtocolError} from "../src/server/ArchiveProtocol.js";
import {SessionKind} from "../src/sessions/SessionIdentity.js";

const revision: Revision = {
    binding: {server_id: "server", namespace_id: "namespace", history_generation: "generation"},
    seq: "9007199254740993",
};
const condition = {kind: "exact_base_revision" as const, revision};
const supported = {preservationSupported: true};
const unsupported = {preservationSupported: false};
const classification: ArchiveMetadata = {kind: SessionKind.Subagent, root_session_id: "root"};

function candidate(body: string | Buffer, metadata: ArchiveMetadata | null = null): ArchiveCandidate {
    return {sessionId: "session", body: Buffer.isBuffer(body) ? body : Buffer.from(body), metadata};
}

function canonical(body: string | Buffer, metadata: ArchiveMetadata | null = null): ArchiveCanonicalSnapshot {
    return {body: Buffer.isBuffer(body) ? body : Buffer.from(body), metadata, revision};
}

test("verified absence publishes with an absent condition without requiring preservation", () => {
    for (const options of [supported, unsupported]) {
        assert.deepEqual(reconcileArchive(candidate("native bytes"), null, options), {
            kind: "publish", condition: {kind: "absent"},
        });
    }
});

test("equal bytes and equivalent normalized metadata are covered at the coherent revision", () => {
    const localMetadata: ArchiveMetadata = {
        summary: "summary", counts: {tool_calls: 3, assistant_messages: 2, user_messages: 1},
        last_activity_at: "2026-04-01T02:00:00+02:00", started_at: "2026-04-01t00:00:00z",
        title: "title", root_session_id: "root", kind: SessionKind.Subagent,
    };
    const remoteMetadata: ArchiveMetadata = {
        kind: SessionKind.Subagent, root_session_id: "root", title: "title",
        started_at: "2026-04-01T00:00:00.000Z", last_activity_at: "2026-04-01T00:00:00.000Z",
        counts: {user_messages: 1, assistant_messages: 2, tool_calls: 3}, summary: "summary",
    };
    for (const options of [supported, unsupported]) {
        for (const [local, remote] of [[localMetadata, remoteMetadata], [null, null], [{}, {}],
            [{title: undefined}, {}]]) {
            assert.deepEqual(reconcileArchive(candidate("same", local), canonical("same", remote), options), {
                kind: "covered", revision,
            });
        }
    }
});

test("equal bodies retain first canonical metadata and preserve incoming differences in either order", () => {
    const pairs: [ArchiveMetadata | null, ArchiveMetadata | null][] = [
        [null, {}], [null, {title: "title"}], [{title: "first"}, {title: "second"}],
        [{title: "title"}, {title: " title "}],
        [{summary: "first"}, {summary: "second"}],
        [{started_at: "2026-04-01T00:00:00Z"}, {started_at: "2026-04-02T00:00:00Z"}],
        [{last_activity_at: "2026-04-01T00:00:00Z"}, {last_activity_at: "2026-04-02T00:00:00Z"}],
        [{counts: {user_messages: 1, assistant_messages: 0, tool_calls: 0}},
            {counts: {user_messages: 2, assistant_messages: 0, tool_calls: 0}}],
        [classification, {...classification, kind: SessionKind.PolicyApprover}],
        [classification, {...classification, root_session_id: "other-root"}],
    ];
    for (const [first, second] of pairs) {
        for (const [local, remote] of [[first, second], [second, first]]) {
            assert.deepEqual(reconcileArchive(candidate("same", local), canonical("same", remote), supported), {
                kind: "preserve-uploaded", reason: "metadata",
            });
            assert.deepEqual(reconcileArchive(candidate("same", local), canonical("same", remote), unsupported), {
                kind: "defer", reason: "preservation-unsupported",
            });
        }
    }
});

test("proper byte extensions publish at the downloaded revision and shorter candidates never truncate", () => {
    for (const options of [supported, unsupported]) {
        for (const [shorter, longer] of [["a", "aa"], ["", "a"], ["line\n", "line\nnext\n"]]) {
            assert.deepEqual(reconcileArchive(candidate(longer), canonical(shorter), options), {
                kind: "publish", condition,
            });
            assert.deepEqual(reconcileArchive(candidate(shorter), canonical(longer), options), {
                kind: "covered", revision,
            });
        }
    }
});

test("ordinary prefix descriptions follow the longer body without retaining earlier descriptions", () => {
    const descriptions: ArchiveMetadata = {
        title: "short title", summary: "short summary", started_at: "2026-04-01T00:00:00Z",
        last_activity_at: "2026-04-01T00:00:00Z", counts: {user_messages: 1, assistant_messages: 2, tool_calls: 3},
    };
    const alternatives: (ArchiveMetadata | null)[] = [null, {}, {
        title: "long title", summary: "long summary", started_at: "2026-04-02T00:00:00Z",
        last_activity_at: "2026-04-03T00:00:00Z", counts: {user_messages: 4, assistant_messages: 5, tool_calls: 6},
    }];
    for (const options of [supported, unsupported]) {
        for (const longer of alternatives) {
            assert.deepEqual(reconcileArchive(candidate("a", descriptions), canonical("ab", longer), options), {
                kind: "covered", revision,
            });
            assert.deepEqual(reconcileArchive(candidate("ab", longer), canonical("a", descriptions), options), {
                kind: "publish", condition,
            });
        }
        // Null versus {} matters for equal snapshots, not a historical prefix description ledger.
        assert.deepEqual(reconcileArchive(candidate("a", {}), canonical("ab", null), options), {
            kind: "covered", revision,
        });
        assert.deepEqual(reconcileArchive(candidate("ab", {}), canonical("a", null), options), {
            kind: "publish", condition,
        });
    }
});

const assertionLosses: {name: string; shorter: ArchiveMetadata; longer: ArchiveMetadata | null}[] = [
    {name: "absent metadata", shorter: classification, longer: null},
    {name: "empty metadata", shorter: classification, longer: {}},
    {name: "omitted kind", shorter: classification, longer: {root_session_id: "root"}},
    {name: "contradictory kind", shorter: classification,
        longer: {...classification, kind: SessionKind.PolicyApprover}},
    {name: "contradictory root", shorter: classification, longer: {...classification, root_session_id: "other-root"}},
    {name: "omitted standalone root", shorter: {root_session_id: "root"}, longer: {title: "new title"}},
    {name: "contradictory standalone root", shorter: {root_session_id: "root"}, longer: {root_session_id: "other-root"}},
];
for (const {name, shorter, longer} of assertionLosses) {
    test(`proper prefixes preserve the shorter explicit assertion: ${name}`, () => {
        assert.deepEqual(reconcileArchive(candidate("a", shorter), canonical("ab", longer), supported), {
            kind: "preserve-uploaded", reason: "metadata",
        });
        assert.deepEqual(reconcileArchive(candidate("ab", longer), canonical("a", shorter), supported), {
            kind: "preserve-current-then-publish", reason: "metadata", condition,
        });
        for (const [local, remote] of [
            [candidate("a", shorter), canonical("ab", longer)],
            [candidate("ab", longer), canonical("a", shorter)],
        ] as const) {
            assert.deepEqual(reconcileArchive(local, remote, unsupported), {
                kind: "defer", reason: "preservation-unsupported",
            });
        }
    });
}

test("prefix assertions already retained or newly supplied by the longer body need no preservation", () => {
    for (const shorter of [null, {}, {root_session_id: "root"}, {...classification, title: "old"}]) {
        const longer = {...classification, title: "new"};
        for (const options of [supported, unsupported]) {
            assert.deepEqual(reconcileArchive(candidate("a", shorter), canonical("ab", longer), options), {
                kind: "covered", revision,
            });
            assert.deepEqual(reconcileArchive(candidate("ab", longer), canonical("a", shorter), options), {
                kind: "publish", condition,
            });
        }
    }
});

test("divergent bodies prefer greater byte length before digest and preserve the nonselected body", () => {
    assert.ok(createHash("sha256").update("bb").digest("hex") < createHash("sha256").update("a").digest("hex"));
    assert.deepEqual(reconcileArchive(candidate("bb"), canonical("a"), supported), {
        kind: "preserve-current-then-publish", reason: "divergence", condition,
    });
    assert.deepEqual(reconcileArchive(candidate("a"), canonical("bb"), supported), {
        kind: "preserve-uploaded", reason: "divergence",
    });
});

test("equal-length divergent bodies prefer lexicographically greater lowercase SHA-256, not body order", () => {
    assert.ok(createHash("sha256").update("a").digest("hex") > createHash("sha256").update("b").digest("hex"));
    assert.deepEqual(reconcileArchive(candidate("a"), canonical("b"), supported), {
        kind: "preserve-current-then-publish", reason: "divergence", condition,
    });
    assert.deepEqual(reconcileArchive(candidate("b"), canonical("a"), supported), {
        kind: "preserve-uploaded", reason: "divergence",
    });
});

test("unsupported divergence defers in both directions instead of manufacturing coverage or publishing", () => {
    for (const [local, remote] of [["a", "b"], ["b", "a"], ["bb", "a"], ["a", "bb"]]) {
        assert.deepEqual(reconcileArchive(candidate(local), canonical(remote), unsupported), {
            kind: "defer", reason: "preservation-unsupported",
        });
    }
});

test("body decisions are exact bytes, not UTF-8 decoding, trimming, JSON meaning, or character length", () => {
    const invalidA = Buffer.from([0xff]);
    const invalidB = Buffer.from([0xfe]);
    assert.equal(invalidA.toString(), invalidB.toString());
    const pairs: [Buffer, Buffer][] = [
        [invalidA, invalidB], [Buffer.from("x\r\n"), Buffer.from("x\n")],
        [Buffer.from('{"a":1}'), Buffer.from('{ "a": 1 }')],
    ];
    for (const [local, remote] of pairs) {
        assert.deepEqual(reconcileArchive(candidate(local), canonical(remote), unsupported), {
            kind: "defer", reason: "preservation-unsupported",
        });
    }
    // A partial UTF-8 sequence still is a byte prefix; native validity is not a scoring rule.
    assert.deepEqual(reconcileArchive(candidate(Buffer.from([0xc3])), canonical(Buffer.from([0xc3, 0xa9])), unsupported), {
        kind: "covered", revision,
    });
    assert.deepEqual(reconcileArchive(candidate("€"), canonical("ab"), supported), {
        kind: "preserve-current-then-publish", reason: "divergence", condition,
    });
    assert.deepEqual(reconcileArchive(candidate(Buffer.from([0, 0xff])), canonical(Buffer.from([0, 0xff])), unsupported), {
        kind: "covered", revision,
    });
});

test("unknown/incoherent remote metadata defers every byte relationship even when preservation is supported", () => {
    for (const [local, remote] of [["same", "same"], ["a", "ab"], ["ab", "a"], ["a", "b"], ["bb", "a"]]) {
        for (const options of [supported, unsupported]) {
            assert.deepEqual(reconcileArchive(candidate(local), {...canonical(remote), metadata: undefined}, options), {
                kind: "defer", reason: "unknown-remote-metadata",
            });
        }
    }
});

test("metadata validity is not silently repaired or treated as equivalence", () => {
    assert.throws(() => reconcileArchive(candidate("same", {kind: SessionKind.Main}), canonical("same"), supported),
        ArchiveProtocolError);
    assert.throws(() => reconcileArchive(candidate("same"), canonical("same", {started_at: "invalid"}), supported),
        ArchiveProtocolError);
});

test("decisions are repeatable and leave bodies, metadata, and revision unchanged without merging assertions", () => {
    const local = candidate("ab", Object.freeze({title: "longer"}));
    const remote = canonical("a", Object.freeze({...classification, title: "shorter"}));
    const before = JSON.stringify({local, remote});
    for (let attempt = 0; attempt < 3; attempt++) {
        assert.deepEqual(reconcileArchive(local, remote, supported), {
            kind: "preserve-current-then-publish", reason: "metadata", condition,
        });
        assert.equal(JSON.stringify({local, remote}), before);
    }
});
