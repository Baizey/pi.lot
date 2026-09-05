import assert from "node:assert/strict";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";
import type {Usage} from "@earendil-works/pi-ai";
import {
    initTheme,
    type ContextUsage,
    type ExtensionContext,
    type ReadonlyFooterDataProvider,
    type SessionEntry,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {PilotFooter} from "../src/tui/PilotFooter.js";
import {ThemeColor} from "../src/tui/Color.js";
import {displayWidth} from "../src/tui/terminalText.js";

initTheme("dark");

const MODEL_ROW = 0;
const USAGE_ROW = 1;
const STATUS_ROW = 2;

test("two-row footer groups model/thinking and usage/agents/session without reading cwd or branch", () => {
    const harness = new FooterHarness();
    const lines = harness.plain(200);
    assert.equal(lines.length, 2);
    assert.ok(lines[MODEL_ROW]!.startsWith("example/test-model"));
    assert.ok(lines[MODEL_ROW]!.endsWith("Thinking ■■■■□  high".padEnd(23)));
    assert.match(lines[USAGE_ROW]!, /Context 74\.4%\s*\/\s*272k \(auto\)/);
    assert.ok(lines[USAGE_ROW]!.endsWith("agents ●2 ○1 · footer design"));
    assert.equal(displayWidth(lines[USAGE_ROW]!), 200, "session name is right-aligned");
    harness.footer.dispose();
});

test("footer accounts for all session usage, including tools and both summary types", () => {
    const harness = new FooterHarness();
    const row = harness.plain(200)[USAGE_ROW]!;
    for (const expected of [/↑4\.0k/, /↓800/, /R16k/, /CH80\.0%/, /\$6\.000/]) {
        assert.match(row, expected);
    }
    harness.entries.push(assistantEntry(usage(500, 200, 0, 0, 0.25)));
    assert.match(harness.plain(200)[USAGE_ROW]!, /\$6\.250/);
    assert.match(harness.plain(200)[USAGE_ROW]!, /CH0\.0%/);
    harness.footer.dispose();
});

test("cache writes and latest assistant hit rate are distinct from cumulative usage", () => {
    const harness = new FooterHarness();
    harness.entries.push(assistantEntry(usage(1_000, 100, 2_000, 1_000, 0)));
    assert.match(harness.plain(200)[USAGE_ROW]!, /W1\.0k/);
    assert.match(harness.plain(200)[USAGE_ROW]!, /CH50\.0%/);
    harness.entries.push(assistantEntry(usage(0, 0, 0, 0, 0)));
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /CH/);
    harness.footer.dispose();
});

test("subscription label matches native provider billing semantics", () => {
    const harness = new FooterHarness();
    harness.entries.length = 0;
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /\(sub\)/);
    harness.oauth = true;
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /\(sub\)/, "OAuth alone is not subscription billing");
    harness.subscription = true;
    assert.match(harness.plain(200)[USAGE_ROW]!, /\$0\.000 \(sub\)/);
    harness.oauth = false;
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /\(sub\)/);
    harness.provider = "kimi-coding";
    assert.match(harness.plain(200)[USAGE_ROW]!, /\$0\.000 \(sub\)/);
    harness.footer.dispose();
});

test("context uses thinking color bands with max at 90% and above, including overflow", () => {
    const harness = new FooterHarness();
    const cases = [
        [0, "thinkingMinimal"], [19.9, "thinkingMinimal"],
        [20, "thinkingLow"], [39.9, "thinkingLow"],
        [40, "thinkingMedium"], [59.9, "thinkingMedium"],
        [60, "thinkingHigh"], [79.9, "thinkingHigh"],
        [80, "thinkingXhigh"], [89.9, "thinkingXhigh"],
        [90, "thinkingMax"], [100, "thinkingMax"], [125.5, "thinkingMax"], [200, "thinkingMax"],
    ] as const;
    for (const [percent, color] of cases) {
        harness.contextUsage = {tokens: 1, contextWindow: 272_000, percent};
        const row = harness.footer.render(200)[USAGE_ROW]!;
        const coloredContext = harness.theme.fg(color, `${percent.toFixed(1)}% / 272k (auto)`);
        assert.ok(row.includes(coloredContext), `context ${percent} uses ${color}`);
        const compactRow = harness.footer.render(22)[USAGE_ROW]!;
        assert.ok(compactRow.includes(harness.theme.fg(color, `${percent.toFixed(1)}%`)),
            `compact context ${percent} retains its color and uncapped value`);
    }
    harness.footer.dispose();
});

test("unknown post-compaction usage uses thinkingOff and preserves the unknown value", () => {
    const harness = new FooterHarness();
    harness.contextUsage = {tokens: null, contextWindow: 272_000, percent: null};
    assert.ok(harness.footer.render(200)[USAGE_ROW]!.includes(harness.theme.fg("thinkingOff", "? / 272k (auto)")));
    assert.match(harness.plain(200)[USAGE_ROW]!, /\?\s*\/\s*272k/);
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /Context 0\.0%/);
    harness.auto = false;
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /\(auto\)/);
    harness.auto = undefined;
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /\(auto\)/);
    harness.contextUsage = undefined;
    harness.hasModel = false;
    assert.ok(harness.plain(200)[MODEL_ROW]!.includes("no-model"));
    harness.footer.dispose();
});

test("responsive layout bounds Unicode widths and keeps context and agents ahead of long session names", () => {
    const harness = new FooterHarness();
    assert.match(harness.plain(200)[USAGE_ROW]!, /CH/);
    const medium = harness.plain(70);
    assert.doesNotMatch(medium[USAGE_ROW]!, /CH/);
    assert.match(medium[MODEL_ROW]!, /test-model/);
    assert.match(medium[USAGE_ROW]!, /74\.4%/);
    assert.match(medium[USAGE_ROW]!, /●2/);
    assert.ok(medium[USAGE_ROW]!.endsWith("footer design"));
    assert.match(harness.plain(25)[USAGE_ROW]!, /74\.4%/, "compact context retains the percentage");
    harness.name = "session e\u0301 界🙂 ".repeat(40);
    harness.modelId = "model-界🙂";
    harness.statuses.set("other", "\x1b[32mexternal 界🙂 e\u0301\x1b[0m");
    for (let width = 0; width <= 200; width++) {
        const lines = harness.footer.render(width);
        assert.ok(lines.every((line) => displayWidth(line) <= width), `bounded at ${width}`);
        assert.ok(lines.every((line) => !/[\r\n\t]/.test(line)));
    }
    const longNameRow = harness.plain(80)[USAGE_ROW]!;
    assert.match(longNameRow, /74\.4%/);
    assert.match(longNameRow, /agents ●2 ○1 · session/);
    assert.ok(longNameRow.endsWith("…"));
    harness.footer.dispose();
});

test("absent session names and agent counts do not leave empty separators or extra rows", () => {
    const harness = new FooterHarness();
    harness.statuses.delete("pi.lot-subagents");
    assert.ok(harness.plain(80)[USAGE_ROW]!.endsWith("footer design"));
    harness.name = undefined;
    const unnamed = harness.plain(200);
    assert.equal(unnamed.length, 2);
    assert.doesNotMatch(unnamed[USAGE_ROW]!, /footer design|undefined|null|·\s*$/);
    harness.statuses.set("pi.lot-subagents", "agents ●2");
    assert.ok(harness.plain(200)[USAGE_ROW]!.endsWith("agents ●2"));
    harness.footer.dispose();
});

test("other extension statuses remain separate and session names are sanitized", () => {
    const harness = new FooterHarness();
    harness.statuses.set("z-last", "last\nstatus");
    harness.statuses.set("a-first", "\x1b[32mfirst\x1b[0m\x1b[2J");
    const lines = harness.plain(200);
    assert.equal(lines.length, 3);
    assert.equal(lines[STATUS_ROW], "first · last status");
    assert.doesNotMatch(harness.footer.render(200)[STATUS_ROW]!, /\x1b\[2J/);
    assert.doesNotMatch(lines[STATUS_ROW]!, /Thinking|agents|footer design/);
    harness.statuses.delete("pi.lot-subagents");
    assert.doesNotMatch(harness.plain(200)[USAGE_ROW]!, /agents/);
    harness.name = "\x1b[31msession\x1b[0m\nname\x1b[2J";
    const row = harness.footer.render(200)[USAGE_ROW]!;
    assert.doesNotMatch(row, /\x1b\[31m|\x1b\[2J|\n/);
    assert.ok(stripVTControlCharacters(row).endsWith("session name"));
    harness.footer.dispose();
});

test("theme, model, and session name update without cached display data; disposal is idempotent", () => {
    const harness = new FooterHarness();
    const before = harness.footer.render(200);
    harness.theme = testTheme(100);
    harness.name = "renamed";
    harness.modelId = "new-model";
    harness.footer.invalidate();
    const after = harness.footer.render(200);
    assert.notDeepEqual(after, before);
    assert.ok(stripVTControlCharacters(after[USAGE_ROW]!).endsWith("renamed"));
    assert.match(stripVTControlCharacters(after[MODEL_ROW]!), /new-model/);
    harness.footer.dispose();
    harness.footer.dispose();
    assert.equal(harness.footer.disposed, true);
});

class FooterHarness {
    name: string | undefined = "footer design";
    provider = "example";
    modelId = "test-model";
    hasModel = true;
    level: ExtensionContext["thinkingLevel"] = "high";
    oauth = false;
    subscription = false;
    auto: boolean | undefined = true;
    theme = testTheme();
    contextUsage: ContextUsage | undefined = {tokens: 202_368, contextWindow: 272_000, percent: 74.4};
    readonly statuses = new Map([
        ["pi.lot-thinking", "Thinking ■■■■□ high"],
        ["pi.lot-subagents", "agents ●2 ○1"],
    ]);
    readonly entries = sessionEntries();
    readonly footer: PilotFooter;

    constructor() {
        const harness = this;
        const context = {
            get model() {
                return harness.hasModel
                    ? {id: harness.modelId, provider: harness.provider, reasoning: true, contextWindow: 272_000}
                    : undefined;
            },
            get thinkingLevel() { return harness.level; },
            getContextUsage: () => this.contextUsage,
            sessionManager: {
                getEntries: () => this.entries,
                getBranch: () => { throw new Error("footer totals must include all entries, not just the active branch"); },
                getCwd: () => { throw new Error("footer no longer displays the cwd"); },
                getSessionName: () => this.name,
            },
            modelRegistry: {
                isUsingOAuth: () => this.oauth,
                getProvider: () => ({auth: {oauth: {isSubscription: this.subscription}}}),
            },
            ui: {get theme() { return harness.theme; }},
        } as unknown as ExtensionContext;
        const data: ReadonlyFooterDataProvider = {
            getGitBranch: () => { throw new Error("footer no longer displays the branch"); },
            getAvailableProviderCount: () => 2,
            getExtensionStatuses: () => this.statuses,
            onBranchChange: () => { throw new Error("footer must not subscribe to unused branch changes"); },
        };
        this.footer = new PilotFooter(context, data, () => this.auto);
    }

    plain(width: number): string[] {
        return this.footer.render(width).map(stripVTControlCharacters);
    }
}

function testTheme(offset = 0): Theme {
    return {
        fg(color: string, text: string) {
            const code = Object.values(ThemeColor).indexOf(color as ThemeColor) + offset;
            return `\x1b[38;5;${code}m${text}\x1b[39m`;
        },
    } as Theme;
}

function usage(input = 1_000, output = 200, cacheRead = 4_000, cacheWrite = 0, cost = 1.5): Usage {
    return {input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
        cost: {input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost}};
}

function assistantEntry(tokens: Usage): SessionEntry {
    return {
        id: "assistant", parentId: null, timestamp: new Date(0).toISOString(), type: "message",
        message: {role: "assistant", content: [], api: "openai-responses", provider: "example", model: "test-model",
            usage: tokens, stopReason: "stop", timestamp: 0},
    };
}

function sessionEntries(): SessionEntry[] {
    const base = {id: "entry", parentId: null, timestamp: new Date(0).toISOString()};
    return [
        assistantEntry(usage()),
        {...base, type: "message", message: {role: "toolResult", toolCallId: "tool", toolName: "child",
            content: [], details: {}, isError: false, timestamp: 0, usage: usage()}},
        {...base, type: "compaction", summary: "summary", firstKeptEntryId: "assistant", tokensBefore: 50_000, usage: usage()},
        {...base, type: "branch_summary", fromId: "branch", summary: "summary", usage: usage()},
        {...base, type: "message", message: {role: "user", content: "hello", timestamp: 0}},
        {...base, type: "compaction", summary: "unbilled", firstKeptEntryId: "assistant", tokensBefore: 50_000},
    ];
}
