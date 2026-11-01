import {readFile, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {BudgetedModel} from "../experiments/compaction/BudgetedModel.js";
import {BenchmarkArtifacts} from "../experiments/compaction/BenchmarkArtifacts.js";
import {CompactionCorpus} from "../experiments/compaction/BenchmarkCorpus.js";
import {CompactionBenchmark} from "../experiments/compaction/CompactionBenchmark.js";
import {calibrationPassed, calibrationReference, calibrationRubric, calibrationSummaries} from "../experiments/compaction/BenchmarkCalibration.js";
import {boundedOperation} from "../experiments/compaction/BenchmarkDeadline.js";
import {summarizeBenchmark} from "../experiments/compaction/BenchmarkStatistics.js";
import {ValueRetention} from "../experiments/compaction/ValueRetention.js";
import {createChunkedCompaction} from "../experiments/compaction/ChunkedCompaction.js";
import {fingerprint, stockCompaction, type CompactionExperiment, type CompactionThinkingLevel} from "../experiments/compaction/CompactionEvaluation.js";
import identity from "../experiments/compaction/IdentityControl.js";
import parallelSplit from "../experiments/compaction/ParallelSplit.js";
import type {ValueGrade} from "../experiments/compaction/BenchmarkTypes.js";
import {smokeModel, smokeStream} from "./evaluate-compaction.js";

const help = `Usage: node --import jiti/register scripts/benchmark-compaction.ts COMMAND [options]

Commands:
  discover   Build a pinned private manifest from root-session historical checkpoints (always local).
  draft      Draft source-quoted value rubrics. Without --live, write a plan only.
  run        Run pluggable compaction strategies; without --live, use synthetic responses only.
  calibrate  Check the value judge against omission, negation and chronology controls.

Inputs/output:
  --session-directory DIR     discover: repeatable; reads JSONL files directly in DIR
  --session FILE              discover: repeatable
  --limit N                   discover: max checkpoints, round-robin across sessions (default 24)
  --corpus FILE               draft/run: pinned manifest
  --case ID                   draft/run: repeatable case selection
  --output FILE               Required NEW private artifact outside this worktree; never overwrite

Run controls:
  --strategies LIST           stock,identity,parallel-split,chunks-sync,chunks-parallel
                              default: stock,identity,parallel-split; stock is mandatory
  --adapter FILE              Add a TRUSTED executable strategy module; repeatable
  --repetitions N             Paired blocked repetitions (default 3)
  --judge-repetitions N       Independent blinded judge calls per summary (default 1)
  --speed-only                No model judging or calibration
  --allow-draft-rubrics       Explicit exploratory scoring; not a curated quality benchmark
  --seed N                    Reproducible order/bootstrap seed (default 1729)
  --workers N                 Parallel map workers (default 4)
  --chunk-tokens N            Estimated native-serialized tokens per map chunk (default 12000)
  --max-chunks N              Map fanout bound (default 16)

Live controls (explicit, shared by generation/rubric/judging/calibration):
  --live                      Send private source content to the configured model provider
  --model PROVIDER/ID         Authenticated physical model (default openai/gpt-6-luna)
  --thinking LEVEL            Requested effort (default low)
  --max-output-tokens N       Same per-call SDK output cap; thinking expansion reserved (default 4096)
  --max-cost-usd N            REQUIRED positive conservative SDK-estimated run budget
  --max-calls N               REQUIRED positive total provider-call cap
  --timeout-ms N              Per-trial/judge timeout (default 180000)

Value runs first calibrate the judge with four synthetic controls, then time all strategies,
then grade shuffled summaries. Invalid grades are UNSCORED, not zero. Drafts need human audit.
Smoke timings/scores are not performance/quality evidence. The budget is not an invoice guarantee.
`;

export function parseBenchmarkArguments(args: string[]) {
    const options = {command: args[0] ?? "help", help: false, live: false, corpus: "", output: "", model: "openai/gpt-6-luna",
        thinking: "low" as CompactionThinkingLevel, directories: [] as string[], files: [] as string[], cases: [] as string[],
        adapters: [] as string[], strategies: ["stock", "identity", "parallel-split"], limit: 24, repetitions: 3,
        judgeRepetitions: 1, seed: 1729, workers: 4, chunkTokens: 12000, maxChunks: 16,
        maxOutputTokens: 4096, maxCostUsd: 0, maxCalls: 0, timeoutMs: 180000, speedOnly: false, allowDraftRubrics: false};
    if (args.length === 0 || args[0] === "--help" || args[0] === "help") { options.help = true; return options; }
    if (!["discover", "draft", "run", "calibrate"].includes(options.command)) throw new Error("Unknown benchmark command");
    const localFlags = ["--help", "--output"];
    const liveFlags = [...localFlags, "--live", "--model", "--thinking", "--max-output-tokens", "--max-cost-usd", "--max-calls", "--timeout-ms"];
    const allowed: Record<string, Set<string>> = {
        discover: new Set([...localFlags, "--session-directory", "--session", "--limit"]),
        draft: new Set([...liveFlags, "--corpus", "--case"]),
        calibrate: new Set(liveFlags),
        run: new Set([...liveFlags, "--corpus", "--case", "--strategies", "--adapter", "--repetitions", "--judge-repetitions",
            "--speed-only", "--allow-draft-rubrics", "--seed", "--workers", "--chunk-tokens", "--max-chunks"]),
    };
    const numbers = new Map([
        ["--limit", "limit"], ["--repetitions", "repetitions"], ["--judge-repetitions", "judgeRepetitions"],
        ["--seed", "seed"], ["--workers", "workers"], ["--chunk-tokens", "chunkTokens"], ["--max-chunks", "maxChunks"],
        ["--max-output-tokens", "maxOutputTokens"], ["--max-calls", "maxCalls"], ["--timeout-ms", "timeoutMs"],
    ] as const);
    for (let index = 1; index < args.length; index++) {
        const flag = args[index]!;
        if (!allowed[options.command]!.has(flag)) throw new Error(`${flag} is not valid for ${options.command}`);
        if (flag === "--help") { options.help = true; continue; }
        if (flag === "--live") { options.live = true; continue; }
        if (flag === "--speed-only") { options.speedOnly = true; continue; }
        if (flag === "--allow-draft-rubrics") { options.allowDraftRubrics = true; continue; }
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        const numeric = numbers.get(flag as Parameters<typeof numbers.get>[0]);
        if (numeric) {
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed) || parsed < (numeric === "seed" ? 0 : 1) || numeric === "seed" && parsed > 0xffffffff) {
                throw new Error(`Invalid positive integer for ${flag}`);
            }
            options[numeric] = parsed;
        } else if (flag === "--session-directory") options.directories.push(path.resolve(value));
        else if (flag === "--session") options.files.push(path.resolve(value));
        else if (flag === "--case") options.cases.push(value);
        else if (flag === "--adapter") options.adapters.push(path.resolve(value));
        else if (flag === "--strategies") options.strategies = value.split(",");
        else if (flag === "--corpus") options.corpus = path.resolve(value);
        else if (flag === "--output") options.output = path.resolve(value);
        else if (flag === "--model") options.model = value;
        else if (flag === "--thinking") {
            if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) throw new Error("Invalid thinking level");
            options.thinking = value as CompactionThinkingLevel;
        } else if (flag === "--max-cost-usd") {
            options.maxCostUsd = Number(value);
            if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) throw new Error("Invalid cost budget");
        } else throw new Error(`Unknown benchmark option ${flag}`);
    }
    if (options.help) return options;
    if (!options.output) throw new Error("--output is required; use a new private path outside the repository");
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    if (options.output === root || options.output.startsWith(root + path.sep)) throw new Error("Private benchmark artifacts must be outside the worktree");
    if (["draft", "run"].includes(options.command) && !options.corpus) throw new Error("--corpus is required");
    if (options.live && (!options.maxCostUsd || !options.maxCalls)) throw new Error("--live requires explicit --max-cost-usd and --max-calls");
    if (options.command === "discover" && options.live) throw new Error("Discovery is local-only; --live is not valid");
    if (options.command === "discover" && !options.files.length && !options.directories.length) throw new Error("Discovery requires --session or --session-directory");
    return options;
}

/** Resolve existing directory aliases before creating nested output directories; do not follow an existing target file. */
export async function validatePrivateOutput(file: string): Promise<string> {
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    let directory = path.dirname(path.resolve(file));
    const missing: string[] = [];
    for (;;) {
        let existing: string;
        try { existing = await realpath(directory); }
        catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            missing.unshift(path.basename(directory));
            directory = path.dirname(directory);
            continue;
        }
        const resolved = path.join(existing, ...missing, path.basename(file));
        if (resolved === root || resolved.startsWith(root + path.sep)) throw new Error("Private benchmark artifacts must be outside the worktree (resolved path)");
        return resolved;
    }
}

async function main(): Promise<void> {
    const options = parseBenchmarkArguments(process.argv.slice(2));
    if (options.help) { process.stdout.write(help); return; }
    options.output = await validatePrivateOutput(options.output);
    const artifacts = await BenchmarkArtifacts.create(options.output, {status: "initializing", command: options.command});
    const corpusOwner = new CompactionCorpus();
    if (options.command === "discover") {
        const files = [...options.files];
        for (const directory of options.directories) {
            files.push(...(await readdir(directory)).filter((name) => name.endsWith(".jsonl"))
                .map((name) => path.join(directory, name)));
        }
        const corpus = await corpusOwner.discover(files, options.limit);
        await artifacts.save(corpus);
        console.log(JSON.stringify({artifact: options.output, cases: corpus.cases.length,
            sessions: new Set(corpus.cases.map((item) => item.cluster)).size, rejected: corpus.rejected.length}));
        return;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("Benchmark cancelled by SIGINT"));
    process.once("SIGINT", interrupt);
    try {
        let budget: BudgetedModel | undefined;
        let model = smokeModel();
        if (options.live) {
            const runtime = await ModelRuntime.create({refreshOnCreate: false});
            const selected = (await runtime.getAvailable()).find((model) => `${model.provider}/${model.id}` === options.model);
            if (!selected || !runtime.getPhysicalModel(selected.provider, selected.id)) throw new Error("Requested physical model is unavailable");
            model = selected;
            budget = new BudgetedModel(runtime, model, {maxCalls: options.maxCalls, maxCostUsd: options.maxCostUsd,
                maxOutputTokens: options.maxOutputTokens, thinkingLevel: options.thinking});
            process.stderr.write(`LIVE private-source benchmark: ${options.model}; cap ${options.maxCalls} calls / $${options.maxCostUsd} estimated.\n`);
        }
        const grader = budget ? new ValueRetention(budget.complete(options.command === "draft" ? "rubric" : "judge")) : undefined;
        if (options.command === "calibrate") {
            if (!grader) {
                await artifacts.save({mode: "calibration-plan", controls: calibrationSummaries.map((item) => item.id), note: "No model calls made"});
                console.log(`Calibration plan: ${options.output}`); return;
            }
            const configuration = {node: process.version, ...options, codeHashes: await codeHashes([])};
            const grades = await calibrate(grader, controller.signal, options.timeoutMs, budget!);
            const passed = calibrationPassed(grades);
            await artifacts.save({mode: "live", model: options.model, configuration, passed, grades,
                controls: {reference: calibrationReference, rubric: calibrationRubric, summaries: calibrationSummaries}, budget: budget?.snapshot()});
            console.log(JSON.stringify({artifact: options.output, passed, budget: budgetTotals(budget)}));
            if (!passed) process.exitCode = 1;
            return;
        }
        const corpus = await corpusOwner.read(options.corpus);
        if (new Set(options.cases).size !== options.cases.length || options.cases.some((id) => !corpus.cases.some((item) => item.id === id))) {
            throw new Error("Duplicate or unknown case selection");
        }
        const selected = corpus.cases.filter((item) => !options.cases.length || options.cases.includes(item.id));
        if (options.command === "draft") {
            if (!grader) {
                await artifacts.save({mode: "draft-plan", corpusHash: fingerprint(corpus), cases: selected.map((item) => item.id), note: "No model calls made"});
                console.log(`Rubric drafting plan: ${options.output}`); return;
            }
            const inputs = [];
            for (const definition of selected) inputs.push(await corpusOwner.prepare(definition));
            for (const prepared of inputs) {
                const {definition} = prepared;
                if (budget?.blockedReason || controller.signal.aborted) throw new Error(budget?.blockedReason ?? "Drafting cancelled");
                const result = await boundedOperation((signal) => grader.draft(prepared.reference, signal), controller.signal, options.timeoutMs);
                if (result.status !== "ok") {
                    await artifacts.save({status: "drafting-failed", corpus, caseId: definition.id, error: result.error, budget: budget?.snapshot()});
                    throw new Error("Rubric drafting failed; inspect the private diagnostic artifact");
                }
                definition.rubric = result.value;
                await artifacts.save({...corpus, drafting: {model: options.model, budget: budget?.snapshot()}});
            }
            console.log(JSON.stringify({artifact: options.output, drafted: selected.length, status: "draft", budget: budgetTotals(budget)}));
            return;
        }
        const activeCorpus = {...corpus, cases: selected};
        const prepared = [];
        for (const definition of selected) prepared.push(await corpusOwner.prepare(definition));
        const strategies = await loadStrategies(options);
        const valueGrader = options.live && !options.speedOnly ? grader : undefined;
        const engine = new CompactionBenchmark({
            mode: options.live ? "live" : "smoke", corpus: activeCorpus, cases: prepared, model,
            thinking: options.live ? options.thinking : "off", strategies, repetitions: options.repetitions,
            judgeRepetitions: valueGrader ? options.judgeRepetitions : 0, seed: options.seed, timeoutMs: options.timeoutMs,
            stream: budget ? budget.stream("summary") : () => smokeStream(model), signal: controller.signal,
            grader: valueGrader, budget, allowDraftRubrics: options.allowDraftRubrics,
            onProgress: async (report) => artifacts.save({configuration, corpus: activeCorpus, report, calibration,
                budget: budget?.snapshot(), note: report.mode === "smoke" ? "SYNTHETIC SMOKE ONLY, not latency or retention evidence" : "Model-based retention scores are fallible; critical failures and unscored judgments must be reviewed"}),
        });
        const configuration = {node: process.version, pi: corpus.piVersion, ...options, corpusHash: fingerprint(activeCorpus),
            strategies: strategies.map((strategy) => strategy.id), codeHashes: await codeHashes(options.adapters)};
        let calibration: Record<string, ValueGrade> | undefined;
        if (valueGrader) {
            calibration = await calibrate(valueGrader, controller.signal, options.timeoutMs, budget!);
            if (!calibrationPassed(calibration)) {
                await artifacts.save({status: "judge-calibration-failed", configuration, calibration, budget: budget?.snapshot()});
                throw new Error("Value judge failed controls; no timed strategies were run");
            }
        }
        const report = await engine.run();
        const summary = summarizeBenchmark(report);
        await artifacts.save({configuration, corpus: activeCorpus, report, summary, calibration, budget: budget?.snapshot(),
            note: report.mode === "smoke" ? "SYNTHETIC SMOKE ONLY, no performance/quality claims" : "No equivalence claim; inspect critical failures, uncertainty, cache effects and final summary size"});
        console.log(JSON.stringify({artifact: options.output, summary, budget: budgetTotals(budget)}, null, 2));
        if (report.interrupted || report.trials.some((trial) => trial.result.error || !trial.result.metadataPassed) ||
            report.judgments.some((item) => item.grade.status === "unscored" || item.grade.gate !== "pass")) process.exitCode = 1;
    } finally { process.removeListener("SIGINT", interrupt); }
}

async function calibrate(grader: ValueRetention, signal: AbortSignal, timeoutMs: number, budget: BudgetedModel): Promise<Record<string, ValueGrade>> {
    const grades: Record<string, ValueGrade> = {};
    for (const control of calibrationSummaries) {
        if (budget.blockedReason || signal.aborted) {
            grades[control.id] = {status: "unscored", error: budget.blockedReason ?? "Calibration cancelled"}; continue;
        }
        const result = await boundedOperation((signal) => grader.grade({reference: calibrationReference, rubric: calibrationRubric,
            summary: control.summary, signal}), signal, timeoutMs);
        grades[control.id] = result.status === "ok" ? result.value : {status: "unscored", error: result.error};
        if (!result.cleanupComplete) break;
    }
    return grades;
}

async function loadStrategies(options: ReturnType<typeof parseBenchmarkArguments>): Promise<CompactionExperiment[]> {
    const chunkConfig = {chunkTokens: options.chunkTokens, maxChunks: options.maxChunks};
    const builtins: Record<string, CompactionExperiment> = {stock: stockCompaction, identity, "parallel-split": parallelSplit,
        "chunks-sync": createChunkedCompaction({id: "chunks-sync", concurrency: 1, ...chunkConfig}),
        "chunks-parallel": createChunkedCompaction({id: "chunks-parallel", concurrency: options.workers, ...chunkConfig})};
    if (!options.strategies.includes("stock") || new Set(options.strategies).size !== options.strategies.length) throw new Error("Strategies must include stock and be unique");
    const strategies = options.strategies.map((id) => {
        if (!Object.hasOwn(builtins, id)) throw new Error(`Unknown strategy ${id}`);
        return builtins[id]!;
    });
    for (const file of options.adapters) {
        const value: unknown = (await import(pathToFileURL(file).href)).default;
        if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id.trim() ||
            !("run" in value) || typeof value.run !== "function") throw new Error("Invalid trusted strategy adapter");
        strategies.push(value as CompactionExperiment);
    }
    return [stockCompaction, ...strategies.filter((strategy) => strategy !== stockCompaction)];
}

function budgetTotals(budget: BudgetedModel | undefined) {
    const snapshot = budget?.snapshot();
    return snapshot ? {calls: snapshot.calls.length, spentUsd: snapshot.spentUsd,
        reservedUsd: snapshot.reservedUsd, blockedReason: snapshot.blockedReason} : undefined;
}

async function codeHashes(adapters: string[]): Promise<Record<string, string>> {
    const files = ["CompactionEvaluation", "ParallelSplit", "ChunkedCompaction", "ValueRetention", "BenchmarkTypes", "BenchmarkCorpus",
        "CompactionBenchmark", "BenchmarkStatistics", "BudgetedModel", "BenchmarkCalibration", "BenchmarkDeadline", "BenchmarkArtifacts", "SessionReplay", "IdentityControl"]
        .map((name) => fileURLToPath(new URL(`../experiments/compaction/${name}.ts`, import.meta.url)));
    files.push(fileURLToPath(import.meta.url), ...adapters);
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
    return hashes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
