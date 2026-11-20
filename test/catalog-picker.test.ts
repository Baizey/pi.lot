import assert from "node:assert/strict";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";
import {initTheme, SessionManager, type ExtensionAPI, type ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {CURSOR_MARKER, getKeybindings, isKittyProtocolActive, KeybindingsManager, setKeybindings,
    setKittyProtocolActive, TUI_KEYBINDINGS, visibleWidth, type TUI} from "@earendil-works/pi-tui";
import {theme} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {PersonaCommand} from "../src/personas/PersonaCommand.js";
import type {PersonaStore} from "../src/personas/PersonaStore.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import type PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {PolicyArea, PolicyFallbackResponse} from "../src/policy/types.js";
import {RoleCommand} from "../src/roles/RoleCommand.js";
import type {RoleLibrary} from "../src/roles/RoleStore.js";
import {PolicyDefaultsSettings} from "../src/tui/PolicyDefaultsSettings.js";
import {SettingsChoice} from "../src/tui/SettingsChoice.js";

const enter = "\r", esc = "\x1b", down = "\x1b[B", backspace = "\x7f";
const lateId = "a1234567-1234-4234-8234-0123456789ab";
const earlyId = "b1234567-1234-4234-8234-0123456789ab";
const plain = (component: {render(width: number): string[]}) => stripVTControlCharacters(component.render(80).join("\n"));
const type = (component: {handleInput(key: string): void}, text: string) => {
    for (const key of text) component.handleInput(key);
};

function harness() {
    initTheme("dark");
    const sessionManager = SessionManager.inMemory();
    let command: Parameters<ExtensionAPI["registerCommand"]>[1];
    let picker: SettingsChoice | undefined;
    let redraws = 0;
    let toolsExpanded = false;
    const notifications: string[] = [];
    const pi = {
        on() {},
        registerCommand(_name: string, definition: typeof command) { command = definition; },
        appendEntry: sessionManager.appendCustomEntry.bind(sessionManager),
        sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0]) {
            sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        },
    } as unknown as ExtensionAPI;
    const ctx = {mode: "tui", hasUI: true, sessionManager, isIdle: () => true, ui: {
        notify(message: string) { notifications.push(message); },
        getToolsExpanded: () => toolsExpanded,
        setToolsExpanded: (value: boolean) => { toolsExpanded = value; },
        custom: (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => new Promise((done) => {
            const keys = getKeybindings() as Parameters<typeof factory>[2];
            const component = factory({requestRender() { redraws++; }} as TUI, theme, keys, done);
            if (component instanceof SettingsChoice) picker = component;
        }),
    }} as unknown as ExtensionCommandContext;
    const run = async (args: string) => command.handler(args, ctx);
    function open() {
        picker = undefined;
        const closed = run("");
        assert.ok(picker);
        const component: SettingsChoice = picker;
        component.focused = true;
        return {component, closed};
    }
    return {pi, ctx, run, open, notifications, redraws: () => redraws};
}

test("bare /persona filters names in place, navigates results by stable ID, saves, clears, and reloads", async () => {
    const ui = harness();
    const personas = [{id: lateId, name: "Quiet Scout", prompt: "Be concise."},
        {id: earlyId, name: "Quiet Analyst", prompt: "Analyze carefully."},
        {id: "d1234567-1234-4234-8234-0123456789ab", name: "Save as default", prompt: "Keep the usual style."}];
    let defaultId: string | null = null;
    new PersonaCommand(ui.pi, {
        catalog: () => ({personas}), defaultId: () => defaultId,
        saveDefault: (id: string | null) => { defaultId = id; },
    } as PersonaStore).register();
    const select = async (query: string, navigate = "") => {
        const {component, closed} = ui.open();
        type(component, query);
        if (navigate) component.handleInput(navigate);
        component.handleInput(enter);
        await closed;
    };

    const {component, closed} = ui.open();
    assert.match(plain(component), /→ ✓ Off/);
    assert.ok(component.render(80).some((line) => line.includes(CURSOR_MARKER)));
    component.focused = false;
    assert.ok(component.render(80).every((line) => !line.includes(CURSOR_MARKER)));
    component.focused = true;
    type(component, "quietzzz");
    assert.match(plain(component), /No matches/);
    component.handleInput(enter);
    assert.deepEqual(ui.ctx.sessionManager.getBranch(), []);
    type(component, backspace.repeat(8));
    assert.match(plain(component), /→ ✓ Off/);
    type(component, "quiet");
    assert.doesNotMatch(plain(component), /Off|Save as default/);
    component.handleInput(down);
    assert.match(plain(component), /→ Quiet Scout/);
    component.handleInput(enter);
    await closed;
    assert.ok(ui.redraws() > 0);
    const selection = () => {
        const entry = ui.ctx.sessionManager.getBranch().at(-1);
        return entry?.type === "custom_message" ? entry.details : undefined;
    };
    assert.deepEqual(selection(), {id: lateId, name: "Quiet Scout"});
    const saving = ui.open();
    type(saving.component, "save as default");
    assert.match(plain(saving.component), /→ Save as default\n  · Save as default/);
    saving.component.handleInput(down);
    saving.component.handleInput(enter);
    await saving.closed;
    assert.equal(defaultId, lateId);
    await select("off");
    assert.equal(selection(), null);
    await select("reload");
    assert.deepEqual(selection(), {id: lateId, name: "Quiet Scout"});
    const cancelled = ui.open();
    assert.match(plain(cancelled.component), /→ ✓ Quiet Scout/);
    type(cancelled.component, "off");
    cancelled.component.handleInput(esc);
    await cancelled.closed;
    assert.equal(ui.ctx.sessionManager.getBranch().length, 3);
    assert.deepEqual(selection(), {id: lateId, name: "Quiet Scout"});
});

test("bare /role filters by visible title and enters the selected role or None", async () => {
    const ui = harness();
    const reviewer = {id: lateId, title: "Careful Reviewer", text: "Review the patch."};
    const writer = {id: earlyId, title: "Project Writer", text: "Write a summary."};
    const longer = {id: "c1234567-1234-4234-8234-0123456789ab", title: "Careful Reviewer for Documentation", text: "Review docs."};
    const role = new RoleCommand(ui.pi, {catalog: () => ({roles: [reviewer, writer, longer]})} as RoleLibrary);
    role.register();
    const {component, closed} = ui.open();
    type(component, "reviewer");
    assert.match(plain(component), /→ Careful Reviewer/);
    assert.doesNotMatch(plain(component), /Project Writer|None/);
    for (const width of [1, 2, 8, 20, 80]) {
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
    component.handleInput(enter);
    await closed;
    assert.match(role.promptSection(ui.ctx) ?? "", /Careful Reviewer/);
    const cancelled = ui.open();
    type(cancelled.component, "careful reviewer");
    assert.match(plain(cancelled.component), /→ ✓ Careful Reviewer\n/);
    assert.match(plain(cancelled.component), /Careful Reviewer for Documentation/);
    cancelled.component.handleInput(esc);
    await cancelled.closed;
    assert.equal(ui.ctx.sessionManager.getBranch().length, 1);
    const cleared = ui.open();
    type(cleared.component, "none");
    cleared.component.handleInput(enter);
    await cleared.closed;
    assert.equal(role.promptSection(ui.ctx), undefined);

    ui.ctx.mode = "rpc";
    await ui.run("");
    assert.match(ui.notifications.at(-1) ?? "", /Available: None\n  Careful Reviewer/);
    await ui.run("Project Writer");
    assert.match(role.promptSection(ui.ctx) ?? "", /Project Writer/);
});

test("standalone picker preserves tool expansion and raw LF without bypassing remapped confirm", async (t) => {
    const ui = harness();
    const previous = getKeybindings(), kitty = isKittyProtocolActive();
    const keys = new KeybindingsManager({...TUI_KEYBINDINGS,
        "app.tools.expand": {defaultKeys: "ctrl+o", description: "Toggle tool output"},
    }, {"tui.select.confirm": "tab"});
    setKeybindings(keys);
    t.after(() => { setKeybindings(previous); setKittyProtocolActive(kitty); });
    const writer = {id: earlyId, title: "Writer", text: "Write a summary."};
    const role = new RoleCommand(ui.pi, {catalog: () => ({roles: [writer]})} as RoleLibrary);
    role.register();
    const {component, closed} = ui.open();
    type(component, "writer");
    component.handleInput("\x0f");
    assert.equal(ui.ctx.ui.getToolsExpanded(), true);
    component.handleInput(enter);
    component.handleInput("\n");
    assert.deepEqual(ui.ctx.sessionManager.getBranch(), []);
    component.handleInput("\t");
    await closed;
    assert.match(role.promptSection(ui.ctx) ?? "", /Writer/);

    keys.setUserBindings({});
    const clearing = ui.open();
    type(clearing.component, "none");
    setKittyProtocolActive(true);
    clearing.component.handleInput("\n");
    await clearing.closed;
    assert.equal(role.promptSection(ui.ctx), undefined);
});

test("the existing model-style settings submenu still filters its descriptions", () => {
    initTheme("dark");
    const selected: (string | undefined)[] = [];
    const picker = new SettingsChoice([
        {value: "auto", label: "auto", description: "Automatic model"},
        {value: "provider/model", label: "provider/model", description: "Authenticated model"},
    ], "auto", (value) => selected.push(value), {searchable: true});
    type(picker, "authenticated");
    assert.doesNotMatch(plain(picker), /Automatic model/);
    picker.handleInput(enter);
    assert.deepEqual(selected, ["provider/model"]);
});

test("policy defaults search retains the fixed response submenu and save/reload actions", () => {
    initTheme("dark");
    const defaultResponses = {...initialPolicyDefaults};
    let saved = 0, reloaded = 0, closed = 0;
    const runtime = {
        defaultResponses,
        setDefaultResponse: (area: PolicyArea, response: PolicyFallbackResponse) => { defaultResponses[area] = response; },
        saveDefaultResponses: () => { saved++; },
        resetDefaultResponses: () => { reloaded++; Object.assign(defaultResponses, initialPolicyDefaults); },
    } as PolicyRuntime;
    const settings = new PolicyDefaultsSettings(runtime, theme, () => { closed++; }, () => {}, () => {});
    const area = PolicyArea.fs_mmap_paths;
    type(settings, area);
    assert.match(plain(settings), /→ fs_mmap_paths/);
    settings.handleInput(enter);
    assert.doesNotMatch(plain(settings), /Type to filter|Save defaults/);
    settings.handleInput(esc);
    assert.equal(closed, 0);
    assert.deepEqual(defaultResponses, initialPolicyDefaults);
    settings.handleInput(enter);
    settings.handleInput(down);
    settings.handleInput(enter);
    assert.notEqual(defaultResponses[area], initialPolicyDefaults[area]);
    type(settings, backspace.repeat(area.length) + "save defaults");
    settings.handleInput(enter);
    type(settings, backspace.repeat("save defaults".length) + "reload");
    settings.handleInput(enter);
    assert.equal(saved, 1);
    assert.equal(reloaded, 1);
    assert.deepEqual(defaultResponses, initialPolicyDefaults);
    settings.handleInput(esc);
    assert.equal(closed, 1);
});
