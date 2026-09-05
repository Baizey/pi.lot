import assert from "node:assert/strict";
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
import {displayWidth} from "../src/tui/terminalText.js";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
const STATUS_KEY = "pi.lot-thinking";

initTheme("dark");

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
        assert.equal(stripVTControlCharacters(status), `Thinking ${bar} ${level}`);
        assert.ok(status.includes(harness.theme.fg(color, level)));
        const filled = bar.replaceAll("□", "");
        if (filled) assert.ok(status.includes(harness.theme.fg(color, filled)));
        const empty = bar.replaceAll("■", "");
        if (empty) assert.ok(status.includes(harness.theme.fg(ThemeColor.thinkingOff, empty)));
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
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking □□□□□ off");
    harness.reasoning = true;
    harness.hasModel = false;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking □□□□□ off");
    harness.hasModel = true;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking ■■■■■ xhigh");
    harness.level = undefined;
    runtime.update();
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking □□□□□ off");
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
    assert.equal(stripVTControlCharacters(harness.status()), "Thinking ■■□□□ low");
    const updates = harness.statusWrites;
    harness.level = "high";
    oldEditor.invalidate();
    oldEditor.render(80);
    assert.equal(harness.statusWrites, updates, "a previous session's editor stays detached after restart");
    runtime.stopSession();
});

test("native footer retains all its information except the redundant thinking suffix", () => {
    const harness = new UiHarness();
    const footer = nativeFooter(harness);
    const originalRender = footer.render;
    const container = new Container();
    container.addChild(footer);
    harness.children.push(container);
    harness.statuses.set("other", "other status • low");
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);

    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        harness.level = level;
        runtime.update();
        const before = originalRender.call(footer, 180);
        const after = footer.render(180);
        const suffix = ` • ${level === "off" ? "thinking off" : level}`;
        const label = `(${harness.provider}) ${harness.modelId}`;
        assert.equal(after[1], before[1]!.replace(label + suffix, " ".repeat(suffix.length) + label));
        assert.equal(after[0], before[0]);
        assert.deepEqual(after.slice(2), before.slice(2));
        const plain = stripVTControlCharacters(after[1]!);
        assert.ok(plain.includes("CH80.0%"));
        assert.ok(plain.includes("$1.500 (sub)"));
        assert.ok(plain.includes("74.4%/272k (auto)"));
        assert.ok(plain.endsWith(harness.modelId));
        assert.equal(displayWidth(after[1]!), displayWidth(before[1]!));
    }
    runtime.stopSession();
    assert.equal(footer.render, originalRender);
});

test("native footer removes partially clipped thinking suffixes without disturbing narrow layouts", () => {
    const harness = new UiHarness();
    const footer = nativeFooter(harness);
    const originalRender = footer.render;
    harness.children.push(footer);
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);

    for (const level of ["off", "low", "xhigh"] as const) {
        harness.level = level;
        for (let width = 8; width <= 160; width++) {
            const before = originalRender.call(footer, width);
            const after = footer.render(width);
            const plain = stripVTControlCharacters(after[1]!);
            assert.ok(after.every((line) => displayWidth(line) <= width));
            assert.equal(displayWidth(after[1]!), displayWidth(before[1]!));
            if (stripVTControlCharacters(before[1]!).includes(harness.modelId)) {
                assert.ok(plain.endsWith(harness.modelId), `no clipped suffix remains at width ${width}`);
            } else {
                assert.equal(after[1], before[1]);
            }
        }
    }
    harness.reasoning = false;
    assert.deepEqual(footer.render(180), originalRender.call(footer, 180));
    runtime.stopSession();
});

test("footer decoration preserves model names containing a thinking level and detaches safely", () => {
    const harness = new UiHarness();
    harness.modelId = "low";
    harness.level = "low";
    const footer = nativeFooter(harness);
    const originalRender = footer.render;
    harness.children.push(footer);
    const runtime = new ThinkingLevelUiRuntime();
    runtime.startSession(harness.context);
    assert.ok(stripVTControlCharacters(footer.render(180)[1]!).endsWith("(example) low"));
    const decorated = footer.render;
    const later = (width: number) => decorated(width);
    footer.render = later;
    runtime.stopSession();
    assert.equal(footer.render, later);
    assert.deepEqual(footer.render(180), originalRender.call(footer, 180));
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
            ui: {
                get theme() { return harness.theme; },
                getEditorComponent: () => this.factory,
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
