import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {findPackageJSON} from "node:module";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import {
    CompactionEvaluation,
    stockCompaction,
    type CompactionExperiment,
    type CompactionModel,
    type CompactionStream,
    type CompactionThinkingLevel,
} from "../experiments/compaction/CompactionEvaluation.js";
import {compactionFixtures} from "../experiments/compaction/CompactionFixtures.js";

const help = `Usage: npm run eval:compaction -- [options]

Default: offline smoke test with synthetic replies. No credentials, network, or quality/speed claims.

  --live                      Make billable model calls with committed SYNTHETIC fixtures only
  --model provider/model      Required for --live; use an authenticated physical model
  --candidate /path/module.ts  Trusted executable module exporting {id, run}; no production changes
  --fixture name              Select one fixture (default: all four)
  --repetitions n              Paired trials, alternating order (default: 3)
  --thinking level            off|minimal|low|medium|high|xhigh|max (default: medium)
  --timeout-ms n              Per-trial deadline (default: 120000)
  --output file.json          Save report (otherwise stdout)
  --help                      Show this help

Reports include complete summaries, raw timings, per-call usage, literal retention checks, and
semantic-review questions. Passing literal checks is NOT evidence of equivalent semantic quality.
A candidate must use the supplied metered stream for every model call. Arbitrary modules are trusted code.
`;

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(help);
        return;
    }
    const experiments = [stockCompaction];
    let candidate: {path: string; sha256: string} | undefined;
    if (options.candidate) {
        const candidatePath = path.resolve(options.candidate);
        const source = await readFile(candidatePath);
        const loaded: unknown = (await import(pathToFileURL(candidatePath).href)).default;
        if (typeof loaded !== "object" || loaded === null || !("id" in loaded) ||
            typeof loaded.id !== "string" || !loaded.id.trim() || !("run" in loaded) || typeof loaded.run !== "function") {
            throw new Error("Candidate must default-export an object with a nonempty id and run(input) method");
        }
        experiments.push(loaded as CompactionExperiment);
        candidate = {path: candidatePath, sha256: createHash("sha256").update(source).digest("hex")};
    }
    const fixtures = options.fixture
        ? compactionFixtures.filter((fixture) => fixture.id === options.fixture) : compactionFixtures;
    if (fixtures.length === 0) throw new Error(`Unknown fixture: ${options.fixture}`);

    let model = smokeModel();
    let stream: CompactionStream = () => smokeStream(model);
    if (options.live) {
        if (!options.model) throw new Error("--live requires an explicit --model provider/model");
        process.stderr.write("Live evaluation: synthetic fixtures will be sent to the model provider; calls may be billable.\n");
        const runtime = await ModelRuntime.create();
        const available = await runtime.getAvailable();
        const selected = available.find((entry) => `${entry.provider}/${entry.id}` === options.model);
        if (!selected || !runtime.getPhysicalModel(selected.provider, selected.id)) {
            throw new Error(`Unknown, unauthenticated, or virtual model: ${options.model}`);
        }
        model = selected;
        stream = (requestedModel, context, requestOptions) => runtime.streamSimple(requestedModel, context, requestOptions);
    } else if (options.model) {
        throw new Error("--model requires --live; offline smoke mode never calls a real model");
    }

    const evaluation = new CompactionEvaluation({
        mode: options.live ? "live" : "smoke", model, stream, fixtures, experiments,
        thinkingLevel: options.thinking, repetitions: options.repetitions, timeoutMs: options.timeoutMs,
    });
    const report = await evaluation.run();
    const piPackagePath = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
    if (!piPackagePath) throw new Error("Cannot locate the installed Pi package metadata");
    const piPackage: {version: string} = JSON.parse(await readFile(piPackagePath, "utf8"));
    const serialized = JSON.stringify({
        ...report,
        environment: {node: process.version, pi: piPackage.version, candidate},
        note: options.live
            ? "Literal checks are only a regression screen. Review full summaries against the rubric before any quality claim."
            : "SMOKE ONLY: canned provider output validates the harness, not summarization quality or model latency.",
    }, null, 2) + "\n";
    if (options.output) await writeFile(path.resolve(options.output), serialized);
    else process.stdout.write(serialized);
    if (report.trials.some((trial) => trial.error || !trial.metadataPassed)) process.exitCode = 1;
    if (options.live && report.comparisons.some((comparison) => comparison.conclusion === "failed-checks")) process.exitCode = 1;
}

export function parseArguments(arguments_: string[]) {
    const options = {help: false, live: false, model: "", candidate: "", fixture: "", output: "",
        repetitions: 3, timeoutMs: 120_000, thinking: "medium" as CompactionThinkingLevel};
    for (let index = 0; index < arguments_.length; index++) {
        const flag = arguments_[index]!;
        if (flag === "--help") options.help = true;
        else if (flag === "--live") options.live = true;
        else {
            const value = arguments_[++index];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
            if (flag === "--model") options.model = value;
            else if (flag === "--candidate") options.candidate = value;
            else if (flag === "--fixture") options.fixture = value;
            else if (flag === "--output") options.output = value;
            else if (flag === "--repetitions" || flag === "--timeout-ms") {
                const number = Number(value);
                if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} must be a positive safe integer`);
                if (flag === "--repetitions") options.repetitions = number;
                else options.timeoutMs = number;
            } else if (flag === "--thinking") {
                if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
                    throw new Error(`Invalid thinking level: ${value}`);
                }
                options.thinking = value as CompactionThinkingLevel;
            } else throw new Error(`Unknown option: ${flag}`);
        }
    }
    return options;
}

export function smokeModel(): CompactionModel {
    return {id: "synthetic", name: "Offline smoke provider", provider: "pilot-compaction-smoke",
        api: "openai-responses", baseUrl: "https://offline.invalid", reasoning: false, input: ["text"],
        contextWindow: 1_000_000, maxTokens: 8192,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
}

export function smokeStream(model: CompactionModel) {
    const response: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{type: "text", text: "Synthetic provider reply. Not an LLM-generated summary."}],
        stopReason: "stop", timestamp: Date.now(),
        usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    };
    const stream = createAssistantMessageEventStream();
    stream.push({type: "done", reason: "stop", message: response});
    return stream;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
