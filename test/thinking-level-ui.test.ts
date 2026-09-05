import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";
import {
    CustomEditor,
    FooterComponent,
    getSelectListTheme,
    initTheme,
    type ExtensionContext,
    type ExtensionUIContext,
    type KeybindingsManager,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {Container, type Component, type EditorComponent, type EditorTheme, type TUI} from "@earendil-works/pi-tui";
import {ThemeColor} from "../src/tui/Color.js";
import {ThinkingLevelUiRuntime} from "../src/tui/ThinkingLevelUiRuntime.js";
import {NativeFooterAutoCompaction} from "../src/tui/NativeFooterAutoCompaction.js";
import {displayWidth} from "../src/tui/terminalText.js";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
type Footer = ReturnType<FooterFactory>;
const STATUS_KEY = "pi.lot-thinking";

initTheme("dark");

test("bundled theme defines seven distinct thinking colors, with an explicit max color", () => {
    const theme = JSON.parse(readFileSync(new URL("../themes/pilot-dark.json", import.meta.url), "utf8")) as {
        colors: Record<string, string>;
    };
    const tokens = [
        "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
        "thinkingHigh", "thinkingXhigh", "thinkingMax",
    ] as const;
    for (const token of tokens) assert.match(theme.colors[token] ?? "", /^#[0-9a-f]{6}$/i, token);
    assert.equal(new Set(tokens.map((token) => theme.colors[token])).size, tokens.length);
});

test("thinking indicator fills discrete cubes and uses each active level's theme color", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const cases = [
        ["off", "□□□□□", ThemeColor.thinkingOff],
        ["minimal", "■□□□□", ThemeColor.thinkingMinimal],
        ["low", "■■□□□", ThemeColor.thinkingLow],
        ["medium", "■■■□□", ThemeColor.thinkingMedium],
        ["high", "■■■■□", ThemeColor.thinkingHigh],
        ["xhigh", "■■■■■", ThemeColor.thinkingXhigh],
        ["max", "■■■■■■", ThemeColor.thinkingMax],
    ] as const;

    for (const [level, bar, color] of cases) {
        harness.level = level;
        runtime.update();
        const status = harness.status();
        assert.equal(stripVTControlCharacters(status), `Thinking ${bar.padEnd(6)} ${level.padEnd(7)}`);
        assert.equal(displayWidth(status), 23);
        assert.ok(status.includes(harness.theme.fg(color, level)));
        const filled = bar.replaceAll("□", "");
        if (filled) assert.ok(status.includes(harness.theme.fg(color, filled)));
        const empty = bar.replaceAll("■", "");
        if (empty) assert.ok(status.includes(harness.theme.fg(ThemeColor.thinkingOff, empty)));
    }
    runtime.stopSession();
});

test("footer keeps thinking cubes and labels in fixed columns across every level and terminal width", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    for (let width = 0; width <= 120; width++) {
        let expectedColumns: number[] | undefined;
        for (const level of levels) {
            harness.level = level;
            runtime.update();
            const row = harness.footer!.render(width)[0]!;
            const plain = stripVTControlCharacters(row);
            const cubes = plain.search(/[■□]/);
            const label = cubes < 0 ? -1 : plain.indexOf(level, cubes);
            const columns = [plain.indexOf("Thinking"), cubes, label];
            expectedColumns ??= columns;
            assert.deepEqual(columns, expectedColumns, `${level} stays aligned at width ${width}`);
            assert.ok(displayWidth(row) <= width);
            if (label >= 0) assert.equal(plain.slice(label), level.padEnd(7));
        }
    }
    runtime.stopSession();
});

test("another loaded copy cannot undo footer padding by overwriting the shared thinking status", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        harness.level = level;
        runtime.update();
        const expected = harness.footer!.render(80)[0];
        // Older installed pi.lot copies use the same key with an unpadded label.
        const unpadded = stripVTControlCharacters(harness.status()).replace(/ +/g, " ").trim();
        harness.statuses.set(STATUS_KEY, unpadded);
        harness.editor!.render(80);
        assert.equal(harness.footer!.render(80)[0], expected, `${level} ignores the legacy status overwrite`);
        harness.statuses.delete(STATUS_KEY);
        assert.equal(harness.footer!.render(80)[0], expected, `${level} survives the other copy clearing its status`);
    }
    runtime.stopSession();
});

test("model changes to non-reasoning or no model show thinking off", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    harness.level = "xhigh";
    harness.reasoning = false;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking □□□□□  off".padEnd(23));
    harness.reasoning = true;
    harness.hasModel = false;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking □□□□□  off".padEnd(23));
    harness.hasModel = true;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking ■■■■■  xhigh".padEnd(23));
    harness.level = undefined;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking □□□□□  off".padEnd(23));
    runtime.stopSession();
});

test("chat borders stay xhigh across thinking changes while Bash mode remains distinct", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const editor = harness.editor!;
    assert.ok(editor instanceof CustomEditor);
    assert.equal(editor.embedWorkingStatus, true);
    const originalBorder = (text: string) => text;
    editor.borderColor = originalBorder;

    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        harness.level = level;
        editor.setText("Discuss the implementation");
        const lines = editor.render(80);
        assertBorder(lines, harness.theme, ThemeColor.thinkingXhigh);
        assert.equal(editor.borderColor, originalBorder);
    }
    for (const text of ["!pwd", "  !!pwd"]) {
        editor.setText(text);
        assertBorder(editor.render(80), harness.theme, ThemeColor.bashMode);
    }
    editor.setText("Back to chat");
    assertBorder(editor.render(80), harness.theme, ThemeColor.thinkingXhigh);
    runtime.stopSession();
});

test("editor invalidation refreshes theme colors without changing the level or looping renders", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const before = harness.status();
    harness.theme = testTheme(60);
    harness.editor!.invalidate();
    assert.notEqual(harness.status(), before);
    assert.ok(harness.status().includes(harness.theme.fg(ThemeColor.thinkingMedium, "■■■")));
    assertBorder(harness.editor!.render(80), harness.theme, ThemeColor.thinkingXhigh);
    const updates = harness.statusWrites;
    for (let index = 0; index < 5; index++) {
        harness.editor!.invalidate();
        harness.editor!.render(80);
        runtime.update();
    }
    assert.equal(harness.statusWrites, updates);
    runtime.stopSession();
});

test("existing custom editor behavior and unrelated footer statuses are preserved", () => {
    const harness = new UiHarness();
    let previousEditor: CustomEditor | undefined;
    const previous: EditorFactory = (tui, theme, keybindings) => {
        previousEditor = new CustomEditor(tui, theme, keybindings);
        return previousEditor;
    };
    harness.factory = previous;
    harness.statuses.set("pi.lot-subagents", "agents ●2");
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    assert.equal(harness.editor, previousEditor);
    harness.editor!.handleInput("a");
    assert.equal(harness.editor!.getText(), "a");
    let interrupted = false;
    previousEditor!.onEscape = () => interrupted = true;
    // The original object still owns all callbacks and app actions.
    previousEditor!.onEscape();
    assert.equal(interrupted, true);
    assert.equal(harness.statuses.get("pi.lot-subagents"), "agents ●2");

    const oldEditor = harness.editor!;
    runtime.stopSession();
    assert.equal(harness.factory, previous);
    assert.equal(harness.statuses.has(STATUS_KEY), false);
    assert.equal(harness.statuses.get("pi.lot-subagents"), "agents ●2");
    const updates = harness.statusWrites;
    oldEditor.invalidate();
    oldEditor.render(80);
    runtime.update();
    runtime.stopSession();
    assert.equal(harness.statusWrites, updates);
});

test("shutdown does not overwrite an editor installed later by another extension", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const later: EditorFactory = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
    harness.factory = later;
    runtime.stopSession();
    assert.equal(harness.factory, later);
});

test("thinking UI does not install terminal components or statuses outside TUI mode", () => {
    for (const mode of ["rpc", "json", "print"] as const) {
        const harness = new UiHarness(mode);
        const runtime = new ThinkingLevelUiRuntime();
        runtime.startSession(harness.context);
        runtime.update();
        runtime.stopSession();
        assert.equal(harness.factory, undefined);
        assert.equal(harness.footer, undefined);
        assert.equal(harness.branchListeners.size, 0);
        assert.equal(harness.statusWrites, 0);
    }
});

test("thinking UI can restart cleanly and preserves the editor's terminal width contract", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    assert.throws(() => runtime.startSession(harness.context), /already started/);
    harness.editor!.setText("Unicode 界🙂 e\u0301");
    for (const width of [8, 20, 40, 80]) {
        assert.ok(harness.editor!.render(width).every((line) => displayWidth(line) <= width));
    }
    const oldEditor = harness.editor!;
    runtime.stopSession();
    assert.equal(harness.factory, undefined);
    harness.level = "low";
    runtime.startSession(harness.context);
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking ■■□□□  low".padEnd(23));
    const updates = harness.statusWrites;
    harness.level = "high";
    oldEditor.invalidate();
    oldEditor.render(80);
    assert.equal(harness.statusWrites, updates, "a previous session's editor stays detached after restart");
    runtime.stopSession();
});

test("structured footer groups model and thinking, preserves statuses, and restores the native footer", () => {
    const harness = new UiHarness();
    const native = nativeFooter(harness);
    const originalRender = native.render;
    const originalSetter = native.setAutoCompactEnabled;
    const container = new Container();
    container.addChild(native);
    harness.children.push(container);
    harness.statuses.set("other", "other status • low");
    harness.statuses.set("pi.lot-subagents", "agents ●2");
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const footer = harness.footer!;
    const lines = footer.render(180).map(stripVTControlCharacters);
    assert.equal(lines.length, 3);
    assert.ok(lines[0]!.includes("example/test-model-low"));
    assert.ok(lines[0]!.endsWith("Thinking ■■■□□  medium".padEnd(23)));
    assert.ok(lines[1]!.includes("(auto)"));
    assert.ok(lines[1]!.endsWith("agents ●2 · test session"));
    assert.equal(lines[2], "other status • low");
    assert.ok(lines.every((line) => !line.includes("/tmp/pilot")));
    assert.equal(harness.branchListeners.size, 0);
    assert.equal(native.render, originalRender, "native rendered output is no longer patched");
    native.setAutoCompactEnabled(false);
    assert.ok(!stripVTControlCharacters(footer.render(180)[1]!).includes("(auto)"));
    native.setAutoCompactEnabled(true);
    assert.ok(stripVTControlCharacters(footer.render(180)[1]!).includes("(auto)"));
    runtime.stopSession();
    assert.equal(harness.footer, undefined);
    assert.equal(native.setAutoCompactEnabled, originalSetter);
    assert.equal(harness.branchListeners.size, 0);
});

test("shutdown leaves a later custom footer in place", () => {
    const harness = new UiHarness();
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    const later: Footer = {render: () => ["later footer"], invalidate() {}};
    harness.context.ui.setFooter(() => later);
    assert.equal(harness.branchListeners.size, 0);
    runtime.stopSession();
    assert.equal(harness.footer, later);
});

test("auto-compaction adapter reads disabled initial state and detaches without clobbering later decorators", () => {
    const harness = new UiHarness();
    harness.modelId = "model (auto)";
    const native = nativeFooter(harness);
    native.setAutoCompactEnabled(false);
    harness.children.push(native);
    const adapter = new NativeFooterAutoCompaction();
    adapter.attach(harness);
    assert.equal(adapter.getEnabled(), false);
    const decorated = native.setAutoCompactEnabled;
    const later = (enabled: boolean) => decorated(enabled);
    native.setAutoCompactEnabled = later;
    adapter.dispose();
    native.setAutoCompactEnabled(true);
    assert.equal(native.setAutoCompactEnabled, later);
    assert.equal(adapter.getEnabled(), false, "disposed adapter does not receive later updates");
    assert.ok(stripVTControlCharacters(native.render(180)[1]!).includes("74.4%/272k (auto)"));
    adapter.attach(harness);
    assert.equal(native.setAutoCompactEnabled, later);
});

function nativeFooter(harness: UiHarness): FooterComponent {
    const usage = {
        input: 1_000, output: 200, cacheRead: 4_000, cacheWrite: 0, totalTokens: 5_200,
        cost: {input: 0.5, output: 0.5, cacheRead: 0.5, cacheWrite: 0, total: 1.5},
    };
    const session = {
        get state() { return {model: harness.context.model, thinkingLevel: harness.level}; },
        sessionManager: {
            getEntries: () => [{type: "message", message: {role: "assistant", usage}}],
            getCwd: () => "/tmp/pilot",
            getSessionName: () => "session • low",
        },
        getContextUsage: () => ({contextWindow: 272_000, percent: 74.4}),
        modelRuntime: {isUsingSubscription: () => true},
    } as unknown as ConstructorParameters<typeof FooterComponent>[0];
    const data = {
        getGitBranch: () => "main",
        getAvailableProviderCount: () => 2,
        getExtensionStatuses: () => harness.statuses,
        onBranchChange: () => () => {},
    } satisfies ConstructorParameters<typeof FooterComponent>[1];
    return new FooterComponent(session, data);
}

class UiHarness {
    level: ExtensionContext["thinkingLevel"] = "medium";
    reasoning = true;
    hasModel = true;
    modelId = "test-model-low";
    provider = "example";
    readonly children: Component[] = [];
    theme = testTheme();
    factory: EditorFactory | undefined;
    editor: EditorComponent | undefined;
    footer: Footer | undefined;
    readonly branchListeners = new Set<() => void>();
    readonly statuses = new Map<string, string>();
    statusWrites = 0;
    readonly context: ExtensionContext;

    constructor(mode: ExtensionContext["mode"] = "tui") {
        const harness = this;
        this.context = {
            mode,
            hasUI: mode === "tui" || mode === "rpc",
            get model() {
                return harness.hasModel
                    ? {id: harness.modelId, provider: harness.provider, reasoning: harness.reasoning}
                    : undefined;
            },
            get thinkingLevel() { return harness.level; },
            sessionManager: {
                getEntries: () => [],
                getCwd: () => "/tmp/pilot",
                getSessionName: () => "test session",
            },
            getContextUsage: () => ({contextWindow: 272_000, percent: 74.4, tokens: 202_368}),
            modelRegistry: {
                isUsingOAuth: () => false,
            },
            ui: {
                get theme() { return harness.theme; },
                getEditorComponent: () => this.factory,
                setFooter: (factory: FooterFactory | undefined) => {
                    this.footer?.dispose?.();
                    this.footer = factory?.({requestRender() {}} as TUI, this.theme, {
                        getGitBranch: () => "main",
                        getAvailableProviderCount: () => 2,
                        getExtensionStatuses: () => this.statuses,
                        onBranchChange: (callback) => {
                            this.branchListeners.add(callback);
                            return () => { this.branchListeners.delete(callback); };
                        },
                    });
                },
                setEditorComponent: (factory: EditorFactory | undefined) => {
                    this.factory = factory;
                    const tui = {
                        children: this.children,
                        terminal: {rows: 24, columns: 80},
                        requestRender() {},
                    } as unknown as TUI;
                    const editorTheme: EditorTheme = {
                        borderColor: (text) => text,
                        selectList: getSelectListTheme(),
                    };
                    const keybindings = {matches: () => false} as unknown as KeybindingsManager;
                    this.editor = factory?.(tui, editorTheme, keybindings);
                },
                setStatus: (key: string, value: string | undefined) => {
                    this.statusWrites++;
                    if (value === undefined) this.statuses.delete(key);
                    else this.statuses.set(key, value);
                },
            },
        } as unknown as ExtensionContext;
    }

    status(): string {
        const value = this.statuses.get(STATUS_KEY);
        assert.ok(value);
        return value;
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

function assertBorder(lines: string[], theme: Theme, color: ThemeColor): void {
    const prefix = theme.fg(color, "marker").split("marker")[0]!;
    assert.ok(lines[0]?.includes(`${prefix}─`), "top border uses the expected color");
    assert.ok(lines.at(-1)?.includes(`${prefix}─`), "bottom border uses the expected color");
}
