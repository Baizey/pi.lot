import assert from "node:assert/strict";
import {test} from "node:test";
import {convertToLlm, serializeConversation} from "@earendil-works/pi-coding-agent";
import {fingerprint} from "../experiments/compaction/CompactionEvaluation.js";
import type {PreparedBenchmarkCase, ReferenceInput} from "../experiments/compaction/BenchmarkTypes.js";
import {validationContinuationQuestions, validationScenarios} from "../experiments/compaction/CondenserValidationScenarios.js";
import {validateRubric} from "../experiments/compaction/ValueRetention.js";

// Pin only integrity metadata here: no heldout answer text is copied into test output or snapshots.
const sourceHashes: Record<string, string> = {
    "validation-dev-01": "3ba0d5af02c40deaa0f2c75fd198f4b92928457f398b1f5900d9d58ab07c0745",
    "validation-dev-02": "1dd0545f93504d040541871201ecd8f8bef05122fc20fe9d37f0113f1dd21b9f",
    "validation-dev-03": "915ceb77af30ccbe648a42497b2c93a18400d2c01972253980f63ce7c2915ac9",
    "validation-dev-04": "38816207eb63dc5abb827ee0b16d66778aa6b40ca42c2e1b22a6fc10424b5a62",
    "validation-held-01": "4bc0336d492538124ea277235d3e7fb748daa31ee9c91f620bdc3d38b6aff084",
    "validation-held-02": "d8bd8ce3be59b0775f25060ebf2c3428f38903fc9ed58e9e530beadab39dc95b",
    "validation-held-03": "40027f81707028db34aabbf6fe260919359d2ba75386e0479375c24440031da6",
    "validation-held-04": "f0093209b9cffeb0ce6a4191954e4665df9d834c7255476a03397befd0418401"
};

// Definition pins also cover draft statements, weights, evidence, and all preparation/reference hashes.
const definitionHashes: Record<string, string> = {
    "validation-dev-01": "5b4b2f0b1aae32395e8b212bf1867d4736a2f8216860238c68cc406ba40142b3",
    "validation-dev-02": "383498a6f6afc714cc04abcbca7e4201490ace066b8f19f7057f86f905fecc30",
    "validation-dev-03": "61092020b237a78c2917b276000f62ea1f74a3bc1d5d2000d9a340cff558eb0f",
    "validation-dev-04": "7b1dc286f0a6d7e002019f1e6574ba251f50e75e4b481d4bbab16b476affc09e",
    "validation-held-01": "49397bd4f3b1ad8372f6c29cf8a13b2bfda4077e2a0ff8d7ddfa86d9208ed72f",
    "validation-held-02": "97300e5354f6833343c01acda13a135f37384b890e1bf3507ced03e7115c5c5f",
    "validation-held-03": "51cb29365fec9fcb79cf62e81127060c77a1ec1882d5a7432055c680a7dd4f12",
    "validation-held-04": "46cb1ee5b6653f11d77292dd105ff0bc0b1f8567a5ff682b7bccc3e80b0358c9"
};

const criticalCoreFacts = new Set([
    "validation-dev-01:d7",
    "validation-dev-03:d7",
    "validation-dev-03:d13",
    "validation-held-01:h7",
    "validation-held-03:h14",
    "validation-held-04:h5"
]);

function allCases(suite: Awaited<ReturnType<typeof validationScenarios>>): PreparedBenchmarkCase[] {
    return [...suite.development, ...suite.holdout];
}

function nativeReference({preparation}: PreparedBenchmarkCase): ReferenceInput[] {
    const result: ReferenceInput[] = [];
    if (preparation.previousSummary) result.push({id: "previous-summary", text: preparation.previousSummary});
    if (preparation.messagesToSummarize.length) {
        result.push({id: "history", text: serializeConversation(convertToLlm(preparation.messagesToSummarize))});
    }
    if (preparation.turnPrefixMessages.length) {
        result.push({id: "turn-prefix", text: serializeConversation(convertToLlm(preparation.turnPrefixMessages))});
    }
    return result;
}

function sourceFingerprint(item: PreparedBenchmarkCase): string {
    return fingerprint({
        previousSummary: item.preparation.previousSummary,
        history: item.reference.find((input) => input.id === "history")?.text,
        turnPrefix: item.reference.find((input) => input.id === "turn-prefix")?.text
    });
}

test("independent validation suite has disjoint partitions and native whole/split/iterative coverage", async () => {
    const suite = await validationScenarios();
    assert.equal(suite.development.length, 4);
    assert.equal(suite.holdout.length, 4);
    const cases = allCases(suite);
    assert.equal(new Set(cases.map(({definition}) => definition.id)).size, 8);
    assert.equal(new Set(cases.map(({definition}) => definition.cluster)).size, 8);
    assert.deepEqual(cases.map(({definition}) => definition.id).sort(), Object.keys(sourceHashes).sort());
    for (const [partition, entries] of Object.entries(suite)) {
        const modes = new Set<string>();
        for (const {definition, preparation} of entries) {
            assert.ok(definition.id.startsWith(partition === "development" ? "validation-dev-" : "validation-held-"));
            modes.add(preparation.isSplitTurn ? "split" : preparation.previousSummary ? "iterative" : "whole");
            assert.ok(!(preparation.isSplitTurn && preparation.previousSummary), "split and iterative are distinct fixtures");
            const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
            assert.ok(messages.length >= 16 && messages.length <= 28, "8-14 complete conversational pairs");
            assert.equal(messages.length % 2, 0);
            let visibleChars = 0;
            for (const [index, message] of messages.entries()) {
                assert.equal(message.role, index % 2 ? "assistant" : "user");
                assert.ok(Array.isArray(message.content));
                if (!Array.isArray(message.content)) throw new Error("Expected native text content");
                for (const part of message.content) {
                    assert.equal(part.type, "text");
                    if (part.type === "text") visibleChars += part.text.length;
                }
            }
            assert.ok(visibleChars >= 4_000 && visibleChars <= 12_000, "visible conversation length, excluding prior summary");
        }
        assert.deepEqual([...modes].sort(), ["iterative", "split", "whole"]);
    }
});

test("validation references are the native visible serialization and split evidence reaches the final pair", async () => {
    for (const item of allCases(await validationScenarios())) {
        assert.deepEqual(item.reference, nativeReference(item));
        const {preparation, definition} = item;
        assert.equal(definition.historyMessages, preparation.messagesToSummarize.length);
        assert.equal(definition.prefixMessages, preparation.turnPrefixMessages.length);
        assert.equal(definition.source.checkpoint, definition.historyMessages + definition.prefixMessages);
        assert.equal(preparation.firstKeptEntryId, `${definition.id}:boundary:0001`);
        assert.equal(definition.prefixMessages, preparation.isSplitTurn ? 2 : 0);
        if (preparation.isSplitTurn) {
            assert.equal(preparation.turnPrefixMessages[0]?.role, "user");
            assert.equal(preparation.turnPrefixMessages[1]?.role, "assistant");
            assert.ok(definition.rubric?.facts.some((fact) => fact.evidence.some((evidence) => evidence.inputId === "turn-prefix")),
                "split fixtures must grade information in the native prefix, not just earlier history");
        }
        assert.equal(item.reference.some(({id}) => id === "previous-summary"), Boolean(preparation.previousSummary));
    }
});

test("validation source, preparation, reference fingerprints and metadata remain reproducible", async () => {
    const suite = await validationScenarios();
    assert.deepEqual(suite, await validationScenarios());
    for (const item of allCases(suite)) {
        const {definition, preparation, reference} = item;
        assert.equal(sourceFingerprint(item), definition.source.sha256);
        assert.equal(definition.source.sha256, sourceHashes[definition.id]);
        assert.equal(fingerprint(definition), definitionHashes[definition.id]);
        assert.equal(definition.preparationHash, fingerprint(preparation));
        assert.equal(definition.referenceHash, fingerprint(reference));
        assert.equal(definition.source.file, `/tmp/synthetic-condenser/${definition.id}.conversation.txt`);
        assert.equal(definition.tokensBefore, preparation.tokensBefore);
        assert.equal(definition.tokensBefore, 20_000 + Math.ceil(reference.reduce((total, input) => total + input.text.length, 0) / 3.5));
        assert.deepEqual(preparation.settings, {enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_000});
        for (const paths of Object.values(preparation.fileOps)) {
            assert.ok(paths instanceof Set);
            for (const file of paths) assert.ok(file.startsWith("/"), "actionable file metadata must be absolute");
        }
    }
});

test("draft validation facts retain literal source anchors with explicit critical-core exceptions", async () => {
    const seenCoreFacts = new Set<string>();
    for (const {definition, reference} of allCases(await validationScenarios())) {
        const rubric = definition.rubric;
        assert.ok(rubric);
        assert.equal(rubric.status, "draft");
        assert.ok(rubric.facts.length >= 10 && rubric.facts.length <= 16);
        assert.deepEqual(validateRubric(rubric, reference), rubric);
        assert.equal(new Set(rubric.facts.map((fact) => fact.statement)).size, rubric.facts.length);
        for (const fact of rubric.facts) {
            assert.equal(fact.evidence.length, 1);
            const citation = fact.evidence[0]!;
            assert.ok(citation.inputId === "history" || citation.inputId === "turn-prefix");
            const input = reference.find(({id}) => id === citation.inputId);
            assert.ok(input?.text.includes(citation.quote));
            // Verbatim propositions have basic literal entailment. Explicit core statements keep full
            // evidence but exclude incidental detail; these still need independent semantic re-audit.
            const key = `${definition.id}:${fact.id}`;
            if (criticalCoreFacts.has(key)) {
                assert.equal(fact.critical, true);
                assert.ok(fact.statement.trim());
                assert.notEqual(fact.statement, citation.quote);
                seenCoreFacts.add(key);
            } else {
                assert.equal(fact.statement, citation.quote);
            }
            assert.ok(citation.quote.length > 25);
            assert.ok(fact.critical ? fact.weight === 5 : fact.weight === 2);
        }
        for (const input of reference) assert.ok(!/\.csv, (?:tab|sheet)\b/.test(input.text), "worksheet locators require a workbook format");
    }
    assert.deepEqual(seenCoreFacts, criticalCoreFacts);
});

test("audit-added action-changing facts retain their category and intended continuation mapping", async () => {
    const cases = new Map(allCases(await validationScenarios()).map((item) => [item.definition.id, item]));
    const additions = [
        {caseId: "validation-dev-03", factId: "d13", category: "constraint", questionId: "schedule"},
        {caseId: "validation-dev-04", factId: "d14", category: "constraint", questionId: "evidence"},
        {caseId: "validation-held-02", factId: "h13", category: "next-action", questionId: "tour"},
        {caseId: "validation-held-03", factId: "h13", category: "state", questionId: "handoff"},
        {caseId: "validation-held-03", factId: "h14", category: "constraint", questionId: "field"}
    ];
    for (const addition of additions) {
        const fact = cases.get(addition.caseId)?.definition.rubric?.facts.find(({id}) => id === addition.factId);
        assert.ok(fact);
        assert.equal(fact.category, addition.category);
        assert.equal(fact.critical, true);
        assert.equal(fact.weight, 5);
        const followup = validationContinuationQuestions[addition.caseId]?.find(({id}) => id === addition.questionId);
        assert.ok(followup?.factIds.includes(addition.factId));
    }
});

test("continuations cover every critical fact with bounded answer-free followup mappings", async () => {
    const cases = allCases(await validationScenarios());
    assert.deepEqual(Object.keys(validationContinuationQuestions).sort(), cases.map(({definition}) => definition.id).sort());
    for (const {definition} of cases) {
        const facts = definition.rubric!.facts;
        const byId = new Map(facts.map((fact) => [fact.id, fact]));
        const questions = validationContinuationQuestions[definition.id]!;
        assert.ok(questions.length >= 2 && questions.length <= 3);
        assert.equal(new Set(questions.map((question) => question.id)).size, questions.length);
        const covered = new Set<string>();
        for (const followup of questions) {
            assert.ok(followup.id.trim());
            assert.ok(followup.question.length >= 40 && followup.question.length < 250);
            assert.ok(followup.factIds.length >= 2 && followup.factIds.length <= 5);
            assert.equal(new Set(followup.factIds).size, followup.factIds.length);
            assert.ok(followup.factIds.some((id) => byId.get(id)?.critical));
            for (const id of followup.factIds) {
                assert.ok(byId.has(id), "followup references a fact from its own case");
                covered.add(id);
            }
            assert.ok(!facts.some((fact) => followup.question.includes(fact.statement)), "question must not supply the answer");
            assert.ok(!/[\w.-]+@[\w.-]+|\/(?:srv|work|tour|field|quality|facilities|radio|exhibits)\//.test(followup.question),
                "solver must recover actionable locators from checkpoint, not question hints");
        }
        assert.ok(facts.filter((fact) => fact.critical).every((fact) => covered.has(fact.id)));
        assert.ok(facts.every((fact) => covered.has(fact.id)), "all draft facts have a practical continuation use");
    }
});

test("each validation preparation owns fresh metadata and fingerprint changes respect the source boundary", async () => {
    const original = allCases(await validationScenarios());
    const fresh = allCases(await validationScenarios());
    for (const [index, item] of original.entries()) {
        const peer = fresh[index]!;
        assert.notEqual(item.preparation, peer.preparation);
        assert.notEqual(item.preparation.messagesToSummarize, peer.preparation.messagesToSummarize);
        assert.notEqual(item.preparation.fileOps.read, peer.preparation.fileOps.read);
        assert.notEqual(item.definition.rubric, peer.definition.rubric);
        item.preparation.fileOps.read.add("/test-only/metadata-change");
        assert.ok(!peer.preparation.fileOps.read.has("/test-only/metadata-change"));
        assert.notEqual(fingerprint(item.preparation), item.definition.preparationHash);
        assert.equal(sourceFingerprint(item), item.definition.source.sha256, "file metadata isn't visible conversation text");
        const changed: PreparedBenchmarkCase = {...item, reference: item.reference.map((input) =>
            input.id === "history" ? {...input, text: `${input.text}\nchanged source`} : input)};
        assert.notEqual(fingerprint(changed.reference), item.definition.referenceHash);
        assert.notEqual(sourceFingerprint(changed), item.definition.source.sha256);
    }
    assert.deepEqual(fresh, allCases(await validationScenarios()), "caller mutation must not poison later preparations");
});
