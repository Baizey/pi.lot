import assert from "node:assert/strict";
import {mkdtempSync, rmSync, statSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {
    createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
    type CustomMessageEntry, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {parsePersonaCatalog, type Persona} from "../src/personas/PersonaCatalog.js";
import {PersonaCommand} from "../src/personas/PersonaCommand.js";
import {registerPersonaManageTool} from "../src/personas/PersonaManageTool.js";
import {PersonaStore} from "../src/personas/PersonaStore.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

const legion: Persona = {
    id: "a1234567-1234-4234-8234-0123456789ab", name: "Legion", prompt: "Use we sparingly. Keep answers direct.",
};
const tali: Persona = {
    id: "b1234567-1234-4234-8234-0123456789ab", name: "Tali", prompt: "Keep it earnest, curious, and practical.",
};

function fixture(t: TestContext) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-persona-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    return {directory, store: new PersonaStore(directory)};
}

test("catalog is bounded and rejects invalid IDs, reserved names, controls, and unexpected fields", () => {
    assert.deepEqual(parsePersonaCatalog({personas: [legion, tali]}), {personas: [legion, tali]});
    for (const change of [
        {id: legion.id.toUpperCase()}, {id: legion.id.replace("4234", "1234")}, {name: "OFF"},
        {name: "\x1b[0m"}, {name: " bad"}, {prompt: "A\x07B"}, {prompt: "\uD800"},
        {prompt: "🎮".repeat(1025)}, {prompt: "whitespace "}, {permissions: "allow"},
    ]) assert.throws(() => parsePersonaCatalog({personas: [{...legion, ...change}]}));
    assert.throws(() => parsePersonaCatalog({personas: [legion, legion]}), /unique/);
    assert.deepEqual(parsePersonaCatalog({personas: [legion, {...tali, name: legion.name}]}).personas.length, 2);
});

test("library and local default persist separately and stale writes cannot replace a newer library", (t) => {
    const {directory, store} = fixture(t);
    const empty = store.catalog();
    assert.deepEqual(empty, {personas: []});
    assert.equal(store.defaultId(), null);
    store.saveCatalog(empty, {personas: [tali, legion]});
    store.saveDefault(legion.id);
    const other = new PersonaStore(directory);
    assert.deepEqual(other.catalog(), {personas: [legion, tali]});
    assert.equal(other.defaultId(), legion.id);
    for (const name of ["personas.json", "persona-default.json", "personas.lock"]) {
        assert.equal(statSync(path.join(directory, name)).mode & 0o777, 0o600);
    }
    assert.throws(() => store.saveCatalog(empty, {personas: [tali]}), /library changed/);
    other.saveDefault(null);
    assert.equal(store.defaultId(), null);
    assert.deepEqual(store.catalog(), {personas: [legion, tali]});
});

test("native Pi keeps one persona note per explicit switch and does not start a model turn", async (t) => {
    const {directory, store} = fixture(t);
    store.saveCatalog(store.catalog(), {personas: [legion, tali]});
    store.saveDefault(legion.id);
    const manager = SessionManager.inMemory(directory);
    const settings = SettingsManager.inMemory();
    const create = async () => {
        const loader = new DefaultResourceLoader({
            cwd: directory, agentDir: directory, settingsManager: settings,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [(pi) => new PersonaCommand(pi, store).register()],
        });
        await loader.reload();
        const {session} = await createAgentSession({
            cwd: directory, agentDir: directory, resourceLoader: loader, settingsManager: settings,
            sessionManager: manager, noTools: "builtin",
        });
        const errors: unknown[] = [];
        await session.bindExtensions({onError: (error) => errors.push(error)});
        t.after(async () => {
            await session.dispose();
            assert.deepEqual(errors, []);
        });
        return session;
    };
    const session = await create();
    const notes = () => manager.getBranch().filter((entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" && entry.customType === "pilot.persona");
    assert.equal(notes().length, 1);
    assert.deepEqual(notes()[0]?.details, {id: legion.id, name: legion.name});
    assert.equal(notes()[0]?.display, false);
    assert.equal(session.messages.some((message) => message.role === "custom" && message.content.toString().includes(legion.prompt)), true);
    await session.prompt("/persona");
    assert.equal(notes().length, 1);
    await session.prompt("/persona Tali");
    await session.prompt("/persona save");
    assert.equal(store.defaultId(), tali.id);
    assert.equal(notes().length, 2);
    const revised = {...tali, name: "Fleet", prompt: "Keep it practical and gentle."};
    store.saveCatalog(store.catalog(), {personas: [legion, revised]});
    assert.match(String(notes()[1]?.content), /earnest, curious/);
    await session.prompt("/persona off");
    assert.equal(notes()[2]?.details, null);
    await session.prompt("/persona reset");
    assert.equal(notes().length, 4);
    assert.match(String(notes()[3]?.content), /practical and gentle/);
    await create(); // Startup against the same branch must not inject the default again.
    assert.equal(notes().length, 4);
    assert.equal(manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant"), false);
});

test("management previews changes, requires confirmation, and rejects edits to stale snapshots", async (t) => {
    const {store} = fixture(t);
    type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
    let tool: Tool | undefined;
    registerPersonaManageTool({registerTool(definition: Tool) { tool = definition; }} as ExtensionAPI,
        store, new ToolDisplayRows());
    const modelInput = (params: Record<string, string>, confirm?: ExtensionContext["ui"]["confirm"], signal?: AbortSignal) =>
        tool!.execute("fixture", params, signal, undefined, {hasUI: confirm !== undefined, ui: {confirm}} as ExtensionToolContext);
    const create = {action: "create", name: legion.name, prompt: legion.prompt};
    await assert.rejects(modelInput(create), /confirmation/);
    let preview = "";
    await modelInput(create, async (_title, text) => { preview = text; return false; });
    assert.match(preview, /Use we sparingly/);
    assert.equal(store.catalog().personas.length, 0);
    await modelInput(create, async () => true);
    assert.equal(store.catalog().personas.length, 1);
    const id = store.catalog().personas[0]!.id;
    assert.equal(store.defaultId(), null);
    const abort = new AbortController();
    await assert.rejects(modelInput({action: "delete", target: id}, async () => {
        abort.abort();
        return true;
    }, abort.signal), /abort/i);
    await assert.rejects(modelInput({action: "edit", target: id, name: "Consensus"}, async (_title, text) => {
        assert.match(text, /Before\nLegion/);
        assert.match(text, /After\nConsensus/);
        const base = store.catalog();
        store.saveCatalog(base, {personas: [...base.personas, tali]});
        return true;
    }), /library changed/);
    await modelInput({action: "edit", target: id, name: "Consensus"}, async () => true);
    assert.equal(store.catalog().personas.find((item) => item.id === id)?.name, "Consensus");
    await modelInput({action: "delete", target: id}, async () => true);
    assert.deepEqual(store.catalog(), {personas: [tali]});
});
