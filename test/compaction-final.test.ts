import assert from "node:assert/strict";
import test from "node:test";
import {normalizeContext} from "@earendil-works/pi-ai";
import {archivalAccounting, finalConditions, finalGroups, finalMatrix, finalStrategies, freshFinalStream, parseFinalArguments} from "../scripts/final-compaction.js";
import {regressionScenarios} from "../experiments/compaction/CondenserRegressionScenarios.js";
import {smokeModel, smokeStream} from "../scripts/evaluate-compaction.js";
import type {CompactionStream} from "../experiments/compaction/CompactionEvaluation.js";

test("final study is separately metered, explicitly bounded and has no tunable model/candidate/scenario flags", () => {
    const options = parseFinalArguments(["--output", "/tmp/final-private.json"]);
    assert.equal(options.live, false);
    assert.equal(options.maxCalls, 192);
    assert.equal(parseFinalArguments(["--output", "/tmp/amended.json", "--amend-from", "/tmp/stopped.json"]).amendFrom, "/tmp/stopped.json");
    assert.deepEqual(finalStrategies(true).map(({id}) => id), ["stock", "parallel-split", "semantic-unified-v6"]);
    assert.equal(finalMatrix.plannedNewCalls, 2 * Object.values(finalMatrix.perCondition).reduce((sum, value) => sum + value, 0));
    assert.equal(finalMatrix.plannedNewCalls, 114);
    assert.equal(archivalAccounting.reportedCalls, 275);
    assert.match(archivalAccounting.status, /UNVERIFIED/);
    assert.deepEqual(finalConditions.map(({thinking}) => thinking), ["low", "high"]);
    for (const flags of [["--max-calls", "193"], ["--max-calls", "113"], ["--max-calls", "NaN"],
        ["--max-cost-usd", "10.01"], ["--max-cost-usd", "0"], ["--model", "other"], ["--version", "7"]]) {
        assert.throws(() => parseFinalArguments(["--output", "/tmp/final.json", ...flags]));
    }
});

test("final classes measure parallel only on split; original heldout cases stay immutable", async () => {
    const heldout = (await regressionScenarios()).holdout;
    const before = structuredClone(heldout);
    const split = heldout.find((item) => item.preparation.isSplitTurn)!;
    const historical = [structuredClone(split), structuredClone(split)];
    const groups = finalGroups(heldout, historical);
    assert.deepEqual(groups.map(({cases, parallel, graded}) => [cases.length, parallel, graded]),
        [[3, false, true], [1, true, true], [2, true, false], [1, true, false]]);
    assert.deepEqual(heldout, before);
    assert.throws(() => finalGroups(heldout.slice(1), historical));
    assert.throws(() => finalGroups(heldout, [heldout[0]!, split]));
});

test("common final provider boundary disables cache and supplies fresh routing without altering caller model/thinking", async () => {
    const captured: Parameters<CompactionStream>[] = [];
    const stream = freshFinalStream((...args) => { captured.push(args); return smokeStream(args[0]); });
    const model = smokeModel();
    const context = normalizeContext({messages: []});
    for (let index = 0; index < 2; index++) await stream(model, context, {reasoning: "high", cacheRetention: "long", sessionId: "old-route"});
    assert.equal(captured[0]![0], model);
    assert.equal(captured[0]![1], context);
    assert.equal(captured[0]![2]!.reasoning, "high");
    assert.equal(captured[0]![2]!.cacheRetention, "none");
    assert.notEqual(captured[0]![2]!.sessionId, "old-route");
    assert.notEqual(captured[0]![2]!.sessionId, captured[1]![2]!.sessionId);
});
