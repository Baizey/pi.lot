import {readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {compact, ModelRuntime} from "@earendil-works/pi-coding-agent";
import {CompactionEvaluation, scoreRetention, stockCompaction, type RetentionCheck} from "../experiments/compaction/CompactionEvaluation.js";
import {sessionReplay, type ReplaySelection} from "../experiments/compaction/SessionReplay.js";
import {smokeModel, smokeStream} from "./evaluate-compaction.js";

/** Local experiment only: never import this CLI from the production extension. */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const selections: ReplaySelection[] = [];
    let profileDirectory = "";
    let output = "/tmp/pilot-real-compaction-results.json";
    let factsFile = "";
    let live = false;
    let repetitions = 2;
    let requestedModel = "openai/gpt-6-luna";
    for (let index = 0; index < args.length; index++) {
        const flag = args[index]!;
        if (flag === "--live") { live = true; continue; }
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        if (flag === "--session") selections.push({file: path.resolve(value), checkpoint: 0});
        else if (flag === "--checkpoint") {
            if (!selections.length) throw new Error("--checkpoint must follow a --session");
            const checkpoint = Number(value);
            if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) throw new Error("Invalid checkpoint index");
            selections.at(-1)!.checkpoint = checkpoint;
        } else if (flag === "--profile-directory") profileDirectory = path.resolve(value);
        else if (flag === "--output") output = path.resolve(value);
        else if (flag === "--facts") factsFile = path.resolve(value);
        else if (flag === "--model") requestedModel = value;
        else if (flag === "--repetitions") {
            repetitions = Number(value);
            if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetition count");
        } else throw new Error(`Unknown option ${flag}`);
    }
    if (profileDirectory) {
        if (live) throw new Error("Profiling never makes live model calls");
        for (const name of (await readdir(profileDirectory)).filter((name) => name.endsWith(".jsonl") && !name.includes("subagent-")).sort()) {
            const file = path.join(profileDirectory, name);
            const source = await readFile(file, "utf8");
            const count = source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {type: string})
                .filter((entry) => entry.type === "compaction").length;
            for (let checkpoint = 0; checkpoint < count; checkpoint++) selections.push({file, checkpoint});
        }
    }
    if (!selections.length) throw new Error("Specify --session FILE [--checkpoint INDEX] or --profile-directory DIR");
    const facts: Record<string, RetentionCheck[]> = factsFile ? JSON.parse(await readFile(factsFile, "utf8")) : {};
    const replays = [];
    for (const selection of selections) {
        const replay = await sessionReplay(selection);
        replay.fixture.checks = facts[replay.fixture.id] ?? [];
        if (factsFile && replay.fixture.checks.length === 0) {
            throw new Error(`No source-grounded checks supplied for ${replay.fixture.id}`);
        }
        replays.push(replay);
    }
    const profiles = [];
    for (const replay of replays) {
        const promptChars: number[] = [];
        const promptTexts: string[] = [];
        await compact(structuredClone(replay.preparation), smokeModel(), undefined, undefined, undefined, undefined, "low",
            (_model, context) => {
                promptChars.push(JSON.stringify(context).length);
                promptTexts.push(context.messages.map((message) => typeof message.content === "string" ? message.content
                    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n"));
                return smokeStream(smokeModel());
            });
        const sourceChecks = scoreRetention(promptTexts.join("\n"), replay.fixture.checks);
        if (factsFile && sourceChecks.some((check) => !check.passed)) {
            throw new Error(`Rubric terms absent from actual summary input for ${replay.fixture.id}: ${sourceChecks.filter((check) => !check.passed).map((check) => check.id).join(", ")}`);
        }
        profiles.push({...replay.metadata, promptChars, sourceChecks,
            historicalBoundaryMatches: replay.metadata.historicalFirstKeptEntryId === replay.metadata.capturedFirstKeptEntryId});
    }
    if (!live) {
        await writeFile(output, JSON.stringify({mode: "profile-only", profiles}, null, 2) + "\n", {mode: 0o600});
        for (const profile of profiles) console.log(JSON.stringify(profile));
        return;
    }
    if (profiles.some((profile) => profile.promptChars.some((chars) => chars > 800_000))) {
        throw new Error("A replay prompt exceeds the conservative initial-run size limit; select a smaller checkpoint");
    }
    const runtime = await ModelRuntime.create({refreshOnCreate: false});
    const model = (await runtime.getAvailable()).find((model) => `${model.provider}/${model.id}` === requestedModel);
    if (!model || !runtime.getPhysicalModel(model.provider, model.id)) throw new Error(`Unavailable physical model: ${requestedModel}`);
    if (requestedModel !== "openai/gpt-6-luna") throw new Error("This initial cheap-model experiment is restricted to openai/gpt-6-luna");
    const {default: parallel} = await import("../experiments/compaction/ParallelSplit.js");
    let callNumber = 0;
    process.stderr.write(`LIVE: replaying ${replays.length} private session checkpoints using ${requestedModel}, low thinking, ${repetitions} paired repetitions.\n`);
    const report = await new CompactionEvaluation({
        mode: "live", model, thinkingLevel: "low", fixtures: replays.map((replay) => replay.fixture),
        experiments: [stockCompaction, parallel], repetitions, timeoutMs: 180_000,
        stream: (requested, context, options) => {
            process.stderr.write(`Model request ${++callNumber}\n`);
            return runtime.streamSimple(requested, context, options);
        },
    }).run();
    await writeFile(output, JSON.stringify({
        ...report, profiles, pricePerMillionTokens: model.cost,
        note: "Private real-session replay. Native Pi 1.4 baseline vs parallel native history/prefix requests only. Same current default 20,000-token tail, selected model, low thinking and preparation. No production install. Literal checks are not semantic-quality proof.",
    }, null, 2) + "\n", {mode: 0o600});
    for (const trial of report.trials) console.log(JSON.stringify({
        fixture: trial.fixture, experiment: trial.experiment, repetition: trial.repetition,
        seconds: +(trial.durationMs / 1000).toFixed(3), calls: trial.calls.length,
        input: trial.usage.input, cached: trial.usage.cacheRead, output: trial.usage.output,
        cost: trial.usage.cost, usageComplete: trial.usageComplete, metadataPassed: trial.metadataPassed,
        checks: trial.checks, error: trial.error,
    }));
    console.log(JSON.stringify({comparisons: report.comparisons, interrupted: report.interrupted, report: output}, null, 2));
    if (report.trials.some((trial) => trial.error || !trial.metadataPassed)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
