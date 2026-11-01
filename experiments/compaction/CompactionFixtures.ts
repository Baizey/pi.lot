import os from "node:os";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {AssistantMessage, JsonObject} from "@earendil-works/pi-ai";
import type {CompactionFixture, CompactionPreparation} from "./CompactionEvaluation.js";

const cost = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0};
const emptyUsage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost};

/** Synthetic, committed cases only. Running these never uploads a user's session history. */
export const compactionFixtures: CompactionFixture[] = [
    {
        id: "tool-result-tail",
        prepare() {
            const history = new FixtureHistory();
            history.user("Diagnose the query test failure. Preserve the exact failing case for the next developer.");
            history.tool("bash", {command: "npm test -- query"},
                "Setup diagnostics: fixture loaded successfully. ".repeat(100) +
                "\nFAIL QUERY-482: src/query/Plan.ts loses the ORDER BY clause after filtering.");
            history.assistant("The test failed. I have not fixed the bug or rerun the suite.");
            history.user("Keep investigating; do not infer that the failure was fixed. " +
                "Review the query planner before changing implementation. ".repeat(75));
            history.assistant("I will inspect the planner next.");
            return history.prepare();
        },
        checks: [
            {id: "tail-evidence", description: "Known stock blind spot: exact failure evidence after the 2,000-character tool-result cut.",
                required: [["QUERY-482"], ["src/query/Plan.ts"], ["ORDER BY"]]},
        ],
        reviewQuestions: [
            "Does the checkpoint retain the failure evidence, rather than merely saying a test failed?",
            "Does it avoid claiming a fix or successful rerun?",
        ],
    },
    {
        id: "whole-history",
        prepare() {
            const history = new FixtureHistory();
            history.user("Implement pagination in src/api/items.ts. Preserve the public JSON field next_cursor. " +
                "Do not edit migrations/2026_10_01.sql. Never log access tokens.");
            history.assistant("Decision: use an opaque cursor, not an offset. The cursor includes created_at and id.");
            history.tool("read", {path: "src/api/items.ts"}, "The existing endpoint returns all items.");
            history.tool("edit", {path: "src/api/items.ts", edits: [{oldText: "allItems()", newText: "pageItems()"}]},
                "Successfully updated the endpoint.");
            history.user("The default limit must be 25 and the maximum 100.");
            history.assistant("Pagination implemented, but verification is incomplete. Empty-result and invalid-cursor tests remain.");
            history.tool("bash", {command: "npm test -- items"},
                "PASS: pagination ordering. FAIL: invalid cursor returns 500 instead of 400. No full-suite run was performed.");
            history.assistant("The invalid-cursor 500 is an open bug: return 400. Do not claim all tests passed.");
            history.user("Continue fixing that bug; don't change the cursor format. " +
                "The current decoder needs investigation. ".repeat(90));
            history.assistant("I will inspect the decoder before making changes.");
            return history.prepare();
        },
        checks: [
            {id: "api-contract", description: "Keep the exact public cursor field and implementation path.",
                required: [["next_cursor"], ["src/api/items.ts"]]},
            {id: "protected-migration", description: "Retain the exact protected migration path.",
                required: [["migrations/2026_10_01.sql"]]},
            {id: "limits", description: "Retain the default and maximum page limits.", required: [["25"], ["100"]]},
            {id: "open-failure", description: "Retain the unresolved invalid-cursor status bug.",
                required: [["invalid-cursor", "invalid cursor"], ["400"], ["500"]]},
        ],
        reviewQuestions: [
            "Is the migration explicitly protected from modification, rather than merely listed?",
            "Is opaque-cursor pagination still the chosen design, with offset pagination rejected?",
            "Are the invalid-cursor bug and missing tests distinguished from completed work?",
            "Does the checkpoint preserve the prohibition against logging access tokens?",
        ],
    },
    {
        id: "split-request",
        prepare() {
            const history = new FixtureHistory();
            history.user("First inspect the worker shutdown design in src/worker/Shutdown.ts.");
            history.assistant("Decision: graceful shutdown must drain accepted requests before closing sockets.");
            history.user("Now implement that design. Preserve SIGTERM handling and a 5-second deadline. " +
                "Keep compatibility with the existing stop() method; don't add a new public API.");
            history.tool("read", {path: "src/worker/Shutdown.ts"}, "The old shutdown closes sockets immediately.");
            history.assistant("Found race SHUTDOWN-218: an accepted request can be dropped during drain. " +
                "Need to capture the request count before closing listeners.");
            history.tool("edit", {path: "src/worker/Shutdown.ts", edits: [{oldText: "close()", newText: "drainThenClose()"}]},
                "Shutdown implementation changed.");
            history.assistant("The change is written, but the concurrent-request regression test is not run. " +
                "Implementation inspection continues. ".repeat(100));
            history.assistant("I am about to run the targeted shutdown tests. " + "Check deadline cancellation semantics. ".repeat(95));
            return history.prepare();
        },
        checks: [
            {id: "old-design", description: "Carry earlier history into the split-turn checkpoint.",
                required: [["drain"], ["socket"]]},
            {id: "request-contract", description: "Retain signal, deadline and existing API.",
                required: [["SIGTERM"], ["5-second", "5 second", "5s"], ["stop()"]]},
            {id: "race-identity", description: "Retain the exact race identifier and implementation path.",
                required: [["SHUTDOWN-218"], ["src/worker/Shutdown.ts"]]},
        ],
        reviewQuestions: [
            "Does the summary distinguish the earlier design decision from the current implementation request?",
            "Does it preserve the instruction not to add a new public API?",
            "Does it avoid inventing results for tests that have not run?",
        ],
    },
    {
        id: "iterative-checkpoint",
        prepare() {
            const history = new FixtureHistory();
            history.user("Investigate retry logic in src/client/Retry.ts.");
            history.assistant("Initial investigation complete.");
            const retained = history.user("Continue from the retry investigation.");
            history.checkpoint(retained, "## Goal\nRepair src/client/Retry.ts.\n\n" +
                "## Constraints & Preferences\nNever retry non-idempotent POST requests. Preserve X-Request-ID.\n\n" +
                "## Progress\n### Done\n- Identified stale retry timer RETRY-73.\n### In Progress\n- Fix timer cleanup.\n\n" +
                "## Next Steps\n1. Fix timer cleanup.\n2. Run cancellation tests.");
            history.tool("read", {path: "src/client/Retry.ts"}, "retryTimer survives cancellation.");
            history.tool("edit", {path: "src/client/Retry.ts", edits: [{oldText: "cancelled = true", newText: "clearTimeout(retryTimer)"}]},
                "Timer cleanup updated.");
            history.assistant("RETRY-73 timer cleanup is fixed. Targeted cancellation tests passed. " +
                "The full suite was not run; real timeout integration remains unverified.");
            history.user("Before continuing, inspect timeout integration and preserve the earlier HTTP constraints. " +
                "Reviewing request lifecycle boundaries. ".repeat(100));
            history.assistant("I will inspect timeout integration next.");
            return history.prepare();
        },
        checks: [
            {id: "previous-constraints", description: "Carry previous-checkpoint HTTP constraints forward.",
                required: [["non-idempotent", "nonidempotent"], ["POST"], ["X-Request-ID"]]},
            {id: "timer-fix", description: "Retain the exact issue identifier and source path.",
                required: [["RETRY-73"], ["src/client/Retry.ts"]]},
            {id: "targeted-tests", description: "Retain the targeted cancellation-test result.",
                required: [["cancellation"], ["passed", "pass"]]},
        ],
        reviewQuestions: [
            "Is timer cleanup now done rather than still the next implementation step?",
            "Is the non-idempotent POST restriction explicitly preserved?",
            "Does the summary distinguish passing targeted tests from unverified timeout integration/full-suite coverage?",
        ],
    },
];

class FixtureHistory {
    private readonly entries: SessionEntry[] = [];

    user(content: string): string {
        return this.add({type: "message", message: {role: "user", content, timestamp: this.entries.length * 1000}});
    }

    assistant(text: string): string {
        return this.add({type: "message", message: this.assistantMessage([{type: "text", text}])});
    }

    tool(name: string, arguments_: JsonObject, result: string): void {
        const callId = `call-${this.entries.length}`;
        this.add({type: "message", message: this.assistantMessage([{type: "toolCall", id: callId, name, arguments: arguments_}])});
        this.add({type: "message", message: {
            role: "toolResult", toolCallId: callId, toolName: name,
            content: [{type: "text", text: result}], isError: false, timestamp: this.entries.length * 1000,
        }});
    }

    checkpoint(firstKeptEntryId: string, summary: string): void {
        this.add({type: "compaction", firstKeptEntryId, summary, tokensBefore: 2000,
            details: {readFiles: [], modifiedFiles: []}});
    }

    async prepare(): Promise<CompactionPreparation> {
        // Preparation is not a public standalone export. Capture the public event, cancelling before any model call.
        const cwd = os.tmpdir();
        const settingsManager = SettingsManager.inMemory({compaction: {keepRecentTokens: 550}});
        let preparation: CompactionPreparation | undefined;
        const resourceLoader = new DefaultResourceLoader({
            cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
            noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Synthetic fixture",
            extensionFactories: [(pi) => {
                pi.on("session_before_compact", (event) => {
                    preparation = event.preparation;
                    return {cancel: true};
                });
            }],
        });
        await resourceLoader.reload();
        const modelRuntime = await ModelRuntime.create({
            credentials: {
                async read() { return undefined; },
                async list() { return []; },
                async modify() { throw new Error("Unexpected fixture credential mutation"); },
                async delete() { throw new Error("Unexpected fixture credential deletion"); },
            },
            modelsPath: null, refreshOnCreate: false,
        });
        const sessionManager = SessionManager.inMemory(cwd, undefined, [
            {type: "session", version: 3, id: "synthetic-compaction-fixture", cwd, timestamp: new Date(0).toISOString()},
            ...this.entries,
        ]);
        const {session} = await createAgentSession({
            cwd, agentDir: cwd, modelRuntime, settingsManager, sessionManager, resourceLoader, noTools: "all",
            model: {id: "fixture", name: "Fixture preparation only", provider: "fixture", api: "openai-responses",
                baseUrl: "https://offline.invalid", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192,
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
        if (!preparation) throw new Error("Synthetic fixture did not produce compactable history");
        return preparation;
    }

    private assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
        return {role: "assistant", content, api: "openai-responses", provider: "fixture", model: "fixture",
            usage: emptyUsage, stopReason: "stop", timestamp: this.entries.length * 1000};
    }

    private add(entry: EntryPayload): string {
        const id = `fixture-${this.entries.length.toString().padStart(4, "0")}`;
        this.entries.push({...entry, id, parentId: this.entries.at(-1)?.id ?? null,
            timestamp: new Date(this.entries.length * 1000).toISOString()});
        return id;
    }
}

type EntryPayload = SessionEntry extends infer Entry
    ? Entry extends SessionEntry ? Omit<Entry, "id" | "parentId" | "timestamp"> : never : never;
