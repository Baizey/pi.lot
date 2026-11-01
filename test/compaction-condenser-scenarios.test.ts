import assert from "node:assert/strict";
import test from "node:test";
import {condenserScenarios, condenserScenarioVersion, continuationQuestions} from "../experiments/compaction/CondenserScenarios.js";
import {fingerprint} from "../experiments/compaction/CompactionEvaluation.js";
import {referenceInputs} from "../experiments/compaction/BenchmarkCorpus.js";
import {validateRubric} from "../experiments/compaction/ValueRetention.js";

const flattened = (groups: Awaited<ReturnType<typeof condenserScenarios>>) => [...groups.development, ...groups.holdout];

test("condenser scenarios use native serialized inputs and exact-source rubric evidence", async () => {
    const groups = await condenserScenarios();
    assert.equal(condenserScenarioVersion, 3);
    assert.equal(groups.development.length, 4);
    assert.equal(groups.holdout.length, 2);
    const cases = flattened(groups);
    assert.equal(new Set(cases.map(({definition}) => definition.id)).size, 6);
    assert.equal(new Set(cases.map(({definition}) => definition.cluster)).size, 6);

    let splitCases = 0;
    let iterativeCases = 0;
    let wholeCases = 0;
    for (const item of cases) {
        const {definition, preparation, reference} = item;
        assert.match(definition.id, /^generic-(change|incident|research|planning|analysis|drafting)-\d+$/);
        assert.match(definition.source.file, /^\/tmp\/synthetic-condenser\//);
        assert.equal(definition.source.sha256.length, 64);
        assert.equal(definition.preparationHash, fingerprint(preparation));
        assert.equal(definition.referenceHash, fingerprint(reference));
        assert.equal(fingerprint(reference), fingerprint(referenceInputs(preparation)));
        assert.equal(definition.tokensBefore, preparation.tokensBefore);
        assert.equal(definition.historyMessages, preparation.messagesToSummarize.length);
        assert.equal(definition.prefixMessages, preparation.turnPrefixMessages.length);
        assert.equal(definition.source.checkpoint, definition.historyMessages + definition.prefixMessages);
        assert.equal(definition.source.sha256, fingerprint({
            previousSummary: preparation.previousSummary,
            history: reference.find(({id}) => id === "history")?.text,
            turnPrefix: reference.find(({id}) => id === "turn-prefix")?.text
        }));
        assert.equal(preparation.firstKeptEntryId, `${definition.id}:boundary:0001`);
        assert.equal(preparation.settings.keepRecentTokens, 20_000);
        assert.equal(preparation.settings.reserveTokens, 16_000);
        assert.ok(preparation.tokensBefore > preparation.settings.keepRecentTokens);
        assert.ok(preparation.fileOps.read.size + preparation.fileOps.written.size + preparation.fileOps.edited.size > 0);

        if (preparation.isSplitTurn) {
            splitCases++;
            assert.ok(preparation.messagesToSummarize.length > 0, "split fixture retains earlier history");
            assert.ok(preparation.turnPrefixMessages.length > 0, "split fixture retains a partial current turn");
            assert.equal(preparation.turnPrefixMessages[0]?.role, "user", "prefix starts at its initiating user message");
            assert.equal(preparation.messagesToSummarize.at(-1)?.role, "assistant", "history ends before the current turn");
            assert.equal(preparation.turnPrefixMessages.at(-1)?.role, "assistant");
        } else if (preparation.previousSummary) {
            iterativeCases++;
            assert.ok(reference.some(({id, text}) => id === "previous-summary" && text === preparation.previousSummary));
            assert.ok(preparation.messagesToSummarize.length > 0);
            assert.ok(preparation.messagesToSummarize.every((message) =>
                !(message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === preparation.previousSummary))));
        } else {
            wholeCases++;
            assert.equal(preparation.turnPrefixMessages.length, 0);
        }

        assert.ok(continuationQuestions[definition.id]);
        assert.ok(continuationQuestions[definition.id]!.length >= 2 && continuationQuestions[definition.id]!.length <= 3);
        for (const question of continuationQuestions[definition.id]!) {
            assert.ok(question.question.endsWith("?") && question.question.length > 30);
            assert.ok(question.factIds.length >= 2 && question.factIds.length <= 5);
            assert.equal(new Set(question.factIds).size, question.factIds.length);
            for (const factId of question.factIds) assert.ok(definition.rubric!.facts.some(({id}) => id === factId));
        }

        const serializedSource = reference.filter(({id}) => id === "history" || id === "turn-prefix")
            .map(({text}) => text).join("\n");
        assert.ok(serializedSource.length >= 4_000 && serializedSource.length <= 12_000,
            `${definition.id} native source length ${serializedSource.length}`);
        const rubric = definition.rubric;
        assert.ok(rubric);
        assert.equal(rubric.version, 1);
        assert.equal(rubric.status, "draft");
        assert.deepEqual(validateRubric(rubric, reference), rubric);
        assert.ok(rubric.facts.length >= 7 && rubric.facts.length <= 10);
        assert.equal(new Set(rubric.facts.map(({id}) => id)).size, rubric.facts.length);
        for (const fact of rubric.facts) {
            assert.ok(fact.statement.trim());
            assert.ok(Number.isFinite(fact.weight) && fact.weight > 0);
            assert.ok(fact.evidence.length > 0);
            for (const evidence of fact.evidence) {
                const input = reference.find(({id}) => id === evidence.inputId);
                assert.ok(input, `missing evidence input ${evidence.inputId}`);
                assert.ok(input.text.includes(evidence.quote), `${definition.id}/${fact.id}: quote is absent from native input`);
            }
        }
    }
    assert.ok(splitCases >= 1 && iterativeCases >= 1 && wholeCases >= 1);
});

test("audited development criteria preserve timing, imputation and pending-publication qualifications", async () => {
    const {development} = await condenserScenarios();
    const facts = (id: string) => development.find((item) => item.definition.id === id)!.definition.rubric!.facts;
    const clock = facts("generic-change-01").find((fact) => fact.id === "fallback-clock")!;
    assert.equal(clock.critical, true);
    assert.match(clock.statement, /before awaiting the fetch/);
    assert.ok(continuationQuestions["generic-change-01"]!.some((question) => question.factIds.includes(clock.id)));
    const research = facts("generic-research-03");
    assert.doesNotMatch(research.find((fact) => fact.id === "sample")!.statement, /complete paired/);
    assert.ok(continuationQuestions["generic-research-03"]!.some((question) => question.factIds.includes("imputation")));
    const planning = facts("generic-planning-04");
    assert.match(planning.find((fact) => fact.id === "open-confirmations")!.statement, /publication may proceed/);
    assert.match(planning.find((fact) => fact.id === "staffing")!.statement, /another stays at the tables/);
});

test("scenario factories are deterministic fresh clones with preparation-matched references", async () => {
    const first = await condenserScenarios();
    const second = await condenserScenarios();
    assert.equal(fingerprint(first), fingerprint(second));
    const firstCases = flattened(first);
    const secondCases = flattened(second);
    for (let index = 0; index < firstCases.length; index++) {
        assert.notEqual(firstCases[index], secondCases[index]);
        assert.notEqual(firstCases[index]!.preparation, secondCases[index]!.preparation);
        assert.notEqual(firstCases[index]!.reference, secondCases[index]!.reference);
        assert.equal(fingerprint(firstCases[index]!.reference), fingerprint(referenceInputs(firstCases[index]!.preparation)));
    }
});
