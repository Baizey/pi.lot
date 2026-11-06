import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {TUI} from "@earendil-works/pi-tui";
import {theme} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {SandboxingCommand} from "../src/commands/SandboxingCommand.js";
import {SandboxingSettings} from "../src/tui/SandboxingSettings.js";
import {displayWidth} from "../src/tui/terminalText.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function session(t: TestContext): PilotSessionRuntime {
    const runtime = new PilotSessionRuntime({
        sessionManager: {getSessionId: () => "sandboxing-command-test"},
    } as ExtensionContext, {
        openDatabase: () => SqliteDatabase.test(false, ":memory:"),
        policyDefaultsStore: {
            load: () => structuredClone(initialPolicyDefaults),
            save() { throw new Error("Sandboxing settings must not persist policy defaults"); },
        },
        credentialIpcConfigStore: {load: () => ({})},
    });
    t.after(() => runtime.close());
    return runtime;
}

function harness(t: TestContext) {
    const runtime = session(t);
    let command: Command | undefined;
    let runtimeRequests = 0;
    const pi = {
        registerCommand(name: string, options: Command) {
            assert.equal(name, "sandboxing");
            command = options;
        },
    } as ExtensionAPI;
    const owner = new SandboxingCommand(pi, () => { runtimeRequests++; return runtime; });
    owner.register();
    assert.ok(command);
    const notifications: Array<{message: string; type?: string}> = [];
    const ctx = {
        hasUI: false, mode: "print",
        ui: {
            get theme() { return theme; },
            notify(message: string, type?: string) { notifications.push({message, type}); },
            custom() { assert.fail("Unexpected terminal UI"); },
        },
    } as unknown as ExtensionCommandContext;
    return {runtime, command, owner, ctx, notifications, runtimeRequests: () => runtimeRequests};
}

test("sandboxing defaults are session-local, reset on replacement, and independent", (t) => {
    const first = session(t);
    assert.ok(first.nativeFuseSessionBroker);
    assert.equal(first.writableMmap, false);
    assert.equal(first.fullNetworkInspection, true);
    first.setWritableMmap(true);
    assert.equal(first.fullNetworkInspection, true);
    first.setFullNetworkInspection(false);
    assert.equal(first.writableMmap, true);
    const replacement = session(t);
    assert.equal(replacement.writableMmap, false);
    assert.equal(replacement.fullNetworkInspection, true);
    first.setWritableMmap(false);
    assert.equal(first.fullNetworkInspection, false);
});

test("sandboxing registers once and completes settings and modes without opening a runtime", async (t) => {
    const {command, owner, runtimeRequests} = harness(t);
    assert.throws(() => owner.register(), /already registered/);
    const complete = command.getArgumentCompletions!;
    assert.deepEqual(await complete(""), [
        {value: "network-inspection", label: "network-inspection"}, {value: "mmap", label: "mmap"},
    ]);
    assert.deepEqual(await complete(" mm"), [{value: "mmap", label: "mmap"}]);
    assert.deepEqual(await complete("MMAP O"), [
        {value: "mmap on", label: "on"}, {value: "mmap off", label: "off"},
    ]);
    assert.deepEqual(await complete("network-inspection off "), []);
    assert.equal(await complete("save"), null);
    assert.equal(await complete("invalid "), null);
    assert.equal(runtimeRequests(), 0);
});

test("sandboxing reports outside TUI, applies explicit switches, warns about reduced guarantees, and never saves", async (t) => {
    const {runtime, command, ctx, notifications} = harness(t);
    await command.handler("", ctx);
    assert.match(notifications.at(-1)!.message, /Network inspection = on\nWritable mmap = off/);
    assert.match(notifications.at(-1)!.message, /Settings are never saved/);
    ctx.hasUI = true;
    ctx.mode = "rpc";
    await command.handler("", ctx); // Must not try a terminal-only custom component.
    await command.handler(" MMAP ON ", ctx);
    assert.equal(runtime.writableMmap, true);
    assert.equal(runtime.fullNetworkInspection, true);
    assert.equal(notifications.at(-1)!.type, "warning");
    assert.match(notifications.at(-1)!.message, /memory stores are not individually checked or revocable/);
    assert.match(notifications.at(-1)!.message, /dirty changes/);
    assert.match(notifications.at(-1)!.message, /SQLite WAL remains unsupported/);
    await command.handler("network-inspection off", ctx);
    assert.equal(runtime.fullNetworkInspection, false);
    assert.equal(runtime.writableMmap, true);
    assert.equal(notifications.at(-1)!.type, "warning");
    assert.match(notifications.at(-1)!.message, /HTTPS stays end-to-end/);
    for (const invalid of ["save", "reset", "mmap", "mmap on off", "network off", "mmap yes"]) {
        await command.handler(invalid, ctx);
        assert.equal(runtime.writableMmap, true);
        assert.equal(runtime.fullNetworkInspection, false);
        assert.match(notifications.at(-1)!.message, /^Usage: \/sandboxing/);
        assert.equal(notifications.at(-1)!.type, "error");
    }
    await command.handler("mmap off", ctx);
    assert.equal(runtime.writableMmap, false);
    assert.match(notifications.at(-1)!.message, /Existing calls and mappings are unchanged/);
    await command.handler("network-inspection on", ctx);
    assert.equal(runtime.fullNetworkInspection, true);
});

test("sandboxing uses Pi's settings switches in TUI, applies immediately, and Escape closes without rollback", async (t) => {
    initTheme("dark");
    const {runtime, command, ctx} = harness(t);
    ctx.hasUI = true;
    ctx.mode = "tui";
    let opened = 0;
    t.mock.method(ctx.ui, "custom", async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
        opened++;
        let closed = false;
        let redraws = 0;
        const picker = await factory({requestRender() { redraws++; }} as TUI, ctx.ui.theme,
            {} as Parameters<typeof factory>[2], () => { closed = true; });
        assert.ok(picker instanceof SandboxingSettings);
        assert.equal(picker.capturesViewportInput, true);
        const plain = () => picker.render(90).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        assert.match(plain(), /Network inspection\s+on/);
        assert.match(plain(), /Writable mmap\s+off/);
        assert.match(plain(), /Session only.*never saved/);
        picker.handleInput("\r");
        assert.equal(runtime.fullNetworkInspection, false);
        picker.handleInput("\x1b[B");
        assert.match(plain(), /memory stores cannot be\s+individually checked or revoked/);
        picker.handleInput(" ");
        assert.equal(runtime.writableMmap, true);
        assert.equal(closed, false);
        for (const width of [1, 2, 8, 20, 90]) {
            assert.ok(picker.render(width).every((line) => displayWidth(line) <= width), `width ${width}`);
        }
        picker.invalidate();
        picker.handleInput("\x1b");
        assert.equal(closed, true);
        assert.equal(runtime.fullNetworkInspection, false);
        assert.equal(runtime.writableMmap, true);
        assert.ok(redraws > 0);
    });
    await command.handler("", ctx);
    assert.equal(opened, 1);
});
