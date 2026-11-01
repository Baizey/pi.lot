import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import type {PreparedBenchmarkCase, ValueRubric} from "../experiments/compaction/BenchmarkTypes.js";
import {fingerprint} from "../experiments/compaction/CompactionEvaluation.js";
import {loadHistoricalCriteria} from "../experiments/compaction/HistoricalCriteria.js";

function prepared(id: string): PreparedBenchmarkCase {
    const reference: PreparedBenchmarkCase["reference"] = [
        {id: "previous-summary", text: "Prior checkpoint: the task remains open."},
        {id: "history", text: "Keep the backup. Verify the result before removal."},
        {id: "turn-prefix", text: "Next action: inspect the trace."},
    ];
    return {definition: {id, cluster: id, source: {file: "/synthetic.json", checkpoint: 1, sha256: "a".repeat(64)},
        preparationHash: "b".repeat(64), referenceHash: fingerprint(reference), tokensBefore: 100, historyMessages: 1, prefixMessages: 1},
        reference, preparation: {firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
            tokensBefore: 100, fileOps: {read: new Set(), written: new Set(), edited: new Set()},
            settings: {enabled: true, reserveTokens: 100, keepRecentTokens: 100}}};
}

function criteria(cases: PreparedBenchmarkCase[]) {
    return {version: 1, cases: cases.map((item) => ({caseId: item.definition.id, referenceHash: item.definition.referenceHash,
        rubric: {version: 1, status: "draft", facts: [
            {id: "backup", statement: "Keep the backup.", category: "constraint", weight: 5, critical: true,
                evidence: [{inputId: "history", quote: "Keep the backup."}]},
            {id: "open", statement: "The task remains open.", category: "state", weight: 2, critical: true,
                evidence: [{inputId: "previous-summary", quote: "the task remains open"}]},
            {id: "inspect", statement: "Inspect the trace next.", category: "next-action", weight: 2, critical: false,
                evidence: [{inputId: "turn-prefix", quote: "inspect the trace"}]},
        ]} satisfies ValueRubric,
        questions: [{id: "continue", question: "What is the current state and what must be retained?", factIds: ["backup", "open"]}]}))};
}

async function fixture(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "historical-criteria-"));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const file = path.join(directory, "criteria.json");
    const cases = [prepared("first"), prepared("second")];
    const value = criteria(cases);
    const save = (input: unknown = value) => writeFile(file, JSON.stringify(input), {mode: 0o600});
    await save();
    return {file, cases, value, save};
}

test("historical criteria are hash-pinned draft rubrics using the full reference, in selected case order", async (t) => {
    const {file, cases, value, save} = await fixture(t);
    value.cases.reverse();
    await save();
    const result = await loadHistoricalCriteria(file, cases);
    assert.equal(result.hash, fingerprint(JSON.stringify(value)));
    assert.deepEqual(result.cases.map((item) => item.definition.id), ["first", "second"]);
    assert.equal(result.cases[0]!.definition.rubric!.status, "draft");
    assert.equal(result.cases[0]!.definition.rubric!.facts.length, 3);
    assert.deepEqual(result.questions.first, value.cases[1]!.questions);
    assert.deepEqual(result.questions.second, value.cases[0]!.questions);
    await writeFile(file, JSON.stringify(value, null, 2));
    const reformatted = await loadHistoricalCriteria(file, cases);
    assert.notEqual(reformatted.hash, result.hash, "hash covers exact raw file text");
});

test("loading never mutates prepared cases, definitions, sources or preparation", async (t) => {
    const {file, cases} = await fixture(t);
    const before = structuredClone(cases);
    const result = await loadHistoricalCriteria(file, cases);
    assert.deepEqual(cases, before);
    assert.notEqual(result.cases, cases);
    assert.notEqual(result.cases[0], cases[0]);
    assert.notEqual(result.cases[0]!.definition, cases[0]!.definition);
    assert.equal(result.cases[0]!.preparation, cases[0]!.preparation);
    assert.equal(result.cases[0]!.reference, cases[0]!.reference);
    assert.equal(cases[0]!.definition.rubric, undefined);
    result.cases[0]!.definition.rubric!.facts[0]!.statement = "Changed loaded rubric";
    result.questions.first![0]!.factIds.push("inspect");
    assert.deepEqual(cases, before);
    const again = await loadHistoricalCriteria(file, cases);
    assert.equal(again.cases[0]!.definition.rubric!.facts[0]!.statement, "Keep the backup.");
    assert.deepEqual(again.questions.first![0]!.factIds, ["backup", "open"]);
});

test("rejects malformed external shape, non-draft status and inexact selected-case/hash coverage", async (t) => {
    const {file, cases, value, save} = await fixture(t);
    for (const bad of [null, [], {}, {version: 2, cases: value.cases}, {version: 1, cases: {}},
        {version: 1, cases: []}, {version: 1, cases: [value.cases[0]]},
        {version: 1, cases: [value.cases[0], value.cases[0]]},
        {...value, extra: true}]) {
        await save(bad);
        await assert.rejects(loadHistoricalCriteria(file, cases));
    }
    for (const replacement of [{caseId: "unselected"}, {referenceHash: "wrong"}, {referenceHash: null},
        {rubric: {...value.cases[0]!.rubric, status: "curated"}}, {questions: null}, {questions: []}]) {
        const changed = structuredClone(value);
        Object.assign(changed.cases[0]!, replacement);
        await save(changed);
        await assert.rejects(loadHistoricalCriteria(file, cases));
    }
    await save();
    await assert.rejects(loadHistoricalCriteria(file, [cases[0]!, cases[0]!]));
    await assert.rejects(loadHistoricalCriteria(file, []));
    await writeFile(file, "not JSON");
    await assert.rejects(loadHistoricalCriteria(file, cases));
});

test("evidence schema and contiguous quotes are checked without self-certifying semantic entailment", async (t) => {
    const {file, cases, value, save} = await fixture(t);
    for (const replacement of [
        {evidence: [{inputId: "history", quote: "Keep the backup … before removal"}]},
        {evidence: [{inputId: "turn-prefix", quote: "Keep the backup."}]},
        {evidence: [{inputId: "unknown", quote: "Keep the backup."}]},
        {evidence: []}, {weight: 0}, {critical: "yes"}, {category: "invented"}, {statement: ""},
        {id: "open"},
    ]) {
        const changed = structuredClone(value);
        Object.assign(changed.cases[0]!.rubric.facts[0]!, replacement);
        await save(changed);
        await assert.rejects(loadHistoricalCriteria(file, cases));
    }
    const changed = structuredClone(value);
    changed.cases[0]!.rubric.facts[0]!.statement = "A draft claim still requires independent semantic review.";
    await save(changed);
    assert.equal((await loadHistoricalCriteria(file, cases)).cases[0]!.definition.rubric!.status, "draft");
});

test("questions require unique IDs, valid unique fact references and complete critical-fact coverage", async (t) => {
    const {file, cases, value, save} = await fixture(t);
    const original = value.cases[0]!.questions[0]!;
    for (const questions of [
        [{...original, id: " "}], [{...original, question: " "}], [original, original],
        [{...original, factIds: []}], [{...original, factIds: ["missing"]}],
        [{...original, factIds: ["backup", "backup", "open"]}],
        [{...original, factIds: ["backup"]}], [{...original, factIds: ["backup", " "]}],
        [{...original, unexpected: true}], [null],
    ]) {
        const changed = structuredClone(value);
        Object.assign(changed.cases[0]!, {questions});
        await save(changed);
        await assert.rejects(loadHistoricalCriteria(file, cases));
    }
    // Different questions may legitimately cover the same fact.
    value.cases[0]!.questions.push({...original, id: "followup"});
    await save();
    assert.equal((await loadHistoricalCriteria(file, cases)).questions.first!.length, 2);
});
