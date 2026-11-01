import assert from "node:assert/strict";
import {test} from "node:test";
import {convertToLlm, serializeConversation} from "@earendil-works/pi-coding-agent";
import {fingerprint} from "../experiments/compaction/CompactionEvaluation.js";
import type {PreparedBenchmarkCase, ReferenceInput} from "../experiments/compaction/BenchmarkTypes.js";
import {regressionContinuationQuestions, regressionScenarios} from "../experiments/compaction/CondenserRegressionScenarios.js";
import {validationContinuationQuestions, validationScenarios} from "../experiments/compaction/CondenserValidationScenarios.js";
import {validateRubric} from "../experiments/compaction/ValueRetention.js";

// Pin neutral integrity metadata, not heldout answers or conversation excerpts.
const pins: Record<string, {source: string; definition: string}> = {
    "validation-dev-01": {
        source: "3ba0d5af02c40deaa0f2c75fd198f4b92928457f398b1f5900d9d58ab07c0745",
        definition: "5b4b2f0b1aae32395e8b212bf1867d4736a2f8216860238c68cc406ba40142b3"
    },
    "validation-dev-02": {
        source: "1dd0545f93504d040541871201ecd8f8bef05122fc20fe9d37f0113f1dd21b9f",
        definition: "383498a6f6afc714cc04abcbca7e4201490ace066b8f19f7057f86f905fecc30"
    },
    "validation-dev-03": {
        source: "915ceb77af30ccbe648a42497b2c93a18400d2c01972253980f63ce7c2915ac9",
        definition: "61092020b237a78c2917b276000f62ea1f74a3bc1d5d2000d9a340cff558eb0f"
    },
    "validation-dev-04": {
        source: "38816207eb63dc5abb827ee0b16d66778aa6b40ca42c2e1b22a6fc10424b5a62",
        definition: "7b1dc286f0a6d7e002019f1e6574ba251f50e75e4b481d4bbab16b476affc09e"
    },
    "validation-held-01": {
        source: "4bc0336d492538124ea277235d3e7fb748daa31ee9c91f620bdc3d38b6aff084",
        definition: "49397bd4f3b1ad8372f6c29cf8a13b2bfda4077e2a0ff8d7ddfa86d9208ed72f"
    },
    "validation-held-02": {
        source: "d8bd8ce3be59b0775f25060ebf2c3428f38903fc9ed58e9e530beadab39dc95b",
        definition: "acc0d3e6dec98f81488f1e77cd66ffeaf19657496ae258c34c283f769493e87d"
    },
    "validation-held-03": {
        source: "40027f81707028db34aabbf6fe260919359d2ba75386e0479375c24440031da6",
        definition: "3d55fedf96a50d50d115f2dd39d6aa29f20d0a267eb54d39415150018e0dc9a6"
    },
    "validation-held-04": {
        source: "f0093209b9cffeb0ce6a4191954e4665df9d834c7255476a03397befd0418401",
        definition: "46cb1ee5b6653f11d77292dd105ff0bc0b1f8567a5ff682b7bccc3e80b0358c9"
    },
    "regression-held-01": {
        source: "4b7fd41942cd77d9f69c2a7d94dd4fde724852084e3662f08c82ab93d059afc6",
        definition: "7cbe6776a3ee794cde3835ca49d5f88cbae4eae023555c002d1af63a9ac78918"
    },
    "regression-held-02": {
        source: "c87b61dd65921cc2527b5b2fe7da8ecb39dfe31e59cab7b2404593a7ab15b468",
        definition: "1827acf040e416064b18cb6892e5c00ca97b9809ad8568a0dad63276b04802cf"
    },
    "regression-held-03": {
        source: "6b0212da7155c4ba4618008bf643bd7fc645be6335563edb21ac9a01d7654370",
        definition: "3f7d608a289f49a9bf22e53419e6fae67e7673adb573d682acec7efef1cf69cc"
    },
    "regression-held-04": {
        source: "dcebd92cf90afd2b62ea1d13f4f4b0c6a2c081bda07749feea46ba0d224b9a81",
        definition: "ec185909fab2124354aa54072ee03bcfac8e4087edd19b0588e818b7b5d81ff0"
    }
};

function cases(suite: Awaited<ReturnType<typeof regressionScenarios>>): PreparedBenchmarkCase[] {
    return [...suite.development, ...suite.holdout];
}

function nativeReference({preparation}: PreparedBenchmarkCase): ReferenceInput[] {
    const inputs: ReferenceInput[] = [];
    if (preparation.previousSummary) inputs.push({id: "previous-summary", text: preparation.previousSummary});
    if (preparation.messagesToSummarize.length) {
        inputs.push({id: "history", text: serializeConversation(convertToLlm(preparation.messagesToSummarize))});
    }
    if (preparation.turnPrefixMessages.length) {
        inputs.push({id: "turn-prefix", text: serializeConversation(convertToLlm(preparation.turnPrefixMessages))});
    }
    return inputs;
}

test("regression partitions contain all eight seen cases and four disjoint new clusters", async () => {
    const suite = await regressionScenarios();
    const prior = await validationScenarios();
    assert.equal(suite.development.length, 8);
    assert.equal(suite.holdout.length, 4);
    assert.deepEqual(suite.development.map(({definition}) => definition.id), cases(prior).map(({definition}) => definition.id));
    const all = cases(suite);
    assert.deepEqual(all.map(({definition}) => definition.id).sort(), Object.keys(pins).sort());
    assert.equal(new Set(all.map(({definition}) => definition.id)).size, 12);
    assert.equal(new Set(all.map(({definition}) => definition.cluster)).size, 12);
    const oldSources = new Set(cases(prior).map(({definition}) => definition.source.sha256));
    for (const item of suite.holdout) {
        assert.ok(item.definition.id.startsWith("regression-held-"));
        assert.ok(!oldSources.has(item.definition.source.sha256));
        const messages = [...item.preparation.messagesToSummarize, ...item.preparation.turnPrefixMessages];
        assert.equal(messages.length, 20, "ten natural user/assistant pairs per new case");
        let chars = 0;
        for (const [index, message] of messages.entries()) {
            assert.equal(message.role, index % 2 ? "assistant" : "user");
            assert.ok(Array.isArray(message.content));
            if (!Array.isArray(message.content)) throw new Error("Expected native content blocks");
            for (const part of message.content) {
                assert.equal(part.type, "text");
                if (part.type === "text") chars += part.text.length;
            }
        }
        assert.ok(chars >= 4_000 && chars <= 12_000, "visible text excluding previous summary");
        assert.ok(item.definition.rubric!.facts.length >= 12 && item.definition.rubric!.facts.length <= 16);
    }
    const modes = suite.holdout.map(({preparation}) => preparation.isSplitTurn ? "split" : preparation.previousSummary ? "iterative" : "whole");
    assert.deepEqual([...new Set(modes)].sort(), ["iterative", "split", "whole"]);
});

test("regression native references, source hashes, definitions and metadata are pinned", async () => {
    const suite = await regressionScenarios();
    assert.deepEqual(suite, await regressionScenarios());
    for (const item of cases(suite)) {
        const {preparation, definition, reference} = item;
        assert.deepEqual(reference, nativeReference(item));
        const source = fingerprint({
            previousSummary: preparation.previousSummary,
            history: reference.find(({id}) => id === "history")?.text,
            turnPrefix: reference.find(({id}) => id === "turn-prefix")?.text
        });
        assert.equal(source, definition.source.sha256);
        assert.equal(source, pins[definition.id]!.source);
        assert.equal(fingerprint(definition), pins[definition.id]!.definition);
        assert.equal(fingerprint(preparation), definition.preparationHash);
        assert.equal(fingerprint(reference), definition.referenceHash);
        assert.equal(definition.historyMessages, preparation.messagesToSummarize.length);
        assert.equal(definition.prefixMessages, preparation.turnPrefixMessages.length);
        assert.equal(definition.prefixMessages, preparation.isSplitTurn ? 2 : 0);
        assert.equal(definition.source.checkpoint, definition.historyMessages + definition.prefixMessages);
        assert.equal(definition.tokensBefore, preparation.tokensBefore);
        assert.equal(preparation.tokensBefore, 20_000 + Math.ceil(reference.reduce((n, input) => n + input.text.length, 0) / 3.5));
        assert.equal(preparation.firstKeptEntryId, `${definition.id}:boundary:0001`);
        assert.deepEqual(preparation.settings, {enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_000});
        if (preparation.isSplitTurn) assert.ok(definition.rubric!.facts.some((fact) => fact.evidence.some(({inputId}) => inputId === "turn-prefix")));
        for (const paths of Object.values(preparation.fileOps)) {
            assert.ok(paths instanceof Set);
            for (const file of paths) assert.ok(file.startsWith("/"));
        }
    }
});

test("seen regression augmentation never changes native inputs or historical rubric objects", async () => {
    const before = await validationScenarios();
    const oldQuestions = structuredClone(validationContinuationQuestions);
    const old = new Map(cases(before).map((item) => [item.definition.id, item]));
    const suite = await regressionScenarios();
    for (const item of suite.development) {
        const historical = old.get(item.definition.id)!;
        assert.deepEqual(item.preparation, historical.preparation);
        assert.deepEqual(item.reference, historical.reference);
        assert.deepEqual(item.definition.source, historical.definition.source);
        assert.equal(item.definition.referenceHash, historical.definition.referenceHash);
        assert.equal(item.definition.preparationHash, historical.definition.preparationHash);
        const oldFacts = historical.definition.rubric!.facts;
        const currentFacts = item.definition.rubric!.facts;
        for (const oldFact of oldFacts) {
            const current = currentFacts.find(({id}) => id === oldFact.id);
            assert.ok(current);
            if (item.definition.id === "validation-held-02" && oldFact.id === "h4") {
                assert.deepEqual({...current, statement: oldFact.statement}, oldFact, "only statement atomicity changes on this historical fact");
            } else {
                assert.deepEqual(current, oldFact, "every other old fact remains unchanged");
            }
        }
        const augmented = item.definition.id === "validation-held-02" || item.definition.id === "validation-held-03";
        assert.equal(currentFacts.length, oldFacts.length + (augmented ? 1 : 0));
        assert.notEqual(item.definition.rubric, historical.definition.rubric);
    }
    assert.deepEqual(await validationScenarios(), before);
    assert.deepEqual(validationContinuationQuestions, oldQuestions);
});

test("seen regression preservation and split transcript service retain critical native anchors", async () => {
    const suite = await regressionScenarios();
    const preservation = suite.development.find(({definition}) => definition.id === "validation-held-03")!;
    const fact = preservation.definition.rubric!.facts.find(({id}) => id === "h15")!;
    const quote = "The data steward asked us to preserve the original download rather than replace it with a corrected spreadsheet.";
    assert.equal(fact.statement, quote);
    assert.equal(fact.category, "constraint");
    assert.equal(fact.critical, true);
    assert.equal(fact.weight, 5);
    assert.ok(fact.evidence.some((citation) => citation.quote === quote && citation.inputId !== "previous-summary"));
    assert.ok(regressionContinuationQuestions[preservation.definition.id]!.find(({id}) => id === "data")!.factIds.includes("h15"));
    const transcript = suite.development.find(({definition}) => definition.id === "validation-held-02")!;
    const core = transcript.definition.rubric!.facts.find(({id}) => id === "h4")!;
    const service = transcript.definition.rubric!.facts.find(({id}) => id === "h14")!;
    assert.equal(core.statement, "A printed transcript is supplementary and must not replace live captions.");
    assert.equal(service.statement, "A printed transcript is available on request.");
    assert.equal(core.critical, true);
    assert.equal(service.critical, true);
    assert.equal(service.weight, 5);
    assert.deepEqual(service.evidence, core.evidence);
    assert.ok(regressionContinuationQuestions[transcript.definition.id]!.find(({id}) => id === "venue")!.factIds.includes("h14"));
});

test("regression draft facts remain grounded and all critical cores have bounded continuations", async () => {
    const suite = await regressionScenarios();
    assert.deepEqual(Object.keys(regressionContinuationQuestions).sort(), cases(suite).map(({definition}) => definition.id).sort());
    for (const {definition, reference} of cases(suite)) {
        const rubric = definition.rubric!;
        assert.equal(rubric.status, "draft");
        assert.deepEqual(validateRubric(rubric, reference), rubric);
        assert.equal(new Set(rubric.facts.map(({statement}) => statement)).size, rubric.facts.length);
        for (const fact of rubric.facts) {
            assert.ok(fact.statement.trim());
            assert.ok(fact.evidence.length > 0);
            for (const citation of fact.evidence) {
                assert.ok(citation.inputId === "history" || citation.inputId === "turn-prefix");
                assert.ok(reference.find(({id}) => id === citation.inputId)?.text.includes(citation.quote));
            }
            assert.equal(fact.weight, fact.critical ? 5 : 2);
        }
        // Literal anchors and pinned core statements are not a substitute for independent semantic audit.
        const questions = regressionContinuationQuestions[definition.id]!;
        assert.equal(questions.length, 3);
        assert.equal(new Set(questions.map(({id}) => id)).size, 3);
        const covered = new Set<string>();
        for (const question of questions) {
            assert.ok(question.question.length > 40 && question.question.length < 250);
            assert.ok(question.factIds.length >= 2 && question.factIds.length <= 5);
            assert.equal(new Set(question.factIds).size, question.factIds.length);
            assert.ok(question.factIds.some((id) => rubric.facts.find((fact) => fact.id === id)?.critical));
            for (const id of question.factIds) {
                assert.ok(rubric.facts.some((fact) => fact.id === id));
                covered.add(id);
            }
            assert.ok(!rubric.facts.some(({statement}) => question.question.includes(statement)));
            assert.ok(!/[\w.-]+@[\w.-]+|\/(?:repos|transport|loans|commissions)\//.test(question.question));
        }
        assert.ok(rubric.facts.filter(({critical}) => critical).every(({id}) => covered.has(id)));
        assert.ok(rubric.facts.every(({id}) => covered.has(id)));
    }
});

test("focused source audit mappings keep independent workstreams and gates in their relevant followups", async () => {
    const expected: Record<string, Record<string, string[]>> = {
        "regression-held-01": {
            repair: ["h1", "h2", "h3", "h4", "h13"],
            evidence: ["h5", "h6", "h7", "h8", "h14"],
            records: ["h9", "h10", "h11", "h12", "h15"]
        },
        "regression-held-02": {
            release: ["h1", "h2", "h3", "h4", "h13"],
            verification: ["h5", "h6", "h7", "h8", "h14"],
            workstreams: ["h9", "h10", "h11", "h12", "h15"]
        },
        "regression-held-03": {
            service: ["h1", "h2", "h3", "h4", "h13"],
            checks: ["h5", "h6", "h7", "h8"],
            office: ["h9", "h10", "h11", "h12", "h14"]
        },
        "regression-held-04": {
            movement: ["h1", "h2", "h3", "h4", "h15"],
            condition: ["h5", "h6", "h7", "h8", "h13"],
            coordination: ["h9", "h10", "h11", "h12", "h14"]
        }
    };
    for (const [caseId, mappings] of Object.entries(expected)) {
        assert.deepEqual(Object.fromEntries(regressionContinuationQuestions[caseId]!.map(({id, factIds}) => [id, factIds])), mappings);
    }
    const suite = await regressionScenarios();
    const first = suite.holdout.find(({definition}) => definition.id === "regression-held-01")!;
    const newConstraint = first.definition.rubric!.facts.find(({id}) => id === "h15")!;
    assert.equal(newConstraint.critical, true);
    assert.equal(newConstraint.category, "constraint");
    const second = suite.holdout.find(({definition}) => definition.id === "regression-held-02")!;
    const notes = second.definition.rubric!.facts.find(({id}) => id === "h15")!;
    assert.equal(notes.critical, false);
    assert.equal(notes.category, "identifier");
    assert.equal(notes.weight, 2);
    assert.equal(second.definition.rubric!.facts.find(({id}) => id === "h14")!.category, "constraint");
});

test("regression factory preparations and augmented rubrics are isolated across callers", async () => {
    const baseline = await regressionScenarios();
    const mutable = await regressionScenarios();
    const original = await validationScenarios();
    for (const [index, item] of cases(mutable).entries()) {
        const other = cases(baseline)[index]!;
        assert.notEqual(item.preparation, other.preparation);
        assert.notEqual(item.preparation.messagesToSummarize, other.preparation.messagesToSummarize);
        assert.notEqual(item.reference, other.reference);
        assert.notEqual(item.definition.rubric, other.definition.rubric);
        item.preparation.fileOps.read.add("/test-only/caller-mutation");
        item.definition.rubric!.facts[0]!.statement = "test-only caller mutation";
        item.reference[0]!.text = "test-only caller mutation";
    }
    assert.deepEqual(await regressionScenarios(), baseline);
    assert.deepEqual(await validationScenarios(), original);
});
