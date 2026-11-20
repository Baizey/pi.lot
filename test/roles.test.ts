import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext} from "@earendil-works/pi-coding-agent";
import {parseRoleCatalog, type RoleProfile} from "../src/roles/RoleCatalog.js";
import {RoleCommand} from "../src/roles/RoleCommand.js";
import {RoleLibrary} from "../src/roles/RoleStore.js";
import {roleManageTool, roleReadTool} from "../src/roles/RoleTools.js";
import {SubagentSpawnTool} from "../src/tools/subagent/SubagentSpawnTool.js";
import type {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import type {SubagentRequest} from "../src/subagents/types.js";
import {initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

import {mockIsolatedDatabaseOpens} from "./fixtures/IsolatedTestDatabase.js";

const reviewer: RoleProfile = {id: "a1234567-1234-4234-8234-0123456789ab", title: "Reviewer",
    text: "Report findings first, with file and line references.", description: "Review changes without editing."};

function fixture(t: TestContext) {
    mockIsolatedDatabaseOpens(t);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pilot-role-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const library = new RoleLibrary(path.join(dir, "pilot.sqlite"));
    library.save({roles: []}, {roles: [reviewer]});
    return {dir, library};
}

test("saved roles validate shape, byte limits, reserved titles and optional descriptions", () => {
    assert.deepEqual(parseRoleCatalog({roles: [reviewer]}), {roles: [reviewer]});
    for (const change of [{title: "NoNe"}, {text: "é".repeat(2049)}, {id: "made-up"}, {description: null},
        {description: "line\nline"}, {description: "line\u2028line"}, {permissions: "all"}]) {
        assert.throws(() => parseRoleCatalog({roles: [{...reviewer, ...change}]}));
    }
    assert.throws(() => parseRoleCatalog({roles: [reviewer, reviewer]}), /Duplicate/);
});

test("root assignment stays on its branch through compaction and catalog edits; fresh branches start empty", async (t) => {
    const {dir, library} = fixture(t);
    const manager = SessionManager.inMemory(dir);
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const pi = {
        registerCommand(_name: string, value: typeof command) { command = value; },
        appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
    } as unknown as ExtensionAPI;
    const role = new RoleCommand(pi, library);
    role.register();
    const ctx = {sessionManager: manager, isIdle: () => true, hasUI: false,
        ui: {notify(_message: string, level: string) { assert.notEqual(level, "error"); }}} as unknown as ExtensionCommandContext;
    assert.equal(role.promptSection(ctx), undefined);
    await command!.handler("Reviewer", ctx);
    assert.match(role.promptSection(ctx) ?? "", /Report findings first/);
    const selected = manager.getLeafId()!;
    const messageId = manager.appendMessage({role: "user", content: "Review this.", timestamp: Date.now()});
    manager.appendCompaction("Summary", messageId, 100);
    assert.match(new RoleCommand(pi, library).promptSection(ctx) ?? "", /Report findings first/);
    library.save(library.catalog(), {roles: [{...reviewer, text: "New instructions."}]});
    assert.match(role.promptSection(ctx) ?? "", /Report findings first/);
    await command!.handler("none", ctx);
    assert.equal(role.promptSection(ctx), undefined);
    manager.branch(selected);
    assert.match(role.promptSection(ctx) ?? "", /Report findings first/);
    assert.equal(role.promptSection({...ctx, sessionManager: SessionManager.inMemory(dir)}), undefined);
});

test("role management saves without asking and wakes sync once per change", async (t) => {
    const {library} = fixture(t);
    let wakes = 0;
    const displayRows = new ToolDisplayRows();
    const tool = roleManageTool(library, () => wakes++, displayRows);
    const call = (params: Record<string, string>, hasUI = false, signal?: AbortSignal) =>
        tool.execute("fixture", params, signal, undefined, {hasUI, ui: {
            confirm: () => assert.fail("Role management must not prompt"),
        }} as unknown as ExtensionToolContext);
    const create = {action: "create", title: "Writer", text: "Write a concise summary."};
    await call(create);
    assert.equal(library.catalog().roles.find(({title}) => title === create.title)?.text, create.text);
    assert.equal(wakes, 1);
    await assert.rejects(call(create), /already has that title/);
    const change = {action: "edit", target: reviewer.id, description: "", text: "Updated instructions."};
    await call(change, true);
    assert.equal(wakes, 2);
    assert.match(JSON.stringify(await call(change)), /No changes/);
    const lookup = roleReadTool(library, displayRows);
    const list = await lookup.execute("list", {}, undefined, undefined, {} as ExtensionToolContext);
    assert.doesNotMatch(JSON.stringify(list), /Updated instructions/);
    const details = await lookup.execute("inspect", {target: reviewer.id}, undefined, undefined, {} as ExtensionToolContext);
    assert.match(JSON.stringify(details), /Updated instructions/);
    assert.equal(library.catalog().roles.find(({id}) => id === reviewer.id)?.description, undefined);
    const remove = {action: "delete", target: create.title};
    await assert.rejects(call(remove, false, AbortSignal.abort()), /abort/i);
    assert.equal(wakes, 2);
    await call(remove);
    assert.deepEqual(library.catalog().roles.map(({id}) => id), [reviewer.id]);
    assert.equal(wakes, 3);
});

test("stale role writes do not overwrite newer changes", (t) => {
    const {library} = fixture(t);
    const stale = library.catalog();
    const current = {roles: [{...reviewer, text: "Changed concurrently."}]};
    library.save(stale, current);
    assert.throws(() => library.save(stale, {roles: []}), /changed/);
    assert.deepEqual(library.catalog(), current);
});

test("spawn accepts ad hoc roles or saved profiles and snapshots instructions without setting authority", async (t) => {
    const {dir, library} = fixture(t);
    const requests: SubagentRequest[] = [];
    const coordinator = {async spawn(request: SubagentRequest) {
        requests.push(request);
        return {job: {id: "subagent-fixture", ...request}};
    }} as unknown as SubagentCoordinator;
    const tool = new SubagentSpawnTool({} as ExtensionAPI, () => coordinator, () => initialSubagentDefaults,
        new ToolDisplayRows(), library).toolDefinition();
    const ctx = {cwd: dir, sessionManager: SessionManager.inMemory(dir)} as unknown as ExtensionToolContext;
    const call = (input: object) => tool.execute("spawn", {task: "Review the patch", reasoning_skill: "mid", reasoning_amount: "low",
        ...input}, undefined, undefined, ctx);
    await call({role: "Ad hoc"});
    await call({roleProfile: reviewer.id, systemPrompt: "Check these two files.", capabilities: []});
    assert.equal(requests[0]?.role, "Ad hoc");
    assert.equal(requests[0]?.roleProfile, undefined);
    assert.equal(requests[1]?.role, reviewer.title);
    assert.deepEqual(requests[1]?.capabilities, []);
    assert.equal(requests[1]?.systemPrompt, "Check these two files.");
    library.save(library.catalog(), {roles: []});
    assert.deepEqual(requests[1]?.roleProfile, reviewer);
    await assert.rejects(call({roleProfile: reviewer.id, role: "Fallback"}), /not found/);
    await assert.rejects(call({}), /Specify a role/);
});
