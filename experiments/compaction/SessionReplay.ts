import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    createAgentSession, DefaultResourceLoader, migrateSessionEntries, ModelRuntime,
    parseSessionEntries, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {CompactionFixture, CompactionPreparation, RetentionCheck} from "./CompactionEvaluation.js";

export type ReplaySelection = {file: string; checkpoint: number};
export type ReplayMetadata = ReplaySelection & {
    sessionId: string;
    parentSession?: string;
    sourceHash: string;
    checkpointId: string;
    historicalFirstKeptEntryId: string;
    capturedFirstKeptEntryId: string;
    tokensBefore: number;
    historyMessages: number;
    prefixMessages: number;
    previousSummary: boolean;
    split: boolean;
};

/** Read-only replay: use the actual parent branch of a historical checkpoint, never its future entries. */
export async function sessionReplay(selection: ReplaySelection, checks: RetentionCheck[] = []): Promise<{
    fixture: CompactionFixture; metadata: ReplayMetadata; preparation: CompactionPreparation;
}> {
    const source = await readFile(selection.file, "utf8");
    const entries = parseSessionEntries(source);
    if (!entries.length || entries[0]?.type !== "session") throw new Error("Missing session header");
    migrateSessionEntries(entries);
    const header = entries[0];
    if (typeof header.id !== "string" || !header.id.trim()) throw new Error("Invalid native session ID");
    const checkpoint = entries.filter((entry) => entry.type === "compaction")[selection.checkpoint];
    if (!checkpoint || checkpoint.type !== "compaction" || !checkpoint.parentId) {
        throw new Error(`Missing historical checkpoint ${selection.checkpoint} or its parent`);
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-real-compaction-"));
    let preparation: CompactionPreparation | undefined;
    try {
        const settingsManager = SettingsManager.inMemory({
            compaction: {enabled: true, reserveTokens: 16384, keepRecentTokens: 20000},
            retry: {enabled: false},
        });
        const modelRuntime = await ModelRuntime.create({
            credentials: {async read() { return undefined; }, async list() { return []; },
                async modify() { throw new Error("Replay capture cannot write credentials"); },
                async delete() { throw new Error("Replay capture cannot delete credentials"); }},
            modelsPath: null, refreshOnCreate: false,
        });
        const loader = new DefaultResourceLoader({
            cwd: directory, agentDir: directory, settingsManager,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [(pi) => {
                pi.on("session_before_compact", (event) => {
                    preparation = structuredClone(event.preparation);
                    return {cancel: true};
                });
            }],
        });
        await loader.reload();
        if (loader.getExtensions().errors.length) throw new Error("Replay capture extension failed to load");
        const manager = SessionManager.inMemory(directory, undefined, entries);
        if (!manager.getEntry(checkpoint.parentId)) throw new Error("Historical checkpoint parent is missing");
        manager.branch(checkpoint.parentId);
        const {session} = await createAgentSession({
            cwd: directory, agentDir: directory, sessionManager: manager, modelRuntime, settingsManager,
            resourceLoader: loader, noTools: "all",
            model: {provider: "replay-capture", id: "offline", name: "Offline boundary capture",
                api: "openai-responses", baseUrl: "https://offline.invalid", reasoning: false,
                input: ["text"], contextWindow: 1_000_000, maxTokens: 8192,
                cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}},
        });
        try {
            await session.bindExtensions({});
            await session.compact();
        } catch (error) {
            if (!(error instanceof Error) || error.message !== "Compaction cancelled") throw error;
        } finally {
            session.dispose();
        }
        if (!preparation) throw new Error("Historical branch did not yield a compaction preparation");
        const captured = preparation;
        const metadata: ReplayMetadata = {
            ...selection, sessionId: header.id,
            ...(header.parentSession ? {parentSession: header.parentSession} : {}),
            sourceHash: createHash("sha256").update(source).digest("hex"), checkpointId: checkpoint.id,
            historicalFirstKeptEntryId: checkpoint.firstKeptEntryId,
            capturedFirstKeptEntryId: captured.firstKeptEntryId,
            tokensBefore: captured.tokensBefore, historyMessages: captured.messagesToSummarize.length,
            prefixMessages: captured.turnPrefixMessages.length, previousSummary: Boolean(captured.previousSummary),
            split: captured.isSplitTurn,
        };
        return {preparation: captured, metadata, fixture: {
            id: `${header.id}:checkpoint-${selection.checkpoint}`,
            prepare: () => structuredClone(captured), checks,
            reviewQuestions: [
                "Are the user's current goal, constraints, pending work and next actions correctly represented?",
                "Are superseded decisions distinguished from current decisions, and unverified work from completed work?",
                "Are necessary paths, identifiers, failures and follow-up handles retained without inventing state?",
            ],
        }};
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
}
