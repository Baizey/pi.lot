import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {CompactionCorpus, gradingInputs, referenceInputs} from "../experiments/compaction/BenchmarkCorpus.js";
import {compactionFixtures} from "../experiments/compaction/CompactionFixtures.js";
import {fingerprint} from "../experiments/compaction/CompactionEvaluation.js";
import type {PreparedBenchmarkCase} from "../experiments/compaction/BenchmarkTypes.js";

async function writePrivateJson(file: string, value: unknown): Promise<void> {
    await writeFile(file, JSON.stringify(value), {mode: 0o600});
}

const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};

async function sourceFile(directory: string, id: string, checkpoints: number, child = false): Promise<string> {
    const manager = SessionManager.inMemory("/historical-project", {id, ...(child ? {parentSession: "/parent.jsonl"} : {})});
    for (let index = 0; index < checkpoints; index++) {
        manager.appendMessage({role: "user", content: `SOURCE_${id}_${index} ` + "u".repeat(84000), timestamp: 1});
        const recent = manager.appendMessage({role: "assistant", content: [{type: "text", text: "r".repeat(84000)}],
            api: "openai-responses", provider: "offline", model: "offline", usage, stopReason: "stop", timestamp: 2});
        manager.appendCompaction(`SAVED_CHECKPOINT_${index}_IS_NOT_ITS_OWN_INPUT`, recent, 42000);
    }
    const file = path.join(directory, `${id}.jsonl`);
    await writeFile(file, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return file;
}

test("corpus discovery spans sessions round-robin, records rejections and never rewrites source files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-corpus-test-"));
    try {
        const a = await sourceFile(directory, "source-a", 2);
        const b = await sourceFile(directory, "source-b", 2);
        const child = await sourceFile(directory, "child", 1, true);
        const empty = await sourceFile(directory, "empty", 0);
        const before = await readFile(a, "utf8");
        const alias = path.join(directory, "zz-alias.jsonl");
        await writeFile(alias, before);
        const owner = new CompactionCorpus();
        const corpus = await owner.discover([b, a, a, empty, child, alias], 3);
        assert.deepEqual(corpus.cases.map((item) => [item.cluster, item.source.checkpoint]), [["source-a", 0], ["source-b", 0], ["source-a", 1]]);
        assert.equal(corpus.rejected.length, 3);
        await assert.rejects(owner.prepare({...corpus.cases[0]!, source: {...corpus.cases[0]!.source, file: child}}), /Child\/fork/);
        const prepared = await owner.prepare(corpus.cases[0]!);
        assert.ok(prepared.reference.some((item) => item.text.includes("SOURCE_source-a_0")));
        assert.ok(!prepared.reference.some((item) => item.text.includes("SAVED_CHECKPOINT_0_IS_NOT_ITS_OWN_INPUT")));
        assert.equal(await readFile(a, "utf8"), before);
        const manifest = path.join(directory, "manifest.json");
        await writePrivateJson(manifest, corpus);
        const loaded = await owner.read(manifest);
        assert.deepEqual(loaded.cases, corpus.cases);
        assert.deepEqual(loaded.rejected, corpus.rejected);
        await writeFile(a, before + "\n");
        await assert.rejects(owner.prepare(corpus.cases[0]!), /changed/);
    } finally { await rm(directory, {recursive: true, force: true}); }
});

test("corpus rejects duplicate cases, changed Pi version, invalid bounds and unsupported evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-corpus-test-"));
    try {
        const file = await sourceFile(directory, "source", 1);
        const owner = new CompactionCorpus();
        const corpus = await owner.discover([file], 1);
        const manifest = path.join(directory, "manifest.json");
        await writePrivateJson(manifest, {...corpus, cases: [corpus.cases[0], corpus.cases[0]]});
        await assert.rejects(owner.read(manifest), /unique/);
        await writePrivateJson(manifest, {...corpus, piVersion: "unknown-version"});
        await assert.rejects(owner.read(manifest), /Pi version/);
        await writePrivateJson(manifest, {...corpus, cases: [{...corpus.cases[0], tokensBefore: -1}]});
        await assert.rejects(owner.read(manifest), /tokensBefore/);
        await writePrivateJson(manifest, {...corpus, cases: [{...corpus.cases[0], rubric: {version: 1, status: "curated", facts: [{
            id: "wrong-source", statement: "This fact is not present", category: "state", weight: 5, critical: true,
            evidence: [{inputId: "history", quote: "SAVED_CHECKPOINT_0_IS_NOT_ITS_OWN_INPUT"}],
        }]}}]});
        await assert.rejects(owner.read(manifest), /source evidence/);
        const input = (await owner.prepare(corpus.cases[0]!)).reference.find((item) => item.text.includes("SOURCE_source_0"));
        assert.ok(input);
        const curated = {...corpus, cases: [{...corpus.cases[0]!, rubric: {version: 1, status: "curated", facts: [{
            id: "visible", statement: "Preserve the visible source identifier", category: "identifier", weight: 1, critical: false,
            evidence: [{inputId: input.id, quote: "SOURCE_source_0"}],
        }]}}]};
        await writePrivateJson(manifest, curated);
        const loaded = await owner.read(manifest);
        assert.equal(loaded.cases[0]!.rubric!.status, "curated");
        assert.equal((await owner.prepare(loaded.cases[0]!)).definition.rubric!.status, "curated");
        await writePrivateJson(manifest, {...curated, cases: [{...curated.cases[0], tokensBefore: curated.cases[0]!.tokensBefore + 1}]});
        await assert.rejects(owner.read(manifest), /changed/);
    } finally { await rm(directory, {recursive: true, force: true}); }
});

test("rubric reference uses native visible serialization, not raw thinking or truncated tool tails", async () => {
    const preparation = await compactionFixtures[0]!.prepare();
    const reference = referenceInputs({...preparation, previousSummary: "PRIOR_SUMMARY_IS_VALID_SOURCE", turnPrefixMessages: [], messagesToSummarize: [
        {role: "assistant", api: "openai-responses", provider: "offline", model: "offline", timestamp: 1, stopReason: "toolUse", usage,
            content: [{type: "thinking", thinking: "SECRET_THINKING"}, {type: "toolCall", id: "call", name: "read", arguments: {path: "/source"}}]},
        {role: "toolResult", toolCallId: "call", toolName: "read", timestamp: 2, isError: false,
            content: [{type: "text", text: "VISIBLE_TOOL_TEXT" + "x".repeat(3000) + "SECRET_TOOL_TAIL"}]},
    ]});
    const source = JSON.stringify(reference);
    assert.match(source, /PRIOR_SUMMARY_IS_VALID_SOURCE/);
    assert.match(source, /VISIBLE_TOOL_TEXT/);
    assert.doesNotMatch(source, /SECRET_THINKING|SECRET_TOOL_TAIL/);
});

test("grading context adds normalized native inventory without changing native references, preparation or hashes", async () => {
    const preparation = await compactionFixtures[0]!.prepare();
    preparation.fileOps = {read: new Set(["/z-read", "/a-read", "/overlap", "/written"]),
        written: new Set(["/written", "/overlap"]), edited: new Set(["/overlap", "/edited"])};
    const reference = referenceInputs(preparation);
    const source: PreparedBenchmarkCase = {preparation, reference, definition: {
        id: "synthetic-inventory", cluster: "synthetic", source: {file: "/synthetic.jsonl", checkpoint: 0, sha256: "a".repeat(64)},
        preparationHash: fingerprint(preparation), referenceHash: fingerprint(reference), tokensBefore: preparation.tokensBefore,
        historyMessages: preparation.messagesToSummarize.length, prefixMessages: preparation.turnPrefixMessages.length,
    }};
    const before = structuredClone(source);
    const result = gradingInputs(source);
    assert.notEqual(result, reference);
    assert.deepEqual(result.slice(0, -1), reference);
    const inventory = result.at(-1)!;
    assert.equal(inventory.id, "file-operations");
    assert.match(inventory.text, /Authoritative native assembly/);
    assert.match(inventory.text, /recorded file operations/);
    assert.match(inventory.text, /not verification of implementation correctness, completed procedures, or successful tests/);
    assert.doesNotMatch(inventory.text, /strategy|candidate|stock|rubric|duration|timing|cost|score/i);
    assert.deepEqual(JSON.parse(inventory.text.slice(inventory.text.indexOf("\n") + 1)),
        {readFiles: ["/a-read", "/z-read"], modifiedFiles: ["/edited", "/overlap", "/written"]});
    assert.deepEqual(source, before);
    assert.deepEqual(referenceInputs(preparation), reference);
    assert.equal(fingerprint(referenceInputs(preparation)), source.definition.referenceHash);
    assert.equal(fingerprint(preparation), source.definition.preparationHash);
    assert.ok(reference.every((input) => input.id !== "file-operations"));
    const reordered = {...source, preparation: {...preparation, fileOps: {
        read: new Set([...preparation.fileOps.read].reverse()), written: new Set([...preparation.fileOps.written].reverse()),
        edited: new Set([...preparation.fileOps.edited].reverse()),
    }}};
    assert.deepEqual(gradingInputs(reordered), result, "set insertion order cannot change grading inventory");
    const empty = gradingInputs({...source, preparation: {...preparation, fileOps: {read: new Set(), written: new Set(), edited: new Set()}}});
    assert.match(empty.at(-1)!.text, /"readFiles":\[\],"modifiedFiles":\[\]/);
});
