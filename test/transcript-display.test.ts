import assert from "node:assert/strict";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";
import {
    AssistantMessageComponent,
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    initTheme,
    ToolExecutionComponent,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
    type ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import {Container, getCapabilities, Image, setCapabilities, Text, TuiAltScreen, TuiMainScreen, type Component, type Terminal, type TUI} from "@earendil-works/pi-tui";
import {ReadTool} from "../src/tools/builtin/ReadTool.js";
import {TranscriptDisplayRuntime} from "../src/tui/TranscriptDisplayRuntime.js";
import {ToolDisplayMode} from "../src/tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {displayWidth} from "../src/tui/terminalText.js";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=";
initTheme("dark");

test("hidden removes completed thoughts without blank rows, preserves conversation and native thinking preferences", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    for (const collapsed of [false, true]) {
        const source = assistant([{type: "thinking", thinking: "private completed thought", thinkingSignature: "signed"}]);
        const original = structuredClone(source);
        const component = new AssistantMessageComponent(source, collapsed);
        harness.root.addChild(component);
        assert.deepEqual(harness.root.render(80), []);
        component.invalidate();
        component.setOutputPad(2);
        assert.deepEqual(component.render(80), []);
        assert.deepEqual(source, original);
        harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
        assert.match(plain(component.render(80)), collapsed ? /Thinking\.\.\./ : /private completed thought/);
        harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
        assert.deepEqual(component.render(80), []);
        harness.root.removeChild(component);
        harness.root.render(80);
    }
    const source = assistant([
        {type: "thinking", thinking: "private mixed thought"},
        {type: "text", text: "The conversational answer."},
    ]);
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    assert.equal(plain(harness.root.render(80)).trim(), "The conversational answer.");
    assert.doesNotMatch(plain(component.render(80)), /private mixed thought/);
    assert.equal(source.content.length, 2);
});

test("hidden suppresses streaming thoughts as well as completed thoughts without changing the source", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const pending = assistant([{type: "thinking", thinking: "long private streaming thought"}], "pending");
    const original = structuredClone(pending);
    const component = new AssistantMessageComponent(pending, true);
    harness.root.addChild(component);
    assert.deepEqual(harness.root.render(80), [], "the working widget owns the transient busy indicator");
    const grown = assistant([{type: "thinking", thinking: "new private streaming thought"}], "pending");
    component.updateContent(grown, true);
    assert.deepEqual(component.render(80), []);
    const response = assistant([
        {type: "thinking", thinking: "completed private reasoning"},
        {type: "text", text: "Here is the answer."},
    ], "pending");
    component.updateContent(response, true);
    assert.equal(plain(component.render(80)).trim(), "Here is the answer.", "earlier thoughts disappear once speaking begins");
    component.updateContent({...response, stopReason: "stop"}, false);
    component.invalidate();
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
    component.setHideThinkingBlock(false);
    assert.match(plain(component.render(80)), /completed private reasoning/);
    assert.match(plain(component.render(80)), /Here is the answer/);
    assert.deepEqual(pending, original);
    assert.equal(grown.content[0]!.type, "thinking");
});

test("Conversation shows an animated working placeholder until tool headers can take over, including between batches", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const nativeRoot = new TestTui();
    const redraw = t.mock.method(nativeRoot, "requestRender");
    const harness = createHarness(nativeRoot);
    t.after(() => harness.close());
    const view = () => plain(nativeRoot.render(80));
    assert.equal(view(), "");
    harness.startWork();
    assert.match(view(), /Working…/);
    const initial = view();
    t.mock.timers.tick(80);
    assert.notEqual(view(), initial, "the placeholder uses the same animation as active tool headers");
    assert.ok(redraw.mock.callCount() > 0);

    const source = assistant([{type: "thinking", thinking: "private reasoning"}], "pending");
    const original = structuredClone(source);
    const thought = new AssistantMessageComponent(source);
    harness.root.addChild(thought);
    assert.equal(view().match(/Working…/g)?.length, 1);
    assert.doesNotMatch(view(), /Thinking|private reasoning/);
    assert.deepEqual(source, original);

    const first = harness.read("streaming-arguments");
    harness.root.addChild(first);
    assert.match(view(), /streaming-arguments/);
    assert.doesNotMatch(view(), /Working…/, "streamed tool headers replace the placeholder before execution begins");
    const second = harness.read("parallel-call");
    harness.root.addChild(second);
    first.updateResult({content: [], isError: false});
    assert.doesNotMatch(view(), /Working…/, "one completed sibling must not hide another active tool");
    second.updateResult({content: [{type: "text", text: "partial output"}], isError: false}, true);
    assert.doesNotMatch(view(), /Working…/);
    second.updateResult({content: [], isError: true});
    assert.match(view(), /Working…/, "failed or cancelled tools also give way to the next model request");

    thought.updateContent(assistant([{type: "text", text: "The final answer."}], "pending"), true);
    assert.match(view(), /The final answer/);
    assert.match(view(), /Working…/);
    harness.endWork();
    assert.doesNotMatch(view(), /Working…/);
    assert.match(view(), /The final answer/);
    const afterEnd = redraw.mock.callCount();
    t.mock.timers.tick(800);
    assert.equal(redraw.mock.callCount(), afterEnd, "ending or aborting a run stops the animation");
    assert.doesNotMatch(plain(harness.root.render(80)), /Working…/, "the placeholder is not added to transcript rows");
});

test("unavailable historical renderers do not suppress working, while current fallback tool headers still take over", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const nativeRoot = new TestTui();
    const harness = createHarness(nativeRoot);
    t.after(() => harness.close());
    const view = () => plain(nativeRoot.render(80));
    const historical = new ToolExecutionComponent("removed_tool", "historical", {}, {outputPad: 0}, undefined,
        nativeRoot, process.cwd());
    historical.updateResult({content: [], isError: false});
    harness.root.addChild(historical);
    nativeRoot.render(80);
    harness.startWork();
    assert.match(view(), /Working…/, "an unclassifiable historical row is not evidence of current tool work");

    const current = new ToolExecutionComponent("missing_tool", "current", {}, {outputPad: 0}, undefined,
        nativeRoot, process.cwd());
    harness.updateMessage(assistant([{type: "toolCall", id: "current", name: "missing_tool", arguments: {}}], "pending"));
    harness.root.addChild(current);
    assert.match(view(), /missing_tool/);
    assert.doesNotMatch(view(), /Working…/, "even fallback headers take over while arguments stream");
    harness.endMessage(assistant([{type: "toolCall", id: "current", name: "missing_tool", arguments: {}}], "toolUse"));
    harness.startTool("current");
    assert.doesNotMatch(view(), /Working…/);
    harness.startTool("parallel-call");
    current.updateResult({content: [], isError: true});
    harness.endTool("current");
    assert.doesNotMatch(view(), /Working…/, "unrendered parallel work is still active");
    harness.endTool("parallel-call");
    assert.match(view(), /Working…/);
    harness.startTool("dynamic-tool");
    assert.doesNotMatch(view(), /Working…/, "execution events also cover tools without a streamed header");
    harness.startTool("nested-call", "dynamic-tool");
    harness.endTool("dynamic-tool");
    assert.match(view(), /Working…/, "nested event IDs must not outlive the parent header");
    harness.endTool("nested-call", "dynamic-tool");
    harness.startTool("aborted-call");
    harness.endWork();
    assert.doesNotMatch(view(), /Working…/);
    harness.startWork();
    assert.match(view(), /Working…/, "aborting a run must clear unfinished event bookkeeping");
});

test("the working placeholder follows the global view, respects any active tool's local view, and cleans up", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const nativeRoot = new TestTui();
    const redraw = t.mock.method(nativeRoot, "requestRender");
    const harness = createHarness(nativeRoot);
    t.after(() => harness.close());
    const view = () => plain(nativeRoot.render(80));
    harness.startWork();
    assert.match(view(), /Working…/);
    for (const width of [0, 1, 3, 12, 80]) {
        assert.ok(nativeRoot.render(width).every((line) => displayWidth(line) <= width));
    }
    harness.expanded = true;
    assert.doesNotMatch(view(), /Working…/);
    const afterToggle = redraw.mock.callCount();
    t.mock.timers.tick(800);
    assert.equal(redraw.mock.callCount(), afterToggle, "leaving Conversation stops the placeholder timer");
    harness.rows.modes.setViews(ToolDisplayMode.FULL, ToolDisplayMode.HIDDEN);
    assert.match(view(), /Working…/, "Conversation also works in the alternate slot");
    const row = harness.read("locally-full");
    row.setExpanded(false);
    harness.root.addChild(row);
    assert.doesNotMatch(view(), /Working…/, "a locally expanded tool is still active");
    row.updateResult({content: [], isError: false});
    assert.match(view(), /Working…/);
    harness.rows.modes.setViews(ToolDisplayMode.FULL, ToolDisplayMode.MINIMAL);
    assert.doesNotMatch(view(), /Working…/);
    harness.rows.modes.setViews(ToolDisplayMode.FULL, ToolDisplayMode.HIDDEN);
    assert.match(view(), /Working…/);
    harness.runtime.stopSession();
    assert.doesNotMatch(view(), /Working…/);
    const afterStop = redraw.mock.callCount();
    t.mock.timers.tick(800);
    assert.equal(redraw.mock.callCount(), afterStop, "shutdown removes the widget and its timer");
    harness.runtime.stopSession();
    harness.runtime.startSession(harness.context);
    harness.runtime.attach(nativeRoot);
    assert.doesNotMatch(view(), /Working…/, "a subsequent session starts idle");
    harness.startWork();
    assert.match(view(), /Working…/);
    harness.endWork();
    assert.doesNotMatch(view(), /Working…/);
});

test("transcript display does not install a working widget outside a terminal UI", () => {
    for (const mode of ["rpc", "json", "print"] as const) {
        const harness = createHarness(new TestTui(), mode);
        harness.startWork();
        assert.equal(harness.widgetCount(), 0);
        harness.close();
    }
});

test("hidden suppresses completed native images and partial image output without changing conversation images or tool results", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const capabilities = getCapabilities();
    setCapabilities({...capabilities, images: "kitty"});
    t.after(() => setCapabilities(capabilities));
    const harness = createHarness();
    t.after(() => harness.close());
    const result = {content: [{type: "image", data: png, mimeType: "image/png"}], isError: false};
    const original = structuredClone(result);
    const completed = harness.read("completed-image");
    completed.updateResult(result);
    harness.root.addChild(completed);
    assert.deepEqual(harness.root.render(80), [], "historical image rows are classified through the public render context");
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
    assert.ok(completed.render(80).some((line) => line.includes("\x1b_G")), "leaving hidden restores the native image");
    harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    const active = harness.read("active-image");
    active.updateResult(result, true);
    harness.root.addChild(active);
    assert.match(plain(harness.root.render(80)), /read \| active-image/);
    assert.equal(harness.root.render(80).some((line) => line.includes("\x1b_G")), false);
    assert.equal(active.render(80).length, 2, "partial image spacers leave only the normal leading gap and active header");
    active.updateResult(result);
    assert.deepEqual(harness.root.render(80), []);
    const conversationImage = new Image(png, "image/png", {fallbackColor: (text) => text});
    harness.root.addChild(conversationImage);
    assert.ok(harness.root.render(80).some((line) => line.includes("\x1b_G")), "images outside tool rows stay visible");
    assert.deepEqual(result, original);
});

test("Conversation tool text and images follow native per-row mouse toggles on either global side", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const capabilities = getCapabilities();
    setCapabilities({...capabilities, images: "kitty"});
    t.after(() => setCapabilities(capabilities));
    for (const globalExpanded of [false, true]) {
        for (const globallyHidden of [false, true]) {
            const harness = createHarness();
            try {
                harness.expanded = globalExpanded;
                const normalHidden = globallyHidden !== globalExpanded;
                harness.rows.modes.setViews(
                    normalHidden ? ToolDisplayMode.HIDDEN : ToolDisplayMode.FULL,
                    normalHidden ? ToolDisplayMode.FULL : ToolDisplayMode.HIDDEN,
                );
                const row = harness.read("mouse-toggle");
                row.setExpanded(globalExpanded);
                const result = {content: [
                    {type: "text", text: "row-local output"},
                    {type: "image", data: png, mimeType: "image/png"},
                ], isError: false};
                row.updateResult(result, true);
                harness.root.addChild(row);
                const before = harness.root.render(80);
                assert.equal(before.some((line) => line.includes("\x1b_G")), !globallyHidden);
                clickToolHeader(row);
                const toggled = harness.root.render(80);
                assert.equal(harness.expanded, globalExpanded, "a row click must not change the global slot");
                assert.equal(plain(toggled).includes("row-local output"), globallyHidden);
                assert.equal(toggled.some((line) => line.includes("\x1b_G")), globallyHidden,
                    "images must follow the same mode as the row's text");
                if (!globallyHidden) assert.equal(toggled.length, 2, "a hidden active row retains only its header");
                row.updateResult(result);
                const completed = harness.root.render(80);
                if (globallyHidden) {
                    assert.match(plain(completed), /row-local output/);
                    assert.ok(completed.some((line) => line.includes("\x1b_G")));
                } else {
                    assert.deepEqual(completed, []);
                }
            } finally {
                harness.close();
            }
        }
    }
});

test("view hot-swaps retain existing row-local slots and restore native expansion methods on cleanup", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const row = harness.read("already-expanded");
    const originalExpand = row.setExpanded;
    row.setExpanded(true);
    row.updateResult({content: [{type: "text", text: "locally expanded output"}], isError: false});
    harness.root.addChild(row);
    assert.match(plain(harness.root.render(80)), /locally expanded output/,
        "initial classification must probe the row, not assume the global slot");
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.HIDDEN);
    assert.deepEqual(harness.root.render(80), []);
    assert.equal(harness.expanded, false);
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
    assert.match(plain(harness.root.render(80)), /locally expanded output/);
    harness.runtime.stopSession();
    assert.equal(row.setExpanded, originalExpand);
});

test("fullscreen discovers new rows before drawing layout frames that bypass the public root render method", (t) => {
    t.mock.timers.enable({apis: ["setInterval", "setTimeout"]});
    const terminal: Terminal = {
        columns: 80, rows: 20, kittyProtocolActive: false,
        start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {},
        hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
        setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const root = new TuiAltScreen(terminal, false, undefined, {mouse: false});
    const harness = createHarness(root);
    root.start();
    t.after(() => { root.stop({preserveScreen: true}); harness.close(); });
    const thought = new AssistantMessageComponent(assistant([{type: "thinking", thinking: "must not flash in fullscreen"}]));
    harness.root.addChild(thought);
    root.requestRender();
    harness.startWork();
    root.renderNow();
    assert.doesNotMatch(plain(root.getScreenLines()), /must not flash/);
    assert.match(plain(root.getScreenLines()), /Working…/);
    const active = harness.read("fullscreen-active");
    harness.root.addChild(active);
    root.requestRender();
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /fullscreen-active/);
    assert.doesNotMatch(plain(root.getScreenLines()), /Working…/);
    active.updateResult({content: [{type: "text", text: "completed private output"}], isError: true});
    root.requestRender();
    root.renderNow();
    assert.doesNotMatch(plain(root.getScreenLines()), /fullscreen-active|completed private output/);
    assert.match(plain(root.getScreenLines()), /Working…/);
    harness.expanded = true;
    active.setExpanded(true);
    root.requestRender();
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /must not flash/);
    assert.match(plain(root.getScreenLines()), /completed private output/);
});

test("transcript projection survives a stable TUI facade replacing its renderer without modifying facade methods", (t) => {
    let current = new TestTui();
    const facade = new Proxy(current, {
        get(_target, property) {
            const value = Reflect.get(current, property, current);
            return typeof value === "function" ? (...args: unknown[]) =>
                Reflect.apply(Reflect.get(current, property, current), current, args) : value;
        },
        set() { assert.fail("extension must not assign methods on Pi's stable TUI facade"); },
    });
    const harness = createHarness(facade);
    t.after(() => harness.close());
    harness.root.addChild(new AssistantMessageComponent(assistant([{type: "thinking", thinking: "retained thought"}])));
    assert.deepEqual(current.render(80), []);
    const sources = [...current.children];
    current = new TestTui();
    for (const source of sources) current.addChild(source);
    harness.runtime.attach(facade);
    harness.root.addChild(new AssistantMessageComponent(assistant([{type: "thinking", thinking: "new thought"}])));
    assert.deepEqual(current.render(80), []);
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
    assert.match(plain(current.render(80)), /retained thought/);
    assert.match(plain(current.render(80)), /new thought/);
    harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    assert.deepEqual(current.render(80), []);
    harness.runtime.stopSession();
    assert.match(plain(current.render(80)), /retained thought/);
    assert.match(plain(current.render(80)), /new thought/);
});

test("hidden omits internal summaries but not notifications, and restores detached components and later decorators", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const summary = new CompactionSummaryMessageComponent({role: "compactionSummary", summary: "internal summary", tokensBefore: 123, timestamp: 0});
    const branch = new BranchSummaryMessageComponent({role: "branchSummary", summary: "internal branch summary", fromId: "branch", timestamp: 0});
    harness.root.addChild(summary);
    harness.root.addChild(branch);
    harness.root.addChild(new Text("Approval or important notification", 0, 0));
    assert.equal(plain(harness.root.render(80)).trim(), "Approval or important notification");
    const component = new AssistantMessageComponent(assistant([{type: "thinking", thinking: "preserved source"}]));
    const update = component.updateContent;
    harness.root.addChild(component);
    harness.root.render(80);
    harness.root.removeChild(component);
    harness.root.render(80);
    assert.equal(component.updateContent, update);
    assert.match(plain(component.render(80)), /preserved source/);
    harness.root.addChild(component);
    harness.root.render(80);
    const decorated = component.updateContent;
    const later: typeof decorated = (message, streaming) => decorated.call(component, message, streaming);
    component.updateContent = later;
    const render = harness.root.render;
    const laterRender: typeof render = (width) => render.call(harness.root, width);
    harness.root.render = laterRender;
    harness.runtime.stopSession();
    assert.equal(component.updateContent, later);
    assert.equal(harness.root.render, laterRender);
    assert.match(plain(component.render(80)), /preserved source/);
});

class TestTui extends TuiMainScreen {
    constructor() {
        super({
            columns: 80, rows: 24, kittyProtocolActive: false,
            start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {},
            hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
            setTitle() {}, setProgress() {}, setProgramStatus() {},
        });
    }

    override requestRender(_force?: boolean): void {}
}

function createHarness(root: TUI = new TestTui(), mode: ExtensionContext["mode"] = "tui") {
    const transcript = new Container();
    const widgets = new Container();
    root.addChild(transcript);
    root.addChild(widgets);
    const rows = new ToolDisplayRows();
    rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    let expanded = false;
    let resolver!: ToolRendererResolver;
    const events = new Map<string, (event: unknown) => void>();
    const pi = {
        registerToolRenderer(value: ToolRendererResolver) { resolver = value; },
        on(event: string, handler: (event: unknown) => void) { events.set(event, handler); },
    } as unknown as ExtensionAPI;
    const theme = {fg: (_color: string, text: string) => text, bold: (text: string) => text} as unknown as Theme;
    let widget: (Component & {dispose?(): void}) | undefined;
    const context = {hasUI: true, mode, ui: {
        theme, getToolsExpanded: () => expanded, notify() {},
        setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => typeof widget) {
            widget?.dispose?.();
            widgets.clear();
            widget = factory?.(root, theme);
            if (widget) widgets.addChild(widget);
        },
    }} as unknown as ExtensionContext;
    const runtime = new TranscriptDisplayRuntime(pi, rows.modes);
    runtime.register();
    runtime.startSession(context);
    runtime.attach(root);
    const read = new ReadTool(pi, () => assert.fail("rendering must not execute tools"), rows).toolDefinition();
    return {
        root: transcript,
        rows, runtime, context,
        startWork() { events.get("agent_start")?.({type: "agent_start"}); },
        endWork() { events.get("agent_end")?.({type: "agent_end", messages: []}); },
        updateMessage(message: AssistantMessage) { events.get("message_update")?.({type: "message_update", message}); },
        endMessage(message: AssistantMessage) { events.get("message_end")?.({type: "message_end", message}); },
        startTool(toolCallId: string, parentToolCallId?: string) {
            events.get("tool_execution_start")?.({type: "tool_execution_start", toolCallId, parentToolCallId});
        },
        endTool(toolCallId: string, parentToolCallId?: string) {
            events.get("tool_execution_end")?.({type: "tool_execution_end", toolCallId, parentToolCallId});
        },
        widgetCount() { return widgets.children.length; },
        get expanded() { return expanded; },
        set expanded(value: boolean) { expanded = value; },
        read(id: string) {
            const renderers = resolver("read", () => read);
            assert.ok(renderers);
            return new ToolExecutionComponent("read", id, {path: id}, {outputPad: 0}, renderers,
                root, process.cwd());
        },
        close() { runtime.stopSession(); rows.clear(); },
    };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return {
        role: "assistant", content, api: "openai-responses", provider: "test", model: "test",
        stopReason, timestamp: 0,
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    };
}

function clickToolHeader(row: ToolExecutionComponent): void {
    const lines = row.render(80);
    assert.ok(lines.length >= 2, "the active row must have a clickable header");
    const result = row.handleMouse({
        type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1,
        width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
    });
    assert.equal(result?.handled, true);
}

function plain(lines: string[]): string {
    return lines.map(stripVTControlCharacters).join("\n");
}
