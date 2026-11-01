import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {summarizeFinalCondition, type FinalReportBlock} from "../experiments/compaction/FinalBenchmarkReporting.js";
import type {BudgetSnapshot} from "../experiments/compaction/BudgetedModel.js";

type Receipt = {
    status: string; sources: Record<string, string>; hashes: Record<string, string>;
    options: {maxCalls: number; maxCostUsd: number}; finalMatrix: {plannedNewCalls: number};
    results: Array<{id: string; model: string; thinking: string; status: string; cleanupComplete: boolean;
        reports: FinalReportBlock[]; continuations: unknown[]; budget: BudgetSnapshot}>;
    newStudyTotals: {calls: number; catalogueUsd: number; reservedUnknownUsd: number; unknownCalls: number};
    amendment: {source: string; sha256: string; retainedAccounting: Receipt["newStudyTotals"]; declaration: string};
    archivalAccounting: unknown; providerControls: unknown;
};
type PreservationManifest = {originalReceiptRawBytesSha256: string;
    files: Record<string, {original: string; rawBytesSha256: string; receiptJsonStringFingerprint: string}>};

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Offline only: reads persisted receipts, never imports a model runtime or invokes a provider. */
export async function reportFinalCompaction(directory: string): Promise<void> {
    directory = path.resolve(directory);
    const protectedNames = ["report.json", "plan.json", "frozen-receipt.json", "luna-low.json", "sol-high.json", "parent-audit-verdict.json"];
    const originals = await Promise.all(protectedNames.map(async (name) => ({name, raw: await readFile(path.join(directory, name), "utf8")})));
    const raw = originals.find((item) => item.name === "report.json")!.raw;
    const receipt = JSON.parse(raw) as Receipt;
    const frozen = JSON.parse(originals.find((item) => item.name === "frozen-receipt.json")!.raw) as Receipt;
    const verdict = JSON.parse(originals.find((item) => item.name === "parent-audit-verdict.json")!.raw) as unknown;
    const manifestPath = "experiments/compaction/frozen-final-20261101/manifest.json";
    const manifestRaw = await readFile(path.join(root, manifestPath), "utf8");
    const manifest = JSON.parse(manifestRaw) as PreservationManifest;
    assert.equal(sha256(raw), manifest.originalReceiptRawBytesSha256);
    const preservation = await Promise.all(Object.entries(manifest.files).map(async ([file, entry]) => {
        const source = await readFile(path.join(root, file), "utf8");
        const fingerprint = sha256(JSON.stringify(source));
        assert.equal(sha256(source), entry.rawBytesSha256);
        assert.equal(fingerprint, entry.receiptJsonStringFingerprint);
        for (const original of [receipt, frozen]) {
            assert.equal(original.sources[entry.original], source);
            assert.equal(original.hashes[entry.original], fingerprint);
        }
        return {file, original: entry.original, rawBytesSha256: sha256(source), receiptJsonStringFingerprint: fingerprint, verified: true};
    }));
    const exploratoryRaw = await readFile(receipt.amendment.source, "utf8");
    assert.equal(sha256(JSON.stringify(exploratoryRaw)), receipt.amendment.sha256);
    const exploratory = JSON.parse(exploratoryRaw) as Receipt;
    const settled = receipt.results.flatMap((condition) => condition.budget.calls);
    const exploratoryCalls = exploratory.results.flatMap((condition) => condition.budget.calls);
    assert.ok([...settled, ...exploratoryCalls].every((call) => call.status === "settled"));
    const catalogue = (calls: BudgetSnapshot["calls"]) => calls.reduce((sum, call) => sum + call.costUsd!, 0);
    assert.equal(settled.length, 113);
    assert.equal(exploratoryCalls.length, 28);
    assert.equal(settled.length + exploratoryCalls.length, receipt.newStudyTotals.calls);
    assert.ok(Math.abs(catalogue(settled) + catalogue(exploratoryCalls) - receipt.newStudyTotals.catalogueUsd) < 1e-10);
    const missing = receipt.results.flatMap((condition) => condition.reports.flatMap((block) => block.report.caseIds.flatMap((caseId) =>
        block.report.strategyIds.filter((strategy) => !block.report.trials.some((trial) =>
            trial.result.fixture === caseId && trial.result.experiment === strategy)).map((strategy) => ({condition: condition.id, group: block.group, caseId, strategy})))));
    assert.deepEqual(missing, [{condition: "sol-high", group: "heldout-split-repeat", caseId: "regression-held-02", strategy: "semantic-unified-v6"}]);
    const unresolved = {
        status: "potentially-started-unresolved-not-settled", potentiallyStartedCalls: 1,
        persistedProviderReceipt: false, persistedPerCallReservation: null, catalogueCostUsd: null, actualBilledCostUsd: null,
        persistedLedgerReservedUsd: receipt.newStudyTotals.reservedUnknownUsd,
        location: missing[0],
        evidence: "Parent/owner handoff reports timeout after 113 amended settled calls and 35 checkpoints. Last persisted receipt has 56 Sol settled calls; the remaining scheduled Sol timing-only v6 call may have started. No later provider receipt or per-call reservation was found in the private cache.",
        handling: "Retain one possibly started call outside the 141 settled total. Missing receipt is not evidence of no dispatch, zero cost, completed cleanup, or provider cancellation. No rerun or live reconciliation authorized.",
        reservationQualification: "The last persisted ledger's reservedUsd=0 describes that saved checkpoint only. It does not settle or price the potentially subsequent call. Do not invent a reservation amount or actual charge.",
    };
    const summaries = receipt.results.map(summarizeFinalCondition);
    const primary = receipt.results.flatMap((condition) => condition.reports.filter((block) => block.group !== "heldout-split-repeat").flatMap((block) => block.report.trials));
    const timing = receipt.results.flatMap((condition) => condition.reports.filter((block) => block.group === "heldout-split-repeat").flatMap((block) => block.report.trials));
    assert.equal(primary.length, 30);
    assert.equal(timing.length, 5);
    assert.ok([...primary, ...timing].every((trial) => trial.result.cleanupComplete && trial.result.metadataPassed && !trial.result.error));
    const derived = {
        status: "offline-derived-primary-complete-timing-repeat-partial-no-further-live-calls",
        productionSelection: "parallel-native", semanticV6Disposition: "disqualified-source-verified-expanded-prerequisite-no-v7",
        provenance: {inputs: originals.map(({name, raw: text}) => ({file: name, rawBytesSha256: sha256(text)})),
            manifest: {file: manifestPath, rawBytesSha256: sha256(manifestRaw)}, preservation,
            exploratoryReceipt: {file: receipt.amendment.source, receiptJsonStringFingerprint: receipt.amendment.sha256}},
        completion: {primaryCheckpoints: {persisted: 30, planned: 30}, timingOnlyCheckpoints: {persisted: 5, planned: 6},
            totalCheckpoints: {persisted: 35, planned: 36}, missing,
            caution: "Raw report remains status=running after owner timeout. Persisted trial cleanup flags cover only those trials, not the potentially started final call."},
        accounting: {
            amended: {settledCalls: settled.length, catalogueUsd: catalogue(settled)},
            outputCapExploratory: {settledCalls: exploratoryCalls.length, catalogueUsd: catalogue(exploratoryCalls), outputCap: 4096},
            cumulative: {settledCalls: settled.length + exploratoryCalls.length, catalogueUsd: catalogue(settled) + catalogue(exploratoryCalls),
                additionalPotentiallyStartedUnresolvedCalls: 1, conservativeCallCountIncludingPotential: 142},
            unresolvedRecord: "unresolved-call.json", actualBilledCostUsd: null,
            authorizedGuard: receipt.options,
            note: "Catalogue-rate SDK estimates, not subscription invoices or actual charges. Agent/reviewer activity is outside this ledger. The 275-call archival account is unverified and is not added to the settled totals here.",
            archival: receipt.archivalAccounting,
        },
        timingScope: "Summary strategy including worker cleanup, not full compaction lifecycle. Conditions and strategy executions are serially scheduled; internal split summary calls overlap only for parallel-split.",
        providerControls: receipt.providerControls,
        repeatNormalization: {policy: "Clone only; timing-only group report.repetitions=1 requires index 0. Three persisted Luna indices 2 are normalized to 0 in the derived copy; raw reports/plan/frozen receipt are immutable.",
            correctedTrials: summaries.flatMap((condition) => condition.groups.flatMap((group) => group.corrections.map((correction) => ({condition: condition.condition, group: group.group, ...correction}))))},
        conditions: summaries,
        fidelityAudit: verdict,
        validation: {
            offlineBenchmark: {passed: 192, failed: 0, skipped: 1, skipReason: "Environment cannot create the symlink fixture", typecheck: "passed"},
            parentMainRegression: {passed: 188, failed: 0, skipped: 0, typecheck: "passed", diffCheck: "passed", earlier69Tests: "subset-not-additional"},
            nativeHostSuite: "Not run inside pi.lot", additionalIndexRegression: "Pending scoped tool authorization; not claimed added or passed",
        },
        postBenchmarkSelectedParallelDelta: {
            measuredSha256: "8219e4f4ce675d14d24f0061eb79b1ad37440277cb0263560df61b5df865e47c",
            selectedSha256: "1b0a17f8b050da2cc5e723a306c344a2550bae878cbc574e7b72584974d0197f",
            change: "Removed only signal.throwIfAborted() inside produce before invoking the stream, restoring native retry callback completion when onRetryAttemptStart cancels and the stream returns an aborted completion.",
            verification: "Read-only comparison confirmed this exact one-line removal reproduces the selected hash; restoring it reproduces the measured frozen hash. Parent reports old regression fails/new passes, 188 main regression tests passed with zero failures/skips, plus typecheck and diff check. The earlier 69-test subset is not additional coverage.",
            happyPath: "No successful prompt/options/routing/usage/assembly changes; no further semantic benchmark or provider calls performed. Measured timings belong to the frozen measured hash, not a live rerun of the error-path-fixed source.",
        },
    };
    for (const original of originals) assert.equal(await readFile(path.join(directory, original.name), "utf8"), original.raw);
    await writeFile(path.join(directory, "unresolved-call.json"), JSON.stringify(unresolved, null, 2) + "\n", {flag: "wx", mode: 0o600});
    await writeFile(path.join(directory, "derived-summary.json"), JSON.stringify(derived, null, 2) + "\n", {flag: "wx", mode: 0o600});
    console.log(JSON.stringify({summary: path.join(directory, "derived-summary.json"), preservationVerified: preservation.length,
        primary: primary.length, timingOnly: timing.length, settled: settled.length + exploratoryCalls.length, potentiallyStartedUnresolved: 1}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.length !== 3) throw new Error("Usage: report-final-compaction.ts PRIVATE_RECEIPT_DIRECTORY (offline only)");
    await reportFinalCompaction(process.argv[2]!);
}
