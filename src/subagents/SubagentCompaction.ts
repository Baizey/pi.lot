import {createHash} from "node:crypto";
import {
    compact,
    SettingsManager,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
    type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import {contentText} from "@earendil-works/pi-ai";
import type {SubagentCoordinator} from "./SubagentCoordinator.js";
import {renderSubagentSnapshot} from "./SubagentSnapshotText.js";

const SECTION_PREFIX = "\n\n## Subagents\n\n";

type FileDetails = {readFiles: string[]; modifiedFiles: string[]};
type OwnedDetails = FileDetails & {
    pilotSubagentSnapshot: {version: 1; summaryTextLength: number; snapshotEnd: number; suffixSha256: string};
};

/** Root-only override: Pi still prepares, projects and saves the single compaction entry. */
export class SubagentCompaction {
    constructor(
        private readonly pi: ExtensionAPI,
        private readonly coordinator: () => SubagentCoordinator,
    ) {}

    register(): void {
        this.pi.on("session_before_compact", (event, ctx) => this.generate(event, ctx));
    }

    private async generate(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult> {
        try {
            event.signal.throwIfAborted();
            if (!ctx.model) throw new Error("No model selected for compaction");
            const preparation = this.prepare(event);
            const retry = SettingsManager.inMemory(this.pi.getSettings()).getRetrySettings();
            const result = await compact(
                preparation, ctx.model, undefined, undefined, event.customInstructions, event.signal, ctx.thinkingLevel,
                async (model, context, options) => {
                    // Public registry streaming owns auth and virtual routing for each summary
                    // request. It does not expose native pre-resolution or host agent streams.
                    const stream = ctx.modelRegistry.streamSimple(model, {messages: context.messages}, options);
                    const response = await stream.result();
                    event.signal.throwIfAborted();
                    if (response.stopReason === "aborted") throw new Error("Summary provider aborted");
                    // Pi rejects errors, length stops and tool calls itself, but accepts blank text.
                    // Reject blank successful responses before they can become snapshot-only checkpoints.
                    if (response.stopReason !== "error" && response.stopReason !== "length" && !contentText(response.content).trim()) {
                        throw new Error("Summary provider returned empty text");
                    }
                    return stream;
                },
                undefined, retry,
            );
            event.signal.throwIfAborted();
            const files = readFileDetails(result.details);
            if (!files) throw new Error("Stock compaction returned invalid file details");
            const suffix = fileSuffix(files);
            if (!result.summary.endsWith(suffix)) throw new Error("Stock compaction file suffix format changed");
            const summaryTextLength = result.summary.length - suffix.length;
            if (!result.summary.slice(0, summaryTextLength).trim()) throw new Error("Stock compaction returned an empty summary");
            const snapshot = renderSubagentSnapshot(this.coordinator().list(), Date.now());
            const summary = result.summary + SECTION_PREFIX + snapshot;
            const details: OwnedDetails = {
                ...files, pilotSubagentSnapshot: {
                    version: 1, summaryTextLength, snapshotEnd: summary.length,
                    suffixSha256: createHash("sha256").update(summary.slice(summaryTextLength)).digest("hex"),
                },
            };
            return {compaction: {...result, summary, details}};
        } catch (error) {
            // Pi reports hook exceptions and continues with its stock summarizer. Never throw:
            // cancellation deliberately prevents that fallback and its second generation attempt.
            try {
                if (!event.signal.aborted) ctx.ui.notify(
                    `Pilot compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error",
                );
            } finally {
                return {cancel: true};
            }
        }
    }

    private prepare(event: SessionBeforeCompactEvent): SessionBeforeCompactEvent["preparation"] {
        const preparation = event.preparation;
        const fileOps = {
            read: new Set(preparation.fileOps.read),
            written: new Set(preparation.fileOps.written),
            edited: new Set(preparation.fileOps.edited),
        };
        let previousSummary = preparation.previousSummary;
        const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
        if (previous?.type === "compaction" && previous.fromHook && previous.summary === previousSummary) {
            const owned = readOwnedDetails(previous.details);
            if (owned) {
                const {summaryTextLength, snapshotEnd, suffixSha256} = owned.pilotSubagentSnapshot;
                const suffix = previous.summary.slice(summaryTextLength, snapshotEnd);
                if (snapshotEnd <= previous.summary.length && suffix.startsWith(fileSuffix(owned) + SECTION_PREFIX)
                    && createHash("sha256").update(suffix).digest("hex") === suffixSha256) {
                    // Remove exactly our unchanged range, not unknown text another extension may
                    // have appended. Native extraction ignores fromHook file details: carry only ours.
                    previousSummary = previous.summary.slice(0, summaryTextLength) + previous.summary.slice(snapshotEnd);
                    for (const file of owned.readFiles) fileOps.read.add(file);
                    for (const file of owned.modifiedFiles) fileOps.edited.add(file);
                }
            }
        }
        return {...preparation, fileOps, previousSummary};
    }
}

function readFileDetails(value: unknown): FileDetails | undefined {
    if (typeof value !== "object" || value === null || !("readFiles" in value) || !("modifiedFiles" in value)) return;
    const {readFiles, modifiedFiles} = value;
    if (!Array.isArray(readFiles) || !readFiles.every((file): file is string => typeof file === "string")
        || !Array.isArray(modifiedFiles) || !modifiedFiles.every((file): file is string => typeof file === "string")) return;
    return {readFiles, modifiedFiles};
}

function readOwnedDetails(value: unknown): OwnedDetails | undefined {
    const files = readFileDetails(value);
    if (!files || typeof value !== "object" || value === null || !("pilotSubagentSnapshot" in value)) return;
    const marker = value.pilotSubagentSnapshot;
    if (typeof marker !== "object" || marker === null || !("version" in marker) || marker.version !== 1
        || !("summaryTextLength" in marker) || typeof marker.summaryTextLength !== "number"
        || !Number.isSafeInteger(marker.summaryTextLength) || marker.summaryTextLength < 0
        || !("snapshotEnd" in marker) || typeof marker.snapshotEnd !== "number" || !Number.isSafeInteger(marker.snapshotEnd)
        || marker.snapshotEnd < marker.summaryTextLength || !("suffixSha256" in marker)
        || typeof marker.suffixSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.suffixSha256)) return;
    return {...files, pilotSubagentSnapshot: {
        version: 1, summaryTextLength: marker.summaryTextLength, snapshotEnd: marker.snapshotEnd, suffixSha256: marker.suffixSha256,
    }};
}

// Pi 1.4 compact() appends this deterministic suffix but does not export its formatter.
// Verify it against the helper result before recording a boundary; never guess where history ends.
function fileSuffix(files: FileDetails): string {
    const sections: string[] = [];
    if (files.readFiles.length) sections.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
    if (files.modifiedFiles.length) sections.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
    return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}
