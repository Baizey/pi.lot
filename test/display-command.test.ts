import assert from "node:assert/strict";
import test from "node:test";
import {initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import type {TUI} from "@earendil-works/pi-tui";
import {theme} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {DisplayCommand} from "../src/commands/DisplayCommand.js";
import {DisplayDefaultsRuntime, initialDisplayDefaults, type DisplayDefaultsStore} from "../src/tui/tool/DisplayDefaults.js";
import {DisplaySettings} from "../src/tui/tool/DisplaySettings.js";
import {ToolDisplayMode, type ToolDisplayViews} from "../src/tui/tool/ToolDisplayMode.js";
import {ToolDisplayModes} from "../src/tui/tool/ToolDisplayModes.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolArgumentPlacement} from "../src/tui/tool/ToolPresentation.js";
import {displayWidth} from "../src/tui/terminalText.js";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

test("display registers once and completes public mode names and persistence actions", async () => {
    const {command, register} = harness();
    assert.throws(register, /already registered/);
    const complete = command.getArgumentCompletions!;
    assert.deepEqual(await complete("s"), [{value: "save", label: "save"}]);
    assert.deepEqual(await complete("co"), [
        {value: "conversation", label: "Conversation"}, {value: "compact", label: "Compact"},
    ]);
    assert.deepEqual((await complete("compact "))?.map((item) => item.value), [
        "compact conversation", "compact compact", "compact preview", "compact full",
    ]);
    assert.deepEqual(await complete(" CONVERSATION F"), [{value: "conversation full", label: "Full"}]);
    assert.deepEqual(await complete("save "), []);
    assert.deepEqual(await complete("reset "), []);
    assert.deepEqual(await complete("compact full "), []);
    assert.equal(await complete("unknown "), null);
    assert.equal(await complete("compact unknown"), null);
});

test("display reports outside TUI, sets pairs atomically, and rejects invalid input without changes", async () => {
    const {command, defaults, ctx, notifications} = harness();
    await command.handler("", ctx);
    assert.equal(notifications.at(-1)?.message,
        "Display for this session:\nNormal view = Compact\nAlternate view = Preview");
    await command.handler(" CONVERSATION FULL ", ctx);
    assert.deepEqual(defaults.values, {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.FULL});
    assert.equal(notifications.at(-1)?.type, "info");
    for (const input of ["compact", "compact unknown", "unknown full", "compact full extra", "save extra", "reset extra"]) {
        await command.handler(input, ctx);
        assert.match(notifications.at(-1)?.message ?? "", /^Usage: \/display/);
        assert.equal(notifications.at(-1)?.type, "error");
        assert.deepEqual(defaults.values, {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.FULL});
    }
    await command.handler("compact compact", ctx);
    assert.deepEqual(defaults.values, {normal: ToolDisplayMode.MINIMAL, alternate: ToolDisplayMode.MINIMAL});
});

test("display save is explicit and reset reloads the last saved pair", async () => {
    const {command, defaults, store, ctx, notifications} = harness();
    await command.handler("conversation full", ctx);
    assert.deepEqual(store.load(), initialDisplayDefaults);
    await command.handler("save", ctx);
    assert.deepEqual(store.load(), defaults.values);
    assert.equal(notifications.at(-1)?.message, "Saved current display defaults to ~/.pilot/display-defaults.json.");
    await command.handler("compact preview", ctx);
    await command.handler("reset", ctx);
    assert.deepEqual(defaults.values, {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.FULL});
});

test("display reports persistence errors without replacing the current modes", async (t) => {
    const {command, defaults, store, ctx, notifications} = harness();
    await command.handler("conversation full", ctx);
    t.mock.method(store, "save", () => { throw new Error("Cannot save display preferences"); });
    t.mock.method(store, "load", () => { throw new Error("Invalid display preferences"); });
    await command.handler("save", ctx);
    assert.deepEqual(notifications.at(-1), {message: "Cannot save display preferences", type: "error"});
    await command.handler("reset", ctx);
    assert.deepEqual(notifications.at(-1), {message: "Invalid display preferences", type: "error"});
    assert.deepEqual(defaults.values, {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.FULL});
});

test("display opens the picker only for a terminal UI", async (t) => {
    initTheme("dark");
    const {command, ctx} = harness();
    let opened = 0;
    t.mock.method(ctx.ui, "custom", async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
        opened++;
        let closed = false;
        const picker = await factory({requestRender() {}} as TUI, ctx.ui.theme, {} as Parameters<typeof factory>[2], () => { closed = true; });
        assert.ok(picker instanceof DisplaySettings);
        assert.match(picker.render(80).join("\n"), /Normal view/);
        picker.handleInput?.("\x1b");
        assert.equal(closed, true);
    });
    await command.handler("", ctx);
    assert.equal(opened, 0);
    ctx.hasUI = true;
    ctx.mode = "rpc";
    await command.handler("", ctx);
    assert.equal(opened, 0);
    ctx.mode = "tui";
    await command.handler("", ctx);
    assert.equal(opened, 1);
});

test("display hot-swaps live rows on either active side without changing Pi's toggle", async () => {
    initTheme("dark");
    for (const expanded of [false, true]) {
        const rows = new ToolDisplayRows();
        const {command, ctx} = harness(rows.modes);
        const renderers = rows.bind<{purpose: string; code: string}>({
            toolName: "fixture",
            arguments: [
                {key: "purpose", placement: ToolArgumentPlacement.TITLE_PRIMARY},
                {key: "code", layout: ToolArgumentLayout.BLOCK},
            ],
        });
        const component = new ToolExecutionComponent("fixture", "call", {purpose: "Test", code: "script body"},
            {outputPad: 0}, renderers, {requestRender() {}} as TUI, process.cwd());
        component.setExpanded(expanded);
        component.updateResult({content: [{type: "text", text: "result details"}], isError: false});
        try {
            await command.handler("full full", ctx);
            assert.match(component.render(80).join("\n"), /result details/);
            await command.handler(expanded ? "full conversation" : "conversation full", ctx);
            assert.deepEqual(component.render(80), []);
            await command.handler(expanded ? "conversation compact" : "compact conversation", ctx);
            const lines = component.render(80).join("\n");
            assert.match(lines, /fixture.*Test/);
            assert.doesNotMatch(lines, /script body|result details/);
        } finally {
            rows.clear();
        }
    }
});

test("the picker shows title-only choices, preselects the slot's mode, applies immediately, and cancels submenus safely", () => {
    initTheme("dark");
    const {defaults, store, ctx} = harness();
    let closed = false;
    let redraws = 0;
    const picker = new DisplaySettings(defaults, ctx.ui.theme, () => { closed = true; }, () => { redraws++; });
    const plain = () => stripAnsi(picker.render(80).join("\n"));
    assert.match(plain(), /Normal view\s+Compact/);
    assert.match(plain(), /Alternate view\s+Preview/);
    picker.handleInput("\x1b[B"); // Alternate
    picker.handleInput("\r");
    assert.match(plain(), /Conversation/);
    assert.match(plain(), /Compact/);
    assert.match(plain(), /Preview/);
    assert.match(plain(), /Full/);
    assert.doesNotMatch(plain(), /Activity only|headers only|within display limits/);
    for (const width of [1, 2, 8, 20, 80]) {
        assert.ok(picker.render(width).every((line) => displayWidth(line) <= width), `open submenu exceeds width ${width}`);
    }
    picker.handleInput("\x1b[B"); // Preview was selected; now Full
    picker.handleInput("\r");
    assert.deepEqual(defaults.values, {normal: ToolDisplayMode.MINIMAL, alternate: ToolDisplayMode.FULL});
    assert.match(plain(), /Alternate view\s+Full/);
    assert.deepEqual(store.load(), initialDisplayDefaults);
    picker.handleInput("\r");
    picker.handleInput("\x1b[A");
    picker.handleInput("\x1b"); // Cancel only this submenu
    assert.equal(closed, false);
    assert.equal(defaults.values.alternate, ToolDisplayMode.FULL);
    picker.handleInput("\x1b[A"); // Normal
    picker.handleInput("\r");
    picker.handleInput("\x1b[A"); // Compact was selected; now Conversation
    picker.handleInput("\r");
    assert.equal(defaults.values.normal, ToolDisplayMode.HIDDEN);
    for (const width of [1, 2, 8, 20, 80]) {
        assert.ok(picker.render(width).every((line) => displayWidth(line) <= width));
    }
    picker.handleInput("\x1b");
    assert.equal(closed, true);
    assert.ok(redraws > 0);
});

function harness(modes = new ToolDisplayModes()) {
    let saved: ToolDisplayViews = {...initialDisplayDefaults};
    const store: DisplayDefaultsStore = {
        load: () => ({...saved}),
        save(views) { saved = {...views}; },
    };
    const defaults = new DisplayDefaultsRuntime(modes, store);
    let command: RegisteredCommand | undefined;
    const pi = {registerCommand(name: string, registered: RegisteredCommand) {
        assert.equal(name, "display");
        command = registered;
    }} as unknown as ExtensionAPI;
    const registration = new DisplayCommand(pi, () => defaults);
    registration.register();
    assert.ok(command);
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        hasUI: false,
        mode: "print",
        ui: {
            get theme() { return theme; },
            notify(message: string, type: string) { notifications.push({message, type}); },
            custom() { assert.fail("unexpected picker"); },
            setToolsExpanded() { assert.fail("display must not toggle the active side"); },
        },
    } as unknown as ExtensionCommandContext;
    return {command, defaults, store, ctx, notifications, register: () => registration.register()};
}

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
