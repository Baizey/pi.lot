import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {initTheme, SessionManager, type ExtensionAPI, type ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import type {Component, TUI} from "@earendil-works/pi-tui";
import {theme} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {PolicyDefaultsCommand} from "../src/commands/PolicyDefaultsCommand.js";
import {SubagentDefaultsCommand} from "../src/commands/SubagentDefaultsCommand.js";
import {ServerCommand} from "../src/commands/ServerCommand.js";
import {DisplayCommand} from "../src/commands/DisplayCommand.js";
import {initialPolicyDefaults, type ResponseDefaults} from "../src/policy/defaults.js";
import {PolicyArea, PolicyFallbackResponse} from "../src/policy/types.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {initialSubagentDefaults, SubagentDefaultsRuntime} from "../src/subagents/SubagentDefaults.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";
import {ServerService} from "../src/server/ServerService.js";
import {PolicyDefaultsSettings} from "../src/tui/PolicyDefaultsSettings.js";
import {SubagentDefaultsSettings} from "../src/tui/subagent/SubagentDefaultsSettings.js";
import {ServerSettings} from "../src/tui/ServerSettings.js";
import {DisplaySettings} from "../src/tui/tool/DisplaySettings.js";
import {DisplayDefaultsRuntime, initialDisplayDefaults} from "../src/tui/tool/DisplayDefaults.js";
import {ToolDisplayModes} from "../src/tui/tool/ToolDisplayModes.js";
import {ToolDisplayMode} from "../src/tui/tool/ToolDisplayMode.js";
import {displayWidth} from "../src/tui/terminalText.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function register(setup: (pi: ExtensionAPI) => void): Command {
    let result: Command | undefined;
    setup({registerCommand(_name: string, command: Command) { result = command; }} as ExtensionAPI);
    assert.ok(result);
    return result;
}

function context(t: TestContext) {
    initTheme("dark");
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-settings-ui-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const notifications: Array<{message: string; type?: string}> = [];
    const ctx = {
        hasUI: true, mode: "tui", sessionManager: SessionManager.inMemory(directory),
        ui: {
            get theme() { return theme; },
            notify(message: string, type?: string) { notifications.push({message, type}); },
            async input() { return undefined; },
            custom() { assert.fail("Unexpected picker"); },
        },
    } as unknown as ExtensionCommandContext;
    return {ctx, directory, notifications};
}

function picker(t: TestContext, ctx: ExtensionCommandContext, inspect: (component: Component, closed: () => boolean) => void) {
    return t.mock.method(ctx.ui, "custom", async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
        let closed = false;
        let selected: unknown;
        const component = await factory({requestRender() {}} as TUI, ctx.ui.theme, {} as Parameters<typeof factory>[2], (value) => {
            closed = true;
            selected = value;
        });
        inspect(component, () => closed);
        assert.equal(closed, true, "the picker must explicitly close");
        return selected;
    });
}

function move(component: Component, count: number): void {
    for (let index = 0; index < Math.abs(count); index++) component.handleInput!(count > 0 ? "\x1b[B" : "\x1b[A");
}

function plain(component: Component): string {
    return component.render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function narrow(component: Component): void {
    for (const width of [1, 2, 8, 20, 100]) {
        assert.ok(component.render(width).every((line) => displayWidth(line) <= width), `width ${width}`);
    }
}

test("policy no-args picker chooses without transient changes, saves explicitly, and reloads live rows", async (t) => {
    const {ctx, notifications} = context(t);
    let saved: ResponseDefaults = structuredClone(initialPolicyDefaults);
    let saves = 0;
    const runtime = new PilotSessionRuntime(ctx, {
        openDatabase: () => SqliteDatabase.test(false, ":memory:"),
        policyDefaultsStore: {load: () => structuredClone(saved), save(value) { saved = structuredClone(value); saves++; }},
        credentialIpcConfigStore: {load: () => ({})},
    });
    t.after(() => runtime.close());
    const command = register((pi) => new PolicyDefaultsCommand(pi, () => runtime).register());
    picker(t, ctx, (component) => {
        assert.ok(component instanceof PolicyDefaultsSettings);
        assert.match(plain(component), /fs_read\s+allow/);
        assert.match(plain(component), /explicit rules/);
        component.handleInput("\r");
        move(component, 1); // Highlight deny, but do not apply it yet.
        assert.equal(runtime.policyRuntime.defaultResponses.fs_read, PolicyFallbackResponse.allow);
        component.handleInput("\x1b");
        assert.equal(runtime.policyRuntime.defaultResponses.fs_read, PolicyFallbackResponse.allow);
        component.handleInput("\r");
        move(component, 1);
        component.handleInput("\r");
        assert.equal(runtime.policyRuntime.defaultResponses.fs_read, PolicyFallbackResponse.deny);
        assert.equal(saves, 0);
        move(component, Object.values(PolicyArea).length); // Save
        component.handleInput("\r");
        assert.equal(saves, 1);
        assert.equal(saved.fs_read, PolicyFallbackResponse.deny);
        move(component, -Object.values(PolicyArea).length); // fs_read
        component.handleInput("\r");
        move(component, 1); // deny -> ask_user
        component.handleInput("\r");
        assert.equal(runtime.policyRuntime.defaultResponses.fs_read, PolicyFallbackResponse.ask_user);
        move(component, Object.values(PolicyArea).length + 1); // Reload
        component.handleInput("\r");
        assert.equal(runtime.policyRuntime.defaultResponses.fs_read, PolicyFallbackResponse.deny);
        move(component, -(Object.values(PolicyArea).length + 1));
        assert.match(plain(component), /fs_read\s+deny/);
        narrow(component);
        component.handleInput("\x1b");
    });
    await command.handler("", ctx);
    assert.equal(saves, 1);
    assert.equal(notifications.at(-1)!.message, "Reset policy defaults.");
});

test("subagent no-args picker searches models, preserves unavailable pins on cancel, and saves/reloads mappings", async (t) => {
    const {ctx} = context(t);
    let saved = {...initialSubagentDefaults, high: "missing/offline"};
    let saves = 0;
    const defaults = new SubagentDefaultsRuntime({
        load: () => ({...saved}), save(value) { saved = {...value}; saves++; },
    });
    const command = register((pi) => new SubagentDefaultsCommand(pi, () => defaults,
        () => ["provider/cheap", "provider/strong"], async (skill) => `provider/${skill}`).register());
    picker(t, ctx, (component) => {
        assert.ok(component instanceof SubagentDefaultsSettings);
        assert.match(plain(component), /provider\/min/);
        move(component, 3); // high
        component.handleInput("\r");
        assert.match(plain(component), /missing\/offline/);
        component.handleInput("\x1b");
        assert.equal(defaults.values.high, "missing/offline");
        move(component, -1); // mid
        component.handleInput("\r");
        for (const char of "STRONG") component.handleInput(char);
        assert.match(plain(component), /provider\/strong/);
        assert.doesNotMatch(plain(component), /provider\/cheap/);
        component.handleInput("\r");
        assert.equal(defaults.values.mid, "provider/strong");
        assert.equal(saves, 0);
        move(component, 3); // Save
        component.handleInput("\r");
        assert.equal(saves, 1);
        move(component, -3); // mid
        component.handleInput("\r");
        for (const char of "auto") component.handleInput(char);
        component.handleInput("\r");
        assert.equal(defaults.values.mid, "auto");
        move(component, 4); // Reload
        component.handleInput("\r");
        assert.equal(defaults.values.mid, "provider/strong");
        assert.equal(defaults.values.high, "missing/offline");
        narrow(component);
        component.handleInput("\x1b");
    });
    await command.handler("", ctx);
});

test("display no-args picker offers save/reload without toggling the active view", async (t) => {
    const {ctx} = context(t);
    let saved = {...initialDisplayDefaults};
    let saves = 0;
    const defaults = new DisplayDefaultsRuntime(new ToolDisplayModes(), {
        load: () => ({...saved}), save(value) { saved = {...value}; saves++; },
    });
    defaults.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.FULL);
    const command = register((pi) => new DisplayCommand(pi, () => defaults).register());
    picker(t, ctx, (component) => {
        assert.ok(component instanceof DisplaySettings);
        assert.match(plain(component), /Save defaults/);
        move(component, 2); // Save
        component.handleInput("\r");
        assert.equal(saves, 1);
        move(component, -2); // Normal
        component.handleInput("\r");
        move(component, 1); // Conversation -> Compact
        component.handleInput("\r");
        assert.equal(defaults.values.normal, ToolDisplayMode.MINIMAL);
        move(component, 3); // Reload
        component.handleInput("\r");
        assert.deepEqual(defaults.values, {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.FULL});
        narrow(component);
        component.handleInput("\x1b");
    });
    await command.handler("", ctx);
});

const CONFIG = {url: "https://settings.example.test", apiKey: "private-settings-key"};

for (const action of ["status", "login", "logout", "upload current", "upload all", "sync", "sync on", "sync off", "recover"] as const) {
    test(`server no-args menu dispatches ${action} only after closing the picker`, async (t) => {
        const {ctx, directory, notifications} = context(t);
        ctx.sessionManager = SessionManager.create(directory, path.join(directory, "sessions"));
        const store = new ServerConfigStore(directory);
        store.save(CONFIG);
        const calls: string[] = [];
        let closed = false;
        const server = new ServerService(store, async () => {
            assert.equal(closed, true);
            calls.push("status");
            return {kind: "compatible", version: "0.4.0"};
        });
        t.mock.method(server.background, "initialize", async () => { assert.equal(closed, true); });
        t.mock.method(server.background, "enqueue", async (...[source]: Parameters<typeof server.background.enqueue>) => {
            assert.equal(closed, true); calls.push(`upload ${source.scope}`); return {queued: true as const};
        });
        t.mock.method(server.configuration, "synchronize", async () => {
            assert.equal(closed, true); calls.push("sync"); return {kind: "complete" as const, items: []};
        });
        t.mock.method(server.configuration, "enableAutomatic", async () => {
            assert.equal(closed, true); calls.push("sync on"); return {kind: "complete" as const, items: []};
        });
        t.mock.method(server.configuration, "disableAutomatic", () => { assert.equal(closed, true); calls.push("sync off"); });
        t.mock.method(server.configuration, "recover", async (...[key, direction]: Parameters<typeof server.configuration.recover>) => {
            assert.equal(closed, true); calls.push(`recover ${key} ${direction}`); return {kind: "complete" as const, items: []};
        });
        const answers = ["https://replacement.example.test", "replacement-key"];
        t.mock.method(ctx.ui, "input", async () => { assert.equal(closed, true); return answers.shift(); });
        const command = register((pi) => new ServerCommand(pi, server).register());
        picker(t, ctx, (component, isClosed) => {
            assert.ok(component instanceof ServerSettings);
            assert.equal(calls.length, 0);
            assert.match(plain(component), /opening this menu sends nothing/);
            assert.doesNotMatch(plain(component), /private-settings-key/);
            if (action === "status" || action === "login" || action === "logout") {
                move(component, ["status", "login", "logout"].indexOf(action));
                component.handleInput("\r");
            } else if (action.startsWith("upload")) {
                move(component, 3);
                component.handleInput("\r");
                if (action === "upload all") move(component, 1);
                component.handleInput("\r");
            } else if (action === "recover") {
                move(component, 5);
                component.handleInput("\r");
                component.handleInput("\x1b"); // Return from recovery, not the whole menu.
                assert.equal(isClosed(), false);
                component.handleInput("\r");
                component.handleInput("\r"); // display-defaults
                move(component, 1); // server
                component.handleInput("\r");
            } else {
                move(component, 4);
                component.handleInput("\r");
                move(component, ["sync", "sync on", "sync off"].indexOf(action));
                component.handleInput("\r");
            }
            closed = isClosed();
            assert.equal(closed, true);
        });
        await command.handler("", ctx);
        if (action === "login") {
            assert.equal(answers.length, 0);
            assert.equal(store.load()!.url, "https://replacement.example.test");
        }
        else if (action === "logout") assert.equal(store.load(), undefined);
        else assert.deepEqual(calls, [action === "recover" ? "recover display-defaults server" : action]);
        if (action !== "status") assert.doesNotMatch(JSON.stringify(notifications), /private-settings-key/);
    });
}

test("cancelling or superseding a server picker never dispatches an action or exposes credentials", async (t) => {
    const {ctx, directory, notifications} = context(t);
    const store = new ServerConfigStore(directory);
    store.save(CONFIG);
    const server = new ServerService(store);
    const enqueue = t.mock.method(server.background, "enqueue", async () => ({queued: true as const}));
    t.mock.method(server.background, "initialize", async () => {});
    const command = register((pi) => new ServerCommand(pi, server).register());
    const screen = picker(t, ctx, (component) => {
        assert.ok(component instanceof ServerSettings);
        narrow(component);
        component.handleInput("\x1b");
    });
    await command.handler("", ctx);
    assert.deepEqual(notifications, []);
    assert.deepEqual(store.load(), CONFIG);
    screen.mock.restore();
    let lateSelection: ((value: unknown) => void) | undefined;
    t.mock.method(ctx.ui, "custom", async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => (
        new Promise((resolve) => {
            lateSelection = resolve;
            void factory({requestRender() {}} as TUI, ctx.ui.theme, {} as Parameters<typeof factory>[2], resolve);
        })
    ));
    const pending = command.handler("", ctx);
    assert.ok(lateSelection);
    await command.handler("logout", ctx);
    lateSelection("upload all");
    await pending;
    assert.equal(store.load(), undefined);
    assert.equal(enqueue.mock.callCount(), 0);
    assert.equal(notifications.length, 1);
    assert.doesNotMatch(JSON.stringify(notifications), /private-settings-key/);
});

for (const mode of ["rpc", "print"] as const) {
    test(`server no-args preserves status output in ${mode} without a terminal picker`, async (t) => {
        const {ctx, directory, notifications} = context(t);
        ctx.mode = mode;
        const server = new ServerService(new ServerConfigStore(directory));
        const command = register((pi) => new ServerCommand(pi, server).register());
        await command.handler("", ctx);
        assert.deepEqual(notifications, [{message: "Config: none\nStatus: Not configured.", type: "info"}]);
    });
}
