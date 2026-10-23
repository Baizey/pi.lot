import assert from "node:assert/strict";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";
import {
    AssistantMessageComponent,
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    initTheme,
    SessionManager,
    ToolExecutionComponent,
    type ExtensionAPI,
    type ExtensionContext,
    type MessageUpdateEvent,
    type Theme,
    type ToolRendererResolver,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {Container, getCapabilities, Image, MouseRegion, setCapabilities, Text, TuiAltScreen, TuiMainScreen, type Terminal, type TUI} from "@earendil-works/pi-tui";
import {createChatViewport} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import {ReadTool} from "../src/tools/builtin/ReadTool.js";
import {TranscriptDisplayRuntime} from "../src/tui/TranscriptDisplayRuntime.js";
import {ToolDisplayMode} from "../src/tui/tool/ToolDisplayMode.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {displayWidth, truncateToWidth} from "../src/tui/terminalText.js";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp9sAAAAASUVORK5CYII=";
initTheme("dark");

test("Conversation previews active thinking and retains its compact completion on either slot", (t) => {
    for (const expanded of [false, true]) {
        const harness = createHarness();
        t.after(() => harness.close());
        harness.expanded = expanded;
        harness.rows.modes.setViews(expanded ? ToolDisplayMode.FULL : ToolDisplayMode.HIDDEN,
            expanded ? ToolDisplayMode.HIDDEN : ToolDisplayMode.FULL);
        const content = Array.from({length: 30}, (_, index) => `live thought ${index + 1}`).join("  \n");
        const source = assistant([{type: "thinking", thinking: content, thinkingSignature: "signed"}], "pending");
        const original = structuredClone(source);
        const component = new AssistantMessageComponent(source);
        harness.root.addChild(component);
        const view = () => plain(harness.root.render(80));
        assert.match(view(), /18 earlier lines/);
        assert.match(view(), /live thought 30/);
        assert.doesNotMatch(view(), /live thought 1(?:\s|$)/);
        const completed = {...source, stopReason: "stop" as const};
        component.updateContent(completed, false);
        assert.match(view(), /Thinking/);
        assert.doesNotMatch(view(), /live thought|earlier lines/);
        harness.expanded = !expanded;
        assert.match(view(), /live thought 1(?:\s|$)/, "Full still restores the complete native thinking content");
        harness.expanded = expanded;
        assert.match(view(), /Thinking/);
        assert.deepEqual(source, original);
    }
});

test("thinking and top-level tools share one five-item completion window", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const thoughts: AssistantMessageComponent[] = [];
    const calls: ToolExecutionComponent[] = [];
    for (let index = 0; index < 4; index++) {
        const source = {...assistant([{type: "thinking", thinking: `private thought ${index}`}], "pending"), timestamp: index};
        const thought = new AssistantMessageComponent(source);
        const call = harness.read(`shared-${index}`);
        harness.root.addChild(thought);
        harness.root.addChild(call);
        harness.root.render(80);
        thought.updateContent({...source, stopReason: "toolUse"}, false);
        call.updateResult({content: [{type: "text", text: "hidden result"}], isError: false});
        thoughts.push(thought);
        calls.push(call);
    }
    const view = plain(harness.root.render(80));
    assert.equal((view.match(/Thinking/g) ?? []).length, 2);
    assert.deepEqual(view.match(/read \| shared-\d/g), [1, 2, 3].map((index) => `read | shared-${index}`));
    assert.deepEqual(thoughts[0]!.render(80), []);
    assert.deepEqual(thoughts[1]!.render(80), []);
    assert.deepEqual(calls[0]!.render(80), []);
    assert.doesNotMatch(view, /private thought|hidden result/);
    harness.root.invalidate();
    assert.equal((plain(harness.root.render(80)).match(/Thinking/g) ?? []).length, 2, "redraws cannot promote older thoughts");
});

test("empty provider thinking shows an active label and completes before subsequent text and tools", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const source = assistant([{type: "thinking", thinking: "", thinkingSignature: "opaque"}], "pending");
    const original = structuredClone(source);
    harness.updateMessage(source, {type: "thinking_start", contentIndex: 0, partial: source});
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    assert.match(plain(harness.root.render(80)), /Thinking\.\.\./);
    harness.updateMessage(source, {type: "thinking_end", contentIndex: 0, content: "", partial: source});
    assert.match(plain(harness.root.render(80)), /Thinking/);
    assert.doesNotMatch(plain(harness.root.render(80)), /Thinking\.\.\./, "thinking_end finalizes without waiting for message_end");
    for (let index = 0; index < 5; index++) {
        const call = harness.read(`after-thinking-${index}`);
        harness.root.addChild(call);
        harness.endTool(`after-thinking-${index}`);
        call.updateResult({content: [], isError: false});
    }
    const response = {...source, content: [...source.content, {type: "text" as const, text: "The answer."}], stopReason: "stop" as const};
    harness.endMessage(response);
    component.updateContent(response, false);
    const view = plain(harness.root.render(80));
    assert.match(view, /The answer/);
    assert.doesNotMatch(view, /Thinking/, "message_end cannot promote a previously finished thinking run");
    assert.deepEqual(source, original);
});

test("active thinking does not consume the shared completed window", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const calls = Array.from({length: 5}, (_, index) => {
        const call = harness.read(`before-thinking-${index}`);
        harness.root.addChild(call);
        harness.endTool(`before-thinking-${index}`);
        call.updateResult({content: [], isError: false});
        return call;
    });
    const source = assistant([{type: "thinking", thinking: "active reasoning"}], "pending");
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    const view = () => plain(harness.root.render(80));
    assert.equal(view().match(/read \| before-thinking-/g)?.length, 5);
    assert.match(view(), /active reasoning/);
    component.updateContent({...source, stopReason: "stop"}, false);
    assert.equal(view().match(/read \| before-thinking-/g)?.length, 4);
    assert.match(view(), /Thinking/);
    assert.doesNotMatch(view(), /active reasoning/);
    assert.deepEqual(calls[0]!.render(80), []);
});

test("thinking completion order is observed before the first frame and is not promoted by message_end", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const source = assistant([{type: "thinking", thinking: "never expose completed reasoning"}], "pending");
    harness.startMessage(source);
    harness.updateMessage(source, {type: "thinking_end", contentIndex: 0, content: "", partial: source});
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    for (let index = 0; index < 5; index++) {
        const call = harness.read(`newer-${index}`);
        harness.root.addChild(call);
        harness.endTool(`newer-${index}`);
        call.updateResult({content: [], isError: false});
    }
    const final = {...source, stopReason: "stop" as const};
    harness.endMessage(final);
    component.updateContent(final, false);
    assert.doesNotMatch(plain(harness.root.render(80)), /Thinking|completed reasoning/);
    assert.deepEqual(component.render(80), []);
    harness.root.invalidate();
    assert.deepEqual(component.render(80), []);
});

test("adjacent provider thinking blocks resume one run while text-separated runs finish independently", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const first = assistant([{type: "thinking", thinking: "", thinkingSignature: "first"}], "pending");
    harness.startMessage(first);
    harness.updateMessage(first, {type: "thinking_start", contentIndex: 0, partial: first});
    const component = new AssistantMessageComponent(first);
    harness.root.addChild(component);
    const view = () => plain(harness.root.render(80));
    assert.match(view(), /Thinking\.\.\./);
    harness.updateMessage(first, {type: "thinking_end", contentIndex: 0, content: "", partial: first});
    assert.equal(view().match(/Thinking/g)?.length, 1);
    const adjacent = {...first, content: [...first.content,
        {type: "thinking" as const, thinking: "continued thinking"}]};
    harness.updateMessage(adjacent, {type: "thinking_start", contentIndex: 1, partial: adjacent});
    component.updateContent(adjacent, true);
    assert.match(view(), /continued thinking/);
    assert.doesNotMatch(view(), /Thinking/, "resuming a native run removes its former compact completion");
    harness.updateMessage(adjacent, {type: "thinking_end", contentIndex: 1, content: "", partial: adjacent});
    assert.equal(view().match(/Thinking/g)?.length, 1, "two adjacent provider blocks still occupy one window entry");
    const separated = {...adjacent, content: [...adjacent.content, {type: "text" as const, text: "Public explanation."},
        {type: "thinking" as const, thinking: "later thinking"}]};
    harness.updateMessage(separated, {type: "thinking_start", contentIndex: 3, partial: separated});
    component.updateContent(separated, true);
    assert.equal(view().match(/Thinking/g)?.length, 1);
    assert.match(view(), /later thinking/);
    assert.match(view(), /Public explanation/);
    harness.updateMessage(separated, {type: "thinking_end", contentIndex: 3, content: "", partial: separated});
    assert.equal(view().match(/Thinking/g)?.length, 2);
    assert.doesNotMatch(view(), /continued thinking|later thinking/);
});

test("thinking identities survive entry persistence and cloned rebuilds even with identical messages and timestamps", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const sources = Array.from({length: 7}, () => assistant([{type: "thinking", thinking: "identical historical reasoning"}]));
    for (const source of sources) harness.sessionManager.appendMessage(source);
    let components = sources.map((source) => new AssistantMessageComponent(source));
    for (const component of components) harness.root.addChild(component);
    const assertWindow = () => {
        const view = plain(harness.root.render(80));
        assert.equal(view.match(/Thinking/g)?.length, 5);
        for (const component of components.slice(0, -5)) assert.deepEqual(component.render(80), []);
        for (const component of components.slice(-5)) assert.equal(plain(component.render(80)).trim(), "Thinking");
        assert.doesNotMatch(view, /historical reasoning/);
    };
    assertWindow();
    const live = assistant([{type: "thinking", thinking: "identical historical reasoning"}], "pending");
    harness.startMessage(live);
    harness.updateMessage(live, {type: "thinking_start", contentIndex: 0, partial: live});
    const component = new AssistantMessageComponent(live);
    components.push(component);
    harness.root.addChild(component);
    harness.root.render(80);
    const final = {...live, stopReason: "stop" as const};
    harness.endMessage(final);
    component.updateContent(final, false);
    const entryId = harness.sessionManager.appendMessage(final);
    harness.endTurn(final, entryId);
    sources.push(final);
    assertWindow();
    for (const views of [[ToolDisplayMode.FULL, ToolDisplayMode.TRUNCATED], [ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL]] as const) {
        harness.rows.modes.setViews(views[0], views[1]);
        harness.root.render(80);
    }
    harness.root.clear();
    components = sources.map((source) => new AssistantMessageComponent(structuredClone(source)));
    for (const rebuilt of components) harness.root.addChild(rebuilt);
    assertWindow();
    harness.root.invalidate();
    assertWindow();
});

test("signature-only runs do not shift native thinking collapse preferences and completed headers ignore clicks", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const source = assistant([
        {type: "thinking", thinking: "", thinkingSignature: "opaque"},
        {type: "text", text: "Between thoughts."},
        {type: "thinking", thinking: Array.from({length: 30}, (_, index) => `visible thought ${index + 1}`).join("  \n")},
    ], "pending");
    const component = new AssistantMessageComponent(source, true, undefined, "Custom label");
    harness.root.addChild(component);
    const view = () => plain(harness.root.render(80));
    assert.match(view(), /Thinking\s+Between thoughts\.\s+Custom label/);
    const click = (y: number) => component.handleMouse({
        type: "click", button: "left", x: 2, y, screenX: 2, screenY: y,
        width: 80, height: harness.root.render(80).length, shift: false, alt: false, ctrl: false,
    });
    assert.equal(click(4)?.handled, true);
    assert.match(view(), /18 earlier lines/);
    harness.expanded = true;
    assert.match(view(), /visible thought 1(?:\s|$)/, "native visible-run indices do not include the signature-only run");
    component.setHideThinkingBlock(true);
    harness.expanded = false;
    assert.match(view(), /Custom label/);
    component.updateContent({...source, stopReason: "stop"}, false);
    view();
    assert.equal(click(1)?.handled, undefined, "a compact completion cannot toggle invisible native content");
    harness.expanded = true;
    assert.match(view(), /Custom label/);
    assert.doesNotMatch(view(), /visible thought/);
});

test("thinking eviction preserves native abort, error, and length-stop rows without orphan gaps", (t) => {
    for (const stopReason of ["aborted", "error", "length"] as const) {
        const harness = createHarness();
        t.after(() => harness.close());
        const source = assistant([{type: "thinking", thinking: "private unfinished reasoning"}], "pending");
        harness.startMessage(source);
        const final = {...source, stopReason};
        harness.endMessage(final);
        const component = new AssistantMessageComponent(final);
        harness.root.addChild(component);
        const view = () => plain(harness.root.render(80));
        assert.match(view(), /Thinking/);
        const error = stopReason === "aborted" ? /Operation aborted/ : stopReason === "error" ? /Unknown error/ : /Response was truncated/;
        assert.match(view(), error);
        assert.doesNotMatch(view(), /private unfinished reasoning/);
        for (let index = 0; index < 5; index++) {
            const call = harness.read(`${stopReason}-${index}`);
            harness.root.addChild(call);
            harness.endTool(`${stopReason}-${index}`);
            call.updateResult({content: [], isError: false});
        }
        assert.match(view(), error);
        assert.doesNotMatch(view(), /Thinking|private unfinished reasoning/);
        assert.equal(component.render(80).length, 2, "only the native leading gap and error row remain");
    }
});

test("fullscreen Conversation previews thinking and evicts its compact completion from the shared window", (t) => {
    t.mock.timers.enable({apis: ["setInterval", "setTimeout"]});
    const root = new TuiAltScreen(new TestTui().terminal, false, undefined, {mouse: false});
    const harness = createHarness(root);
    const source = assistant([{type: "thinking", thinking: Array.from({length: 30}, (_, index) => `screen thought ${index + 1}`).join("  \n")}], "pending");
    harness.startMessage(source);
    harness.updateMessage(source, {type: "thinking_start", contentIndex: 0, partial: source});
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    root.start();
    t.after(() => { root.stop({preserveScreen: true}); harness.close(); });
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /18 earlier lines/);
    assert.match(plain(root.getScreenLines()), /screen thought 30/);
    const final = {...source, content: [...source.content, {type: "text" as const, text: "Public final answer."}], stopReason: "stop" as const};
    harness.endMessage(final);
    component.updateContent(final, false);
    root.requestRender();
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /Thinking/);
    assert.doesNotMatch(plain(root.getScreenLines()), /screen thought/);
    for (let index = 0; index < 5; index++) {
        const call = harness.read(`screen-newer-${index}`);
        harness.root.addChild(call);
        harness.endTool(`screen-newer-${index}`);
        call.updateResult({content: [], isError: false});
    }
    root.requestRender();
    root.renderNow();
    assert.doesNotMatch(plain(root.getScreenLines()), /Thinking/);
    assert.match(plain(root.getScreenLines()), /Public final answer/);
});

test("the first native slot switch from Conversation to Preview already bounds thinking", (t) => {
    for (const expanded of [false, true]) {
        const harness = createHarness();
        t.after(() => harness.close());
        harness.expanded = expanded;
        harness.rows.modes.setViews(expanded ? ToolDisplayMode.TRUNCATED : ToolDisplayMode.HIDDEN,
            expanded ? ToolDisplayMode.HIDDEN : ToolDisplayMode.TRUNCATED);
        const source = assistant([{type: "thinking", thinking: Array.from({length: 30}, (_, index) => `slot thought ${index + 1}`).join("  \n")}], "pending");
        const component = new AssistantMessageComponent(source);
        harness.root.addChild(component);
        harness.root.render(80);
        harness.root.render(80);
        harness.expanded = !expanded;
        const first = plain(harness.root.render(80));
        assert.match(first, /18 earlier lines/);
        assert.match(first, /slot thought 30/);
        assert.doesNotMatch(first, /slot thought 1(?:\s|$)/);
        assert.equal(harness.root.render(80).length, 14);
    }
});

test("stale native invalidation cannot replace event-owned thinking completions", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const source = assistant([{type: "thinking", thinking: "first private thought"},
        {type: "text", text: "Visible response."}], "pending");
    harness.startMessage(source);
    harness.updateMessage(source, {type: "thinking_end", contentIndex: 0, content: "", partial: source});
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    harness.root.render(80);
    for (let index = 0; index < 5; index++) {
        const call = harness.read(`before-final-thinking-${index}`);
        harness.root.addChild(call);
        harness.endTool(`before-final-thinking-${index}`);
        call.updateResult({content: [], isError: false});
    }
    const final = {...source, content: [...source.content, {type: "thinking" as const, thinking: "last private thought"}], stopReason: "stop" as const};
    harness.endMessage(final);
    component.invalidate(); // Native UI has not received final yet.
    component.updateContent(final, false);
    const view = () => plain(harness.root.render(80));
    assert.equal(view().match(/Thinking/g)?.length, 1);
    assert.deepEqual(view().match(/read \| before-final-thinking-\d/g),
        [1, 2, 3, 4].map((index) => `read | before-final-thinking-${index}`));
    assert.doesNotMatch(view(), /first private thought|last private thought/);
    harness.root.invalidate();
    assert.equal(view().match(/Thinking/g)?.length, 1);
});

test("delayed events from older output slots cannot complete a later active thinking run", (t) => {
    for (const kind of ["text", "tool", "thinking"] as const) {
        const harness = createHarness();
        t.after(() => harness.close());
        const tool = {type: "toolCall" as const, id: "earlier-slot", name: "read", arguments: {path: "earlier"}};
        const prefix: AssistantMessage["content"] = kind === "thinking"
            ? [{type: "thinking", thinking: "earlier private thought"}, {type: "text", text: "Earlier public text."}]
            : kind === "tool" ? [tool] : [{type: "text", text: "Earlier public text."}];
        const index = prefix.length;
        const source = assistant([...prefix, {type: "thinking", thinking: Array.from({length: 30}, (_, line) => `current thought ${line + 1}`).join("  \n")}], "pending");
        harness.startMessage(source);
        if (kind === "thinking") {
            harness.updateMessage(source, {type: "thinking_start", contentIndex: 0, partial: source});
            harness.updateMessage(source, {type: "text_start", contentIndex: 1, partial: source});
        } else if (kind === "tool") harness.updateMessage(source, {type: "toolcall_start", contentIndex: 0, partial: source});
        else harness.updateMessage(source, {type: "text_start", contentIndex: 0, partial: source});
        harness.updateMessage(source, {type: "thinking_start", contentIndex: index, partial: source});
        const component = new AssistantMessageComponent(source);
        harness.root.addChild(component);
        const view = () => plain(harness.root.render(80));
        assert.match(view(), /18 earlier lines/);
        if (kind === "thinking") harness.updateMessage(source, {type: "thinking_end", contentIndex: 0, content: "", partial: source});
        else if (kind === "tool") harness.updateMessage(source, {type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: source});
        else harness.updateMessage(source, {type: "text_end", contentIndex: 0, content: "Earlier public text.", partial: source});
        assert.match(view(), /18 earlier lines/);
        assert.match(view(), /current thought 30/);
        harness.updateMessage(source, {type: "thinking_delta", contentIndex: index, delta: "", partial: source});
        assert.match(view(), /current thought 30/);
        harness.updateMessage(source, {type: "thinking_end", contentIndex: index, content: "", partial: source});
        assert.doesNotMatch(view(), /current thought|earlier lines/);
    }
});

test("thinking events cannot suppress progress before native content reaches the transcript", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const harness = createHarness();
    t.after(() => harness.close());
    harness.startWork();
    const initial = assistant([], "pending");
    harness.startMessage(initial);
    const component = new AssistantMessageComponent(initial);
    harness.root.addChild(component);
    const view = () => plain(harness.root.render(80));
    assert.match(view(), /Working…/);
    const source = {...initial, content: [{type: "thinking" as const, thinking: "", thinkingSignature: "opaque"}]};
    harness.updateMessage(source, {type: "thinking_start", contentIndex: 0, partial: source});
    assert.match(view(), /Working…/, "later extension handlers can delay native delivery");
    component.updateContent(source, true);
    assert.match(view(), /Thinking\.\.\./);
    assert.doesNotMatch(view(), /Working…/);
});

test("newly revealed older history cannot displace newer historical thinking or tools", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const thoughts: AssistantMessageComponent[] = [];
    for (let index = 0; index < 3; index++) {
        const thought = new AssistantMessageComponent({...assistant([{type: "thinking", thinking: `historical ${index}`}]), timestamp: index});
        const call = harness.read(`historical-shared-${index}`);
        call.updateResult({content: [], isError: false});
        harness.root.addChild(thought);
        harness.root.addChild(call);
        thoughts.push(thought);
    }
    const view = () => plain(harness.root.render(80));
    assert.equal(view().match(/Thinking/g)?.length, 2);
    const oldest = new AssistantMessageComponent({...assistant([{type: "thinking", thinking: "newly revealed oldest"}]), timestamp: -1});
    harness.root.children.unshift(oldest);
    const oldTool = harness.read("oldest-tool");
    oldTool.updateResult({content: [], isError: false});
    harness.root.children.unshift(oldTool);
    assert.equal(view().match(/Thinking/g)?.length, 2);
    assert.deepEqual(oldest.render(80), []);
    assert.deepEqual(oldTool.render(80), []);
    assert.deepEqual(thoughts[0]!.render(80), []);
    assert.deepEqual(view().match(/read \| historical-shared-\d/g), [0, 1, 2].map((index) => `read | historical-shared-${index}`));
});

test("thinking lifecycle follows event cursors even when a shared partial already contains later blocks", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    for (let index = 0; index < 4; index++) {
        const call = harness.read(`queued-prior-${index}`);
        harness.root.addChild(call);
        harness.endTool(`queued-prior-${index}`);
        call.updateResult({content: [], isError: false});
    }
    const source = assistant([
        {type: "thinking", thinking: Array.from({length: 30}, (_, index) => `queued thought ${index + 1}`).join("  \n")},
        {type: "text", text: "Later explanation."},
        {type: "thinking", thinking: "", thinkingSignature: "future"},
    ], "pending");
    harness.startMessage(source);
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    const view = () => plain(harness.root.render(80));
    assert.doesNotMatch(view(), /Thinking|queued thought/);
    harness.updateMessage(source, {type: "thinking_start", contentIndex: 0, partial: source});
    assert.match(view(), /18 earlier lines/);
    assert.match(view(), /queued thought 30/);
    assert.doesNotMatch(view(), /Thinking\.\.\./, "the later thinking group has not started yet");
    harness.updateMessage(source, {type: "thinking_end", contentIndex: 0, content: "", partial: source});
    assert.equal(view().match(/Thinking/g)?.length, 1);
    assert.equal(view().match(/read \| queued-prior-/g)?.length, 4);
    harness.updateMessage(source, {type: "thinking_start", contentIndex: 2, partial: source});
    assert.match(view(), /Thinking\.\.\./);
    assert.equal(view().match(/read \| queued-prior-/g)?.length, 4, "the active run does not consume the window");
    harness.updateMessage(source, {type: "thinking_end", contentIndex: 2, content: "", partial: source});
    assert.equal(view().match(/Thinking/g)?.length, 2);
    assert.equal(view().match(/read \| queued-prior-/g)?.length, 3);
    assert.doesNotMatch(view(), /Thinking\.\.\.|queued thought/);
});

test("Conversation keeps completed thinking compact while preserving conversation and native preferences", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    for (const collapsed of [false, true]) {
        const source = assistant([{type: "thinking", thinking: "private completed thought", thinkingSignature: "signed"}]);
        const original = structuredClone(source);
        const component = new AssistantMessageComponent(source, collapsed);
        harness.root.addChild(component);
        assert.equal(plain(harness.root.render(80)).trim(), "Thinking");
        component.invalidate();
        component.setOutputPad(2);
        assert.equal(plain(component.render(80)).trim(), "Thinking");
        assert.deepEqual(source, original);
        harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
        assert.match(plain(component.render(80)), collapsed ? /Thinking\.\.\./ : /private completed thought/);
        harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
        assert.equal(plain(component.render(80)).trim(), "Thinking");
        harness.root.removeChild(component);
        harness.root.render(80);
    }
    const source = assistant([
        {type: "thinking", thinking: "private mixed thought"},
        {type: "text", text: "The conversational answer."},
    ]);
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    assert.match(plain(harness.root.render(80)), /Thinking\s+The conversational answer\./);
    assert.doesNotMatch(plain(component.render(80)), /private mixed thought/);
    assert.equal(source.content.length, 2);
});

test("Conversation collapses earlier thinking when speaking starts without changing native preferences or sources", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    const pending = assistant([{type: "thinking", thinking: "long private streaming thought"}], "pending");
    const original = structuredClone(pending);
    const component = new AssistantMessageComponent(pending, true);
    harness.root.addChild(component);
    assert.match(plain(harness.root.render(80)), /Thinking\.\.\./, "active thinking respects native collapse preferences");
    const grown = assistant([{type: "thinking", thinking: "new private streaming thought"}], "pending");
    component.updateContent(grown, true);
    assert.match(plain(component.render(80)), /Thinking\.\.\./);
    const response = assistant([
        {type: "thinking", thinking: "completed private reasoning"},
        {type: "text", text: "Here is the answer."},
    ], "pending");
    component.updateContent(response, true);
    assert.match(plain(component.render(80)), /Thinking\s+Here is the answer\./);
    assert.doesNotMatch(plain(component.render(80)), /completed private reasoning|Thinking\.\.\./);
    component.updateContent({...response, stopReason: "stop"}, false);
    component.invalidate();
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
    component.setHideThinkingBlock(false);
    assert.match(plain(component.render(80)), /completed private reasoning/);
    assert.match(plain(component.render(80)), /Here is the answer/);
    assert.deepEqual(pending, original);
    assert.equal(grown.content[0]!.type, "thinking");
});

test("Preview follows the last twelve thinking rows without truncating assistant text or changing sources", (t) => {
    for (const expanded of [false, true]) {
        const harness = createHarness();
        t.after(() => harness.close());
        harness.expanded = expanded;
        harness.rows.modes.setViews(
            expanded ? ToolDisplayMode.FULL : ToolDisplayMode.TRUNCATED,
            expanded ? ToolDisplayMode.TRUNCATED : ToolDisplayMode.FULL,
        );
        const lines = (prefix: string, count: number) => Array.from({length: count}, (_, index) => `${prefix} ${index + 1}`).join("  \n");
        const source = assistant([
            {type: "thinking", thinking: lines("thought", 30), thinkingSignature: "signed"},
            {type: "text", text: lines("answer", 40)},
            {type: "thinking", thinking: lines("later thought", 24)},
        ], "pending");
        const original = structuredClone(source);
        const component = new AssistantMessageComponent(source);
        harness.root.addChild(component);
        const view = () => plain(harness.root.render(100)).split("\n").map((line) => line.trim());
        assert.ok(view().includes("... (18 earlier lines)"));
        assert.ok(view().includes("... (12 earlier lines)"));
        assert.equal(view().includes("thought 1"), false);
        assert.equal(view().includes("later thought 1"), false);
        for (let index = 19; index <= 30; index++) assert.ok(view().includes(`thought ${index}`));
        for (let index = 13; index <= 24; index++) assert.ok(view().includes(`later thought ${index}`));
        assert.ok(view().includes("answer 1"));
        assert.ok(view().includes("answer 40"));
        const grown = assistant([
            {type: "thinking", thinking: lines("thought", 45), thinkingSignature: "signed"},
            {type: "text", text: lines("answer", 40)},
        ], "pending");
        const originalGrown = structuredClone(grown);
        component.updateContent(grown, true);
        assert.match(plain(component.render(100)), /33 earlier lines/, "a direct render discovers freshly rebuilt thinking runs");
        component.invalidate();
        component.setOutputPad(2);
        assert.match(plain(component.render(100)), /33 earlier lines/, "public setters preserve the Preview window immediately");
        assert.ok(view().includes("... (33 earlier lines)"));
        assert.equal(view().includes("thought 30"), false);
        assert.ok(view().includes("thought 45"));
        component.updateContent({...grown, stopReason: "stop"}, false);
        assert.equal(view().includes("thought 1"), false, "completed thinking retains the same Preview window");
        harness.expanded = !expanded;
        assert.ok(view().includes("thought 1"), "Full restores complete thinking");
        harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.MINIMAL);
        assert.ok(view().includes("thought 1"), "Compact retains native thinking behavior");
        harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.HIDDEN);
        assert.equal(view().some((line) => line.includes("thought")), false);
        assert.ok(view().includes("answer 1"));
        assert.deepEqual(source, original);
        assert.deepEqual(grown, originalGrown);
    }
});

test("Preview clips rendered thinking tails after Markdown wrapping and restores unbounded rendering on cleanup", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    harness.rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
    for (const thinking of [
        `START ${"middle ".repeat(300)}END`,
        `\`\`\`text\n${Array.from({length: 35}, (_, index) => `code ${index + 1}`).join("\n")}\n\`\`\``,
    ]) {
        const source = assistant([{type: "thinking", thinking}]);
        const component = new AssistantMessageComponent(source, false, undefined, undefined, 2);
        const baseline = new AssistantMessageComponent(source, false, undefined, undefined, 2);
        harness.root.addChild(component);
        for (const width of [12, 40, 80]) {
            const full = baseline.render(width).map(stripVTControlCharacters);
            const preview = harness.root.render(width).map(stripVTControlCharacters);
            assert.deepEqual(preview.slice(-12), full.slice(-12), "Markdown is rendered before selecting its visual tail");
            assert.equal(preview.length, 14, "leading gap, fold notice, and twelve rendered thinking rows");
            assert.equal(preview[1], truncateToWidth(`... (${full.length - 13} earlier lines)`, width));
            assert.ok(harness.root.render(width).every((line) => displayWidth(line) <= width));
        }
        harness.root.removeChild(component);
        harness.root.render(80);
        assert.deepEqual(component.render(80), baseline.render(80), "detached thinking regions recover native rendering");
    }
});

test("Preview respects native thinking labels and mouse visibility toggles", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    harness.rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
    const source = assistant([{type: "thinking", thinking: Array.from({length: 30}, (_, index) => `thought ${index + 1}`).join("  \n")}]);
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    const view = () => plain(harness.root.render(80));
    const click = () => {
        const height = harness.root.render(80).length;
        const result = component.handleMouse({
            type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1,
            width: 80, height, shift: false, alt: false, ctrl: false,
        });
        assert.equal(result?.handled, true);
    };
    assert.match(view(), /18 earlier lines/);
    click();
    assert.match(plain(component.render(80)), /Thinking\.\.\./);
    assert.match(view(), /Thinking\.\.\./);
    assert.doesNotMatch(view(), /thought|earlier lines/);
    click();
    assert.match(plain(component.render(80)), /18 earlier lines/, "mouse expansion is bounded before the next frame");
    assert.match(view(), /18 earlier lines/);
    component.setHideThinkingBlock(true);
    component.setHiddenThinkingLabel("Custom thinking label");
    assert.match(view(), /Custom thinking label/);
    assert.doesNotMatch(view(), /earlier lines/);
    harness.expanded = true;
    assert.match(view(), /Custom thinking label/, "switching view slots does not override native visibility");
    component.setHideThinkingBlock(false);
    assert.match(view(), /thought 1/);
    harness.expanded = false;
    assert.doesNotMatch(view(), /thought 1(?:\s|$)/);
    assert.match(view(), /thought 30/);
});

test("thinking previews preserve short runs, singular omission counts, and native adjacent-block grouping", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    harness.rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
    const lines = (prefix: string, count: number) => Array.from({length: count}, (_, index) => `${prefix} ${index + 1}`).join("  \n");
    for (const count of [12, 13]) {
        const component = new AssistantMessageComponent(assistant([{type: "thinking", thinking: lines("thought", count)}]));
        harness.root.addChild(component);
        const view = plain(harness.root.render(80));
        assert.equal(view.includes("earlier line"), count > 12);
        if (count === 13) assert.match(view, /\.\.\. \(1 earlier line\)/);
        else assert.match(view, /thought 1(?:\s|$)/);
        harness.root.removeChild(component);
        harness.root.render(80);
    }
    const component = new AssistantMessageComponent(assistant([
        {type: "thinking", thinking: lines("first block", 20)},
        {type: "thinking", thinking: lines("second block", 20)},
    ]));
    harness.root.addChild(component);
    const view = plain(harness.root.render(80));
    assert.equal((view.match(/earlier lines/g) ?? []).length, 1, "adjacent thinking blocks share a single native run window");
    assert.doesNotMatch(view, /first block/);
    assert.match(view, /second block 20/);
    assert.equal(harness.root.render(80).length, 14);
});

test("thinking cleanup preserves later render wrappers and restores native unbounded rows", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    harness.rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
    const source = assistant([{type: "thinking", thinking: Array.from({length: 30}, (_, index) => `thought ${index + 1}`).join("  \n")}]);
    const component = new AssistantMessageComponent(source);
    harness.root.addChild(component);
    harness.root.render(80);
    const content = component.children.find((child) => child instanceof Container);
    assert.ok(content);
    const region = content.children.find((child) => child instanceof MouseRegion);
    assert.ok(region);
    const render = component.render;
    const regionRender = region.render;
    const laterRender: typeof render = (width) => [...render.call(component, width), "Later assistant decoration"];
    const laterRegionRender: typeof regionRender = (width) => [...regionRender.call(region, width), "Later thinking decoration"];
    component.render = laterRender;
    region.render = laterRegionRender;
    assert.match(plain(harness.root.render(80)), /18 earlier lines/);
    harness.runtime.stopSession();
    assert.equal(component.render, laterRender);
    assert.equal(region.render, laterRegionRender);
    assert.match(plain(component.render(80)), /thought 1(?:\s|$)/);
    assert.match(plain(component.render(80)), /Later assistant decoration/);
    assert.match(plain(region.render(80)), /thought 1(?:\s|$)/);
    assert.match(plain(region.render(80)), /Later thinking decoration/);
    assert.doesNotMatch(plain(component.render(80)), /earlier lines/);
    assert.doesNotMatch(plain(region.render(80)), /earlier lines/);
});

test("Preview does not clip unrelated mouse regions outside assistant content", (t) => {
    const harness = createHarness();
    t.after(() => harness.close());
    harness.rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
    const region = new MouseRegion(new Text(Array.from({length: 30}, (_, index) => `notification ${index}`).join("\n"), 0, 0), () => undefined);
    harness.root.addChild(region);
    const view = plain(harness.root.render(80));
    assert.match(view, /notification 0/);
    assert.match(view, /notification 29/);
    assert.doesNotMatch(view, /earlier lines/);
    assert.equal(harness.root.render(80).length, 30);
});

test("fullscreen clips newly streamed thinking tails before layout frames draw them", (t) => {
    t.mock.timers.enable({apis: ["setInterval", "setTimeout"]});
    const root = new TuiAltScreen(new TestTui().terminal, false, undefined, {mouse: false});
    const harness = createHarness(root);
    harness.rows.modes.setViews(ToolDisplayMode.TRUNCATED, ToolDisplayMode.FULL);
    const source = (count: number) => assistant([{type: "thinking", thinking: Array.from({length: count}, (_, index) => `fullscreen thought ${index + 1}`).join("  \n")}], "pending");
    const component = new AssistantMessageComponent(source(30));
    harness.root.addChild(component);
    root.start();
    t.after(() => { root.stop({preserveScreen: true}); harness.close(); });
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /18 earlier lines/);
    assert.doesNotMatch(plain(root.getScreenLines()), /fullscreen thought 1(?:\s|$)/);
    component.updateContent(source(45), true);
    root.requestRender();
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /33 earlier lines/);
    assert.match(plain(root.getScreenLines()), /fullscreen thought 45/);
    assert.doesNotMatch(plain(root.getScreenLines()), /fullscreen thought 30(?:\s|$)/);
});

test("the working placeholder is rendered inline with tool rows, not in the editor dock", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const nativeRoot = new TestTui();
    const harness = createHarness(nativeRoot);
    t.after(() => harness.close());
    harness.root.addChild(new Text("Previous conversation", 0, 0));
    harness.dock.addChild(new Text("Editor dock", 0, 0));
    const children = [...harness.root.children];
    harness.startWork();
    assert.match(plain(harness.root.render(80)), /Previous conversation *\n\n.*Working…/);
    assert.doesNotMatch(plain(harness.dock.render(80)), /Working…/);
    const lines = plain(nativeRoot.render(80));
    assert.ok(lines.indexOf("Working…") < lines.indexOf("Editor dock"));
    assert.deepEqual(harness.root.children, children, "the placeholder is a transient render projection, not a stored row");
    harness.endWork();
    assert.equal(plain(harness.root.render(80)).trim(), "Previous conversation");
});

test("Conversation shows an animated working placeholder until tool headers or assistant content can take over, including between batches", (t) => {
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
    assert.doesNotMatch(view(), /Working…/);
    assert.match(view(), /private reasoning/, "active thinking replaces generic progress");
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
    thought.updateContent({...source, stopReason: "stop"}, false);
    assert.match(view(), /Thinking/);
    assert.match(view(), /Working…/, "compact thinking and finished tools do not suppress the next model request");

    thought.updateContent(assistant([{type: "text", text: "The final answer."}], "pending"), true);
    assert.match(view(), /The final answer/);
    assert.doesNotMatch(view(), /Working…/, "streaming assistant output replaces the placeholder too");
    harness.endWork();
    assert.doesNotMatch(view(), /Working…/);
    assert.match(view(), /The final answer/);
    const afterEnd = redraw.mock.callCount();
    t.mock.timers.tick(800);
    assert.equal(redraw.mock.callCount(), afterEnd, "ending or aborting a run stops the animation");
    assert.doesNotMatch(plain(harness.root.render(80)), /Working…/, "the placeholder leaves no completed transcript rows");
});

test("only visible live assistant content replaces the inline working placeholder", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const nativeRoot = new TestTui();
    const redraw = t.mock.method(nativeRoot, "requestRender");
    const harness = createHarness(nativeRoot);
    t.after(() => harness.close());
    const view = () => plain(harness.root.render(80));
    harness.root.addChild(new AssistantMessageComponent(assistant([{type: "text", text: "Historical answer"}])));
    harness.startWork();
    assert.match(view(), /Historical answer/);
    assert.match(view(), /Working…/, "historical text must not suppress progress for the new turn");
    const response = new AssistantMessageComponent(assistant([], "pending"));
    harness.root.addChild(response);
    assert.match(view(), /Working…/);
    response.updateContent(assistant([{type: "text", text: "  \n "}], "pending"), true);
    assert.match(view(), /Working…/, "empty or whitespace-only streaming content is not visible output");
    response.updateContent(assistant([{type: "thinking", thinking: "hidden live thinking"}], "pending"), true);
    assert.doesNotMatch(view(), /Working…/);
    assert.match(view(), /hidden live thinking/, "active thinking is visible progress");
    response.updateContent(assistant([{type: "text", text: "Visible live answer"}], "pending"), true);
    assert.match(view(), /Visible live answer/);
    assert.doesNotMatch(view(), /Working…/);
    const afterHandoff = redraw.mock.callCount();
    t.mock.timers.tick(800);
    assert.equal(redraw.mock.callCount(), afterHandoff, "visible output also stops the placeholder's animation");
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
    assert.equal(redraw.mock.callCount(), afterStop, "shutdown removes the inline placeholder and its timer");
    harness.runtime.stopSession();
    harness.runtime.startSession(harness.context);
    harness.runtime.attach(nativeRoot);
    assert.doesNotMatch(view(), /Working…/, "a subsequent session starts idle");
    harness.startWork();
    assert.match(view(), /Working…/);
    harness.endWork();
    assert.doesNotMatch(view(), /Working…/);
});

test("transcript display does not add a working placeholder outside a terminal UI", () => {
    for (const mode of ["rpc", "json", "print"] as const) {
        const harness = createHarness(new TestTui(), mode);
        harness.startWork();
        assert.deepEqual(harness.root.render(80), []);
        assert.deepEqual(harness.dock.render(80), []);
        harness.close();
    }
});

test("hidden retains five finished compact rows on either slot without counting active calls", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    for (const expanded of [false, true]) {
        const harness = createHarness();
        t.after(() => harness.close());
        harness.expanded = expanded;
        harness.rows.modes.setViews(
            expanded ? ToolDisplayMode.FULL : ToolDisplayMode.HIDDEN,
            expanded ? ToolDisplayMode.HIDDEN : ToolDisplayMode.FULL,
        );
        const calls = Array.from({length: 9}, (_, index) => {
            const row = harness.read(`call-${index}`);
            row.setExpanded(expanded);
            harness.root.addChild(row);
            return row;
        });
        harness.startWork();
        harness.root.render(80);
        for (let index = 0; index < 7; index++) {
            calls[index]!.updateResult({content: [{type: "text", text: `finished output ${index}`}], isError: index % 2 === 0});
        }
        calls[7]!.updateResult({content: [{type: "text", text: "active partial output"}], isError: false}, true);
        const view = () => plain(harness.root.render(80));
        assert.deepEqual(view().match(/read \| call-\d/g), [2, 3, 4, 5, 6, 7, 8].map((index) => `read | call-${index}`));
        assert.match(view(), /active partial output/);
        assert.doesNotMatch(view(), /finished output|Working…/);
        assert.deepEqual(calls[0]!.render(80), [], "evicted calls leave no spacer rows");
        for (const index of [7, 8]) calls[index]!.updateResult({content: [], isError: true});
        assert.deepEqual(view().match(/read \| call-\d/g), [4, 5, 6, 7, 8].map((index) => `read | call-${index}`));
        assert.match(view(), /Working…/, "retained finished calls do not suppress live progress");
        harness.endWork();
        harness.startWork();
        assert.deepEqual(view().match(/read \| call-\d/g), [4, 5, 6, 7, 8].map((index) => `read | call-${index}`));
        assert.match(view(), /Working…/, "the rolling window survives agent turns");
    }
});

test("hidden ranks live completions before rendering and keeps ranks through redraws, toggles, and rebuilds", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const harness = createHarness();
    t.after(() => harness.close());
    harness.rows.modes.setViews(ToolDisplayMode.FULL, ToolDisplayMode.TRUNCATED);
    harness.startWork();
    const calls = Array.from({length: 8}, (_, index) => {
        const row = harness.read(`ordered-${index}`);
        harness.root.addChild(row);
        return row;
    });
    for (let index = 7; index >= 0; index--) harness.endTool(`ordered-${index}`);
    // Pi can publish parallel results in invocation order, not completion order.
    for (const row of calls) row.updateResult({content: [{type: "text", text: "preserved full output"}], isError: false});
    harness.endWork();
    const view = () => plain(harness.root.render(80));
    const retained = () => view().match(/read \| ordered-\d/g);
    const expected = [0, 1, 2, 3, 4].map((index) => `read | ordered-${index}`);
    harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    assert.deepEqual(retained(), expected, "completion tracking is independent of the selected view");
    harness.startTool("nested", "ordered-0");
    harness.endTool("nested", "ordered-0");
    calls[7]!.updateResult({content: [], isError: true});
    harness.root.invalidate();
    assert.deepEqual(retained(), expected, "repeated final updates and nested completions do not promote old rows");
    harness.rows.toggle("ordered-0");
    assert.doesNotMatch(view(), /preserved full output/, "row-local full overrides cannot bypass hidden compactness");
    calls[7]!.setExpanded(true);
    assert.match(view(), /read \| ordered-7/);
    calls[7]!.setExpanded(false);
    assert.deepEqual(retained(), expected, "a native row toggle does not change the window");
    harness.rows.modes.setViews(ToolDisplayMode.FULL, ToolDisplayMode.TRUNCATED);
    assert.equal(retained()?.length, 8);
    harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    assert.deepEqual(retained(), expected);
    harness.root.clear();
    harness.rows.clear();
    for (let index = 0; index < 8; index++) {
        const row = harness.read(`ordered-${index}`);
        row.updateResult({content: [], isError: false});
        harness.root.addChild(row);
    }
    assert.deepEqual(retained(), expected, "same-session rebuilt rows retain their known completion order");
});

test("hidden bootstraps restored history, ignores detached rows, and resets completion ranks between sessions", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const nativeRoot = new TestTui();
    const harness = createHarness(nativeRoot);
    t.after(() => harness.close());
    const calls = Array.from({length: 8}, (_, index) => {
        const row = harness.read(`history-${index}`);
        row.updateResult({content: [{type: "text", text: "historical output"}], isError: false});
        harness.root.addChild(row);
        return row;
    });
    const retained = () => plain(harness.root.render(80)).match(/read \| history-\d/g);
    assert.deepEqual(retained(), [3, 4, 5, 6, 7].map((index) => `read | history-${index}`));
    calls[0]!.updateResult({content: [], isError: true});
    assert.deepEqual(retained(), [3, 4, 5, 6, 7].map((index) => `read | history-${index}`),
        "repeated historical results do not become new live completions");
    harness.root.removeChild(calls[7]!);
    assert.deepEqual(retained(), [2, 3, 4, 5, 6].map((index) => `read | history-${index}`));
    harness.runtime.stopSession();
    harness.root.clear();
    harness.rows.clear();
    harness.runtime.startSession(harness.context);
    harness.runtime.attach(nativeRoot);
    harness.startWork();
    for (let index = 7; index >= 0; index--) harness.endTool(`history-${index}`);
    for (let index = 0; index < 8; index++) {
        const row = harness.read(`history-${index}`);
        row.updateResult({content: [], isError: false});
        harness.root.addChild(row);
    }
    assert.deepEqual(retained(), [0, 1, 2, 3, 4].map((index) => `read | history-${index}`));
});

test("late-discovered history cannot evict a more recent live completion", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const harness = createHarness();
    t.after(() => harness.close());
    for (let index = 0; index < 6; index++) {
        const row = harness.read(`old-${index}`);
        row.updateResult({content: [], isError: false});
        harness.root.addChild(row);
    }
    harness.startWork();
    const newest = harness.read("live-newest");
    harness.root.addChild(newest);
    harness.endTool("live-newest");
    newest.updateResult({content: [], isError: false});
    const view = plain(harness.root.render(80));
    assert.match(view, /read \| live-newest/);
    assert.deepEqual(view.match(/read \| old-\d/g), [2, 3, 4, 5].map((index) => `read | old-${index}`));
});

test("streamed calls finalized by abort or error before their first frame still count as recent live finishes", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    for (const stopReason of ["aborted", "error"] as const) {
        const harness = createHarness();
        t.after(() => harness.close());
        harness.startWork();
        for (let index = 0; index < 5; index++) {
            const row = harness.read(`prior-${index}`);
            harness.endTool(`prior-${index}`);
            row.updateResult({content: [], isError: false});
            harness.root.addChild(row);
        }
        harness.root.render(80);
        const row = harness.read("synthetic-finish");
        const block: AssistantMessage["content"][number] = {
            type: "toolCall", id: "synthetic-finish", name: "read", arguments: {path: "synthetic-finish"},
        };
        harness.updateMessage(assistant([block], "pending"));
        harness.root.addChild(row);
        harness.endMessage(assistant([block], stopReason));
        row.updateResult({content: [{type: "text", text: "synthetic error details"}], isError: true});
        harness.endWork();
        const view = plain(harness.root.render(80));
        assert.match(view, /read \| synthetic-finish/);
        assert.doesNotMatch(view, /prior-0|synthetic error details/);
        assert.deepEqual(view.match(/read \| prior-\d/g), [1, 2, 3, 4].map((index) => `read | prior-${index}`));
    }
});

test("hidden never exposes finished output from foreign, incomplete, or unavailable renderers", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
    const call: ToolRenderers["renderCall"] = () => new Text("external argument body", 0, 0);
    const result: ToolRenderers["renderResult"] = () => new Text("external result body", 0, 0);
    const fixtures: Array<ToolRenderers | undefined> = [
        undefined,
        {renderResult: result},
        {renderCall: call},
        {renderShell: "self", renderCall: call, renderResult: result},
        {renderShell: "self", renderCall: call, renderResult() { throw new Error("render failure"); }},
    ];
    for (const renderers of fixtures) {
        const harness = createHarness();
        t.after(() => harness.close());
        const row = harness.tool("external", "foreign", renderers);
        harness.root.addChild(row);
        harness.root.render(80);
        if (renderers?.renderCall) assert.match(plain(row.render(80)), /external argument body/);
        row.updateResult({content: [{type: "text", text: "finished private output"}], isError: false});
        const view = plain(harness.root.render(80));
        assert.doesNotMatch(view, /external argument body|external result body|finished private output/);
        if (renderers?.renderCall && renderers.renderResult) {
            assert.equal(view.trim(), "external", "foreign tools with complete renderers retain a generic compact header");
        } else {
            assert.deepEqual(row.render(80), [], "incomplete or unidentified finished rows remain suppressed");
        }
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
    assert.equal(plain(harness.root.render(80)).trim(), "read | completed-image",
        "historical image rows retain only their compact header");
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
    assert.equal(harness.root.render(80).some((line) => line.includes("\x1b_G")), false);
    assert.match(plain(harness.root.render(80)), /read \| active-image/);
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
                assert.match(plain(before), /row-local output/, "hidden active rows retain truncated partial text");
                assert.match(plain(toggled), /row-local output/);
                assert.equal(toggled.some((line) => line.includes("\x1b_G")), globallyHidden,
                    "tool images remain suppressed in the hidden slot, including during execution");
                row.updateResult(result);
                const completed = harness.root.render(80);
                if (globallyHidden) {
                    assert.match(plain(completed), /row-local output/);
                    assert.ok(completed.some((line) => line.includes("\x1b_G")));
                } else {
                    assert.equal(plain(completed).trim(), "read | mouse-toggle");
                    assert.equal(completed.some((line) => line.includes("\x1b_G")), false);
                    clickToolHeader(row);
                    assert.match(plain(harness.root.render(80)), /row-local output/,
                        "retained compact headers preserve native mouse expansion");
                    assert.ok(harness.root.render(80).some((line) => line.includes("\x1b_G")));
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
    assert.equal(plain(harness.root.render(80)).trim(), "read | already-expanded");
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
    assert.match(plain(root.getScreenLines()), /read \| fullscreen-active/);
    assert.doesNotMatch(plain(root.getScreenLines()), /completed private output/);
    assert.match(plain(root.getScreenLines()), /Working…/);
    for (let index = 0; index < 6; index++) {
        const row = harness.read(`fullscreen-finished-${index}`);
        harness.endTool(`fullscreen-finished-${index}`);
        row.updateResult({content: [], isError: false});
        harness.root.addChild(row);
    }
    root.requestRender();
    root.renderNow();
    const finished = plain(root.getScreenLines());
    assert.doesNotMatch(finished, /fullscreen-active|fullscreen-finished-0/);
    assert.deepEqual(finished.match(/read \| fullscreen-finished-\d/g),
        [1, 2, 3, 4, 5].map((index) => `read | fullscreen-finished-${index}`));
    assert.match(finished, /Working…/);
    harness.expanded = true;
    active.setExpanded(true);
    root.requestRender();
    root.renderNow();
    assert.match(plain(root.getScreenLines()), /must not flash/);
    assert.match(plain(root.getScreenLines()), /completed private output/);
});

test("fullscreen scrolls the working placeholder with conversation instead of pinning it beside the editor", (t) => {
    t.mock.timers.enable({apis: ["setInterval", "setTimeout"]});
    const root = new TuiAltScreen(new TestTui().terminal, false, undefined, {mouse: false});
    const harness = createHarness(root);
    const editor = new Container();
    editor.addChild(new Text("EDITOR", 0, 0));
    harness.dock.addChild(new Text("ABOVE-EDITOR WIDGET", 0, 0));
    const viewport = createChatViewport({
        document: harness.root,
        pendingMessages: new Container(),
        status: new Container(),
        widgetsAbove: harness.dock,
        editor,
        footer: new Container(),
        scrollbar: "hidden",
    });
    root.setLayoutRoot(viewport.root);
    harness.root.addChild(new Text(Array.from({length: 50}, (_, i) => `Earlier message ${i}`).join("\n"), 0, 0));
    root.start();
    t.after(() => { root.stop({preserveScreen: true}); harness.close(); });
    harness.startWork();
    root.renderNow();
    const view = () => plain(root.getScreenLines());
    assert.match(view(), /Working…/);
    assert.match(view(), /EDITOR/);
    assert.ok(view().indexOf("Working…") < view().indexOf("ABOVE-EDITOR WIDGET"));
    viewport.transcript.scrollToStart();
    root.renderNow();
    assert.match(view(), /Earlier message 0/);
    assert.doesNotMatch(view(), /Working…/, "the placeholder scrolls out of view with tool/message rows");
    assert.match(view(), /ABOVE-EDITOR WIDGET/);
    assert.match(view(), /EDITOR/);
    viewport.transcript.scrollToEnd();
    root.renderNow();
    assert.match(view(), /Working…/);
    const response = new AssistantMessageComponent(assistant([{type: "text", text: "Visible response"}], "pending"));
    harness.root.addChild(response);
    root.requestRender();
    root.renderNow();
    assert.match(view(), /Visible response/);
    assert.doesNotMatch(view(), /Working…/);
});

test("transcript projection survives a stable TUI facade replacing its renderer without modifying facade methods", (t) => {
    t.mock.timers.enable({apis: ["setInterval"]});
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
    assert.equal(plain(current.render(80)).trim(), "Thinking");
    harness.startWork();
    assert.match(plain(current.render(80)), /Working…/);
    const sources = [...current.children];
    current = new TestTui();
    for (const source of sources) current.addChild(source);
    harness.runtime.attach(facade);
    harness.root.addChild(new AssistantMessageComponent(assistant([{type: "thinking", thinking: "new thought"}])));
    assert.equal(plain(current.render(80)).match(/Working…/g)?.length, 1);
    assert.doesNotMatch(plain(harness.dock.render(80)), /Working…/);
    harness.rows.modes.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
    assert.match(plain(current.render(80)), /retained thought/);
    assert.match(plain(current.render(80)), /new thought/);
    harness.rows.modes.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    assert.match(plain(current.render(80)), /Working…/);
    harness.runtime.stopSession();
    assert.doesNotMatch(plain(current.render(80)), /Working…/);
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
    const dock = new Container();
    root.addChild(transcript);
    root.addChild(dock);
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
    const sessionManager = SessionManager.inMemory();
    const context = {hasUI: true, mode, sessionManager, ui: {
        theme, getToolsExpanded: () => expanded, notify() {},
        setWidget() { assert.fail("the working placeholder must not install an editor widget"); },
    }} as unknown as ExtensionContext;
    const runtime = new TranscriptDisplayRuntime(pi, rows);
    runtime.register();
    runtime.startSession(context);
    runtime.attach(root);
    const read = new ReadTool(pi, () => assert.fail("rendering must not execute tools"), rows).toolDefinition();
    const tool = (name: string, id: string, renderers: ToolRenderers | undefined) => (
        new ToolExecutionComponent(name, id, {path: id}, {outputPad: 0}, resolver(name, () => renderers), root, process.cwd())
    );
    return {
        root: transcript,
        dock,
        rows, runtime, context, sessionManager,
        startMessage(message: AssistantMessage) { events.get("message_start")?.({type: "message_start", message}); },
        endTurn(message: AssistantMessage, messageEntryId: string) {
            events.get("turn_end")?.({type: "turn_end", turnIndex: 0, message, messageEntryId,
                toolResults: [], toolResultEntryIds: []});
        },
        startWork() { events.get("agent_start")?.({type: "agent_start"}); },
        endWork() { events.get("agent_end")?.({type: "agent_end", messages: []}); },
        updateMessage(message: AssistantMessage, assistantMessageEvent?: MessageUpdateEvent["assistantMessageEvent"]) {
            events.get("message_update")?.({type: "message_update", message, assistantMessageEvent});
        },
        endMessage(message: AssistantMessage) { events.get("message_end")?.({type: "message_end", message}); },
        startTool(toolCallId: string, parentToolCallId?: string) {
            events.get("tool_execution_start")?.({type: "tool_execution_start", toolCallId, parentToolCallId});
        },
        endTool(toolCallId: string, parentToolCallId?: string) {
            events.get("tool_execution_end")?.({type: "tool_execution_end", toolCallId, parentToolCallId});
        },
        get expanded() { return expanded; },
        set expanded(value: boolean) { expanded = value; },
        tool,
        read(id: string) { return tool("read", id, read); },
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
