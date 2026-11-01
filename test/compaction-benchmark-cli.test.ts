import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {parseBenchmarkArguments, validatePrivateOutput} from "../scripts/benchmark-compaction.js";
import {BenchmarkArtifacts} from "../experiments/compaction/BenchmarkArtifacts.js";
import {boundedOperation} from "../experiments/compaction/BenchmarkDeadline.js";
import {calibrationPassed, calibrationReference, calibrationRubric} from "../experiments/compaction/BenchmarkCalibration.js";
import {scoreValue, validateRubric} from "../experiments/compaction/ValueRetention.js";
import type {ValueGrade} from "../experiments/compaction/BenchmarkTypes.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("CLI defaults to no provider calls and live commands require both explicit budget caps", () => {
    assert.equal(parseBenchmarkArguments(["--help"]).help, true);
    const options = parseBenchmarkArguments(["run", "--corpus", "/tmp/corpus.json", "--output", "/tmp/report.json"]);
    assert.equal(options.live, false);
    assert.equal(options.model, "openai/gpt-6-luna");
    assert.throws(() => parseBenchmarkArguments(["run", "--corpus", "/tmp/corpus.json", "--output", "/tmp/report.json", "--live"]), /explicit/);
    assert.throws(() => parseBenchmarkArguments(["run", "--corpus", "/tmp/corpus.json", "--output", "/tmp/report.json", "--live", "--max-cost-usd", "0.05"]), /explicit/);
    assert.throws(() => parseBenchmarkArguments(["run", "--corpus", "/tmp/corpus.json", "--output", path.join(root, "private-report.json")]), /outside/);
    for (const value of ["NaN", "Infinity", "0", "-1"]) {
        assert.throws(() => parseBenchmarkArguments(["calibrate", "--output", "/tmp/report.json", "--max-cost-usd", value]));
    }
    assert.throws(() => parseBenchmarkArguments(["run", "--corpus", "/tmp/corpus.json", "--output", "/tmp/report.json", "--seed", "4294967296"]));
    assert.throws(() => parseBenchmarkArguments(["calibrate", "--output", "/tmp/report.json", "--speed-only"]), /not valid/);
});

test("private atomic artifacts cannot overwrite an existing session/report and retain private atomic replacements", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-benchmark-artifacts-"));
    try {
        const original = path.join(directory, "original.jsonl");
        await writeFile(original, "ORIGINAL_SESSION\n");
        await assert.rejects(BenchmarkArtifacts.create(original, {overwrite: true}), /EEXIST/);
        assert.equal(await readFile(original, "utf8"), "ORIGINAL_SESSION\n");
        assert.equal(await validatePrivateOutput(path.join(directory, "nested", "new.json")), path.join(directory, "nested", "new.json"));
        await assert.rejects(validatePrivateOutput(path.join(root, "private-report.json")), /outside/);
        const output = path.join(directory, "new.json");
        const owner = await BenchmarkArtifacts.create(output, {status: "starting"});
        await owner.save({status: "complete", private: "summary"});
        assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {status: "complete", private: "summary"});
        assert.equal((await stat(output)).mode & 0o777, 0o600);
        assert.ok(!(await readdir(directory)).some((file) => file.endsWith(".tmp")));
    } finally { await rm(directory, {recursive: true, force: true}); }
});

test("artifact creation never follows an existing target symlink", async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-benchmark-symlink-"));
    try {
        const original = path.join(directory, "original.jsonl");
        const link = path.join(directory, "link.json");
        await writeFile(original, "ORIGINAL_SESSION\n");
        try { await symlink(original, link); }
        catch (error) {
            if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(String(error.code))) {
                t.skip("This environment cannot create a symlink fixture; no host/native integration attempted");
                return;
            }
            throw error;
        }
        await assert.rejects(BenchmarkArtifacts.create(link, {overwrite: true}), /EEXIST/);
        assert.equal(await readFile(original, "utf8"), "ORIGINAL_SESSION\n");
        const directoryLink = path.join(directory, "repository-alias");
        await symlink(root, directoryLink);
        await assert.rejects(validatePrivateOutput(path.join(directoryLink, "nested", "private-report.json")), /outside.*resolved/);
    } finally { await rm(directory, {recursive: true, force: true}); }
});

test("bounded operations observe synchronous throws, pre-abort and asynchronous cancellation cleanup", async () => {
    const active = new AbortController();
    const sync = await boundedOperation(() => { throw new Error("Synchronous failure"); }, active.signal, 100);
    assert.deepEqual(sync, {status: "error", error: "Synchronous failure", cleanupComplete: true});
    const cancelled = await boundedOperation(async () => { throw new Error("Must not start"); }, AbortSignal.abort(new Error("Already cancelled")), 100);
    assert.deepEqual(cancelled, {status: "error", error: "Already cancelled", cleanupComplete: true});
    let cleaned = false;
    const start = performance.now();
    const timeout = await boundedOperation(async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve(); }, 20), {once: true}));
        throw new Error("Cleaned");
    }, active.signal, 5);
    assert.equal(timeout.status, "error");
    assert.equal(timeout.cleanupComplete, true);
    assert.equal(cleaned, true);
    assert.ok(performance.now() - start >= 20);
});

test("synthetic judge controls are source-validated and require omission/contradiction/chronology discrimination", () => {
    assert.deepEqual(validateRubric(calibrationRubric, calibrationReference), calibrationRubric);
    const grade = (change?: {id: string; status: "missing" | "contradicted"}): ValueGrade => {
        const judgments = calibrationRubric.facts.map((fact) => ({factId: fact.id,
            status: change?.id === fact.id ? change.status : "retained" as const, evidence: "", reason: "Synthetic unit control"}));
        const value = scoreValue(calibrationRubric, judgments);
        return {status: "graded", judgments, value, unsupportedClaims: [], gate: change ? "fail" : "pass"};
    };
    const controls = {faithful: grade(), "critical-omission": grade({id: "production", status: "missing"}),
        "negation-reversal": grade({id: "production", status: "contradicted"}), "superseded-state": grade({id: "validation-state", status: "contradicted"})};
    assert.equal(calibrationPassed(controls), true);
    assert.equal(calibrationPassed({...controls, "negation-reversal": grade()}), false);
    assert.equal(calibrationPassed({...controls, faithful: {status: "unscored", error: "Judge failed"}}), false);
});

test("offline calibration CLI writes only a plan, without credentials/provider access or fabricated scores", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-benchmark-cli-"));
    try {
        const output = path.join(directory, "calibration.json");
        execFileSync(process.execPath, ["--import", "jiti/register", "scripts/benchmark-compaction.ts", "calibrate", "--output", output],
            {cwd: root, env: {...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory}, timeout: 20000, stdio: "pipe"});
        const plan = JSON.parse(await readFile(output, "utf8"));
        assert.equal(plan.mode, "calibration-plan");
        assert.equal(plan.controls.length, 4);
        assert.equal(plan.grades, undefined);
        assert.equal((await stat(output)).mode & 0o777, 0o600);
    } finally { await rm(directory, {recursive: true, force: true}); }
});
