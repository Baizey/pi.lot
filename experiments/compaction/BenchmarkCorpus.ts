import {readFile} from "node:fs/promises";
import path from "node:path";
import {findPackageJSON} from "node:module";
import {convertToLlm, parseSessionEntries, serializeConversation} from "@earendil-works/pi-coding-agent";
import {fingerprint, type CompactionPreparation} from "./CompactionEvaluation.js";
import {sessionReplay, type ReplaySelection} from "./SessionReplay.js";
import type {BenchmarkCase, BenchmarkCorpus, PreparedBenchmarkCase, ReferenceInput} from "./BenchmarkTypes.js";
import {validateRubric} from "./ValueRetention.js";

/** Corpus files contain private source paths/quotes. Nothing is uploaded by discovery or validation. */
export class CompactionCorpus {
    async discover(files: string[], limit: number): Promise<BenchmarkCorpus> {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Corpus limit must be a positive integer");
        const corpus: BenchmarkCorpus = {version: 1, piVersion: await this.piVersion(), cases: [], rejected: []};
        const candidates: ReplaySelection[][] = [];
        const sessionIds = new Set<string>();
        for (const file of [...new Set(files.map((file) => path.resolve(file)))].sort()) {
            try {
                const entries = parseSessionEntries(await readFile(file, "utf8"));
                const header = entries[0];
                if (!header || header.type !== "session") throw new Error("Missing session header");
                const id = nonempty(header.id, "native session ID");
                if (sessionIds.has(id)) throw new Error("Duplicate native session ID/alias excluded");
                if (header.parentSession) throw new Error("Child/fork session excluded from root-session corpus");
                const count = entries.filter((entry) => entry.type === "compaction").length;
                if (!count) throw new Error("No historical compaction checkpoint");
                sessionIds.add(id);
                candidates.push(Array.from({length: count}, (_unused, checkpoint) => ({file, checkpoint})));
            } catch (error) {
                corpus.rejected.push({file, reason: errorText(error)});
            }
        }
        // Round-robin across sessions instead of filling the sample from one long transcript.
        for (let checkpoint = 0; corpus.cases.length < limit && candidates.some((group) => group[checkpoint]); checkpoint++) {
            for (const group of candidates) {
                const selection = group[checkpoint];
                if (!selection || corpus.cases.length >= limit) continue;
                try {
                    const replay = await sessionReplay(selection);
                    const reference = referenceInputs(replay.preparation);
                    corpus.cases.push({
                        id: replay.fixture.id, cluster: replay.metadata.sessionId,
                        source: {...selection, sha256: replay.metadata.sourceHash},
                        preparationHash: fingerprint(replay.preparation), referenceHash: fingerprint(reference),
                        tokensBefore: replay.preparation.tokensBefore,
                        historyMessages: replay.preparation.messagesToSummarize.length,
                        prefixMessages: replay.preparation.turnPrefixMessages.length,
                    });
                } catch (error) {
                    corpus.rejected.push({...selection, reason: errorText(error)});
                }
            }
        }
        if (!corpus.cases.length) throw new Error("No usable historical compaction cases");
        return corpus;
    }

    async read(file: string): Promise<BenchmarkCorpus> {
        const value: unknown = JSON.parse(await readFile(file, "utf8"));
        const record = object(value, "corpus");
        if (record.version !== 1 || typeof record.piVersion !== "string" || !Array.isArray(record.cases) || !record.cases.length) {
            throw new Error("Invalid corpus version, Pi version, or cases");
        }
        if (record.piVersion !== await this.piVersion()) throw new Error("Corpus Pi version differs from installed Pi; recapture explicitly");
        const ids = new Set<string>();
        const sources = new Set<string>();
        const cases: BenchmarkCase[] = [];
        for (const item of record.cases) {
            const definition = object(item, "case");
            const source = object(definition.source, "source");
            const id = nonempty(definition.id, "case id");
            const file = nonempty(source.file, "session file");
            const checkpoint = integer(source.checkpoint, "checkpoint");
            const sourceKey = `${file}\0${checkpoint}`;
            if (!path.isAbsolute(file) || ids.has(id) || sources.has(sourceKey)) throw new Error("Case sources must be absolute and unique");
            ids.add(id); sources.add(sourceKey);
            const result: BenchmarkCase = {
                id, cluster: nonempty(definition.cluster, "cluster"),
                source: {file, checkpoint, sha256: digest(source.sha256)},
                preparationHash: digest(definition.preparationHash), referenceHash: digest(definition.referenceHash),
                tokensBefore: integer(definition.tokensBefore, "tokensBefore"),
                historyMessages: integer(definition.historyMessages, "historyMessages"),
                prefixMessages: integer(definition.prefixMessages, "prefixMessages"),
            };
            if (definition.rubric !== undefined) {
                const prepared = await this.prepare(result);
                result.rubric = validateRubric(definition.rubric, prepared.reference);
            }
            cases.push(result);
        }
        if (!Array.isArray(record.rejected)) throw new Error("Invalid corpus rejection metadata");
        const rejected = record.rejected.map((item) => {
            const entry = object(item, "rejection");
            return {file: nonempty(entry.file, "rejected source"), reason: nonempty(entry.reason, "rejection reason"),
                ...(entry.checkpoint === undefined ? {} : {checkpoint: integer(entry.checkpoint, "rejected checkpoint")})};
        });
        return {version: 1, piVersion: record.piVersion, cases, rejected};
    }

    async prepare(definition: BenchmarkCase): Promise<PreparedBenchmarkCase> {
        const replay = await sessionReplay({file: definition.source.file, checkpoint: definition.source.checkpoint});
        if (replay.metadata.parentSession) throw new Error("Child/fork session excluded from root-session corpus");
        const reference = referenceInputs(replay.preparation);
        if (replay.metadata.sourceHash !== definition.source.sha256 || replay.fixture.id !== definition.id ||
            replay.metadata.sessionId !== definition.cluster || fingerprint(replay.preparation) !== definition.preparationHash ||
            fingerprint(reference) !== definition.referenceHash || replay.preparation.tokensBefore !== definition.tokensBefore ||
            replay.preparation.messagesToSummarize.length !== definition.historyMessages ||
            replay.preparation.turnPrefixMessages.length !== definition.prefixMessages) {
            throw new Error(`Corpus source/preparation changed for ${definition.id}; refusing a non-paired replay`);
        }
        if (definition.rubric) validateRubric(definition.rubric, reference);
        return {definition, preparation: replay.preparation, reference};
    }

    private async piVersion(): Promise<string> {
        const packageFile = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
        if (!packageFile) throw new Error("Cannot locate Pi package version");
        const metadata = object(JSON.parse(await readFile(packageFile, "utf8")), "Pi package");
        return nonempty(metadata.version, "Pi version");
    }
}

/** Same public serializer used by Pi: thinking/images omitted, tool results capped as in stock compaction. */
export function referenceInputs(preparation: CompactionPreparation): ReferenceInput[] {
    const reference: ReferenceInput[] = [];
    if (preparation.previousSummary) reference.push({id: "previous-summary", text: preparation.previousSummary});
    if (preparation.messagesToSummarize.length) reference.push({id: "history", text: serializeConversation(convertToLlm(preparation.messagesToSummarize))});
    if (preparation.turnPrefixMessages.length) reference.push({id: "turn-prefix", text: serializeConversation(convertToLlm(preparation.turnPrefixMessages))});
    return reference;
}

/** Grade-only provenance for deterministic native footers; excluded from native inputs and their hashes. */
export function gradingInputs(prepared: PreparedBenchmarkCase): ReferenceInput[] {
    const modified = new Set([...prepared.preparation.fileOps.written, ...prepared.preparation.fileOps.edited]);
    const readFiles = [...prepared.preparation.fileOps.read].filter((file) => !modified.has(file)).sort();
    const modifiedFiles = [...modified].sort();
    return [...prepared.reference, {id: "file-operations", text:
        "Authoritative native assembly file-operations context: these paths are recorded file operations from the preparation. " +
        "Native <read-files> lists files read but not modified; <modified-files> lists the union of written and edited files. " +
        "This inventory is not verification of implementation correctness, completed procedures, or successful tests.\n" +
        JSON.stringify({readFiles, modifiedFiles})}];
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value as Record<string, unknown>;
}
function nonempty(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
    return value;
}
function integer(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) throw new Error(`Invalid ${label}`);
    return value;
}
function digest(value: unknown): string {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid corpus digest");
    return value;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
