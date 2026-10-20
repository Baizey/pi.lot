import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {ArchiveBackground} from "../src/server/ArchiveBackground.js";
import {ArchiveInbox} from "../src/server/ArchiveInbox.js";
import {ArchiveRuntime} from "../src/server/ArchiveRuntime.js";
import type {ArchiveSourceScope} from "../src/server/ArchiveSourceScope.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-background-handoff-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const runtime = new ArchiveRuntime();
    const source: ArchiveSourceScope = {
        version: 1, scope: "current", sessionDirectory: directory, sessionFile: path.join(directory, "missing.jsonl"),
        rootSessionId: "native", defaultSessionRoots: [directory],
        activeSession: {sessionId: "native", main: true, rootSessionId: "native", identityConflict: false},
    };
    return {store, runtime, source, background: new ArchiveBackground(store, {runtime}), inbox: new ArchiveInbox(store.archiveDirectory)};
}

test("runtime validation failure does not prevent durable departure and is never retried at enqueue", async t => {
    const {store, runtime, source, background, inbox} = fixture(t);
    store.save({url: "https://archive.example", apiKey: "secret"});
    const validate = t.mock.method(runtime, "initialize", async () => { throw new Error("unavailable"); });
    const launch = t.mock.method(runtime, "launch", async () => { throw new Error("must not launch"); });
    await assert.rejects(background.initialize(), /unavailable/);
    const result = await background.enqueue(source);
    assert.equal(result.queued, true);
    assert.match(result.warning!, /queued/);
    assert.equal(validate.mock.callCount(), 1);
    assert.equal(launch.mock.callCount(), 0);
    const manifest = inbox.readManifest(inbox.ids()[0]!)!;
    assert.deepEqual(manifest.source, source);
    assert.equal(manifest.generation, store.connection()!.generation);
    assert.equal(JSON.stringify(manifest).includes("secret"), false);
});

test("successful handoff is durable before launch and repeated departure identity is idempotent", async t => {
    const {store, runtime, source, background, inbox} = fixture(t);
    store.save({url: "https://archive.example", apiKey: "secret"});
    t.mock.method(runtime, "initialize", async () => {});
    const launch = t.mock.method(runtime, "launch", async () => {});
    await background.initialize();
    launch.mock.restore();
    t.mock.method(runtime, "launch", async () => { assert.equal(inbox.ids().length, 1); });
    const requestId = randomUUID();
    assert.deepEqual(await background.enqueue(source, requestId), {queued: true});
    assert.deepEqual(await background.enqueue(source, requestId), {queued: true});
    assert.equal(inbox.ids().length, 1);
});

test("distinct requests using the same cached source retain distinct immutable obligations", async t => {
    const {store, source, background, inbox} = fixture(t);
    store.save({url: "https://archive.example", apiKey: "secret"});
    await background.enqueue(source);
    await background.enqueue(source);
    assert.equal(inbox.ids().length, 2);
});

test("post-commit launch failure is a warning, but admission and authorization failures are not queued", async t => {
    const {store, runtime, source, background, inbox} = fixture(t);
    store.save({url: "https://archive.example", apiKey: "secret"});
    t.mock.method(runtime, "initialize", async () => {});
    const launch = t.mock.method(runtime, "launch", async () => {});
    await background.initialize();
    launch.mock.restore();
    t.mock.method(runtime, "launch", async () => { throw new Error("spawn secret failure"); });
    assert.equal((await background.enqueue(source)).queued, true);
    assert.equal(inbox.ids().length, 1);
    await assert.rejects(background.enqueue({...source, parentSession: "x".repeat(16384)}), /16 KiB/);
    store.logout();
    await assert.rejects(background.enqueue({...source}), /not configured/);
    assert.equal(inbox.ids().length, 1);
});

test("automatic ephemeral requests are not queued, explicit all can retain discovery scope", async t => {
    const {store, source, background, inbox} = fixture(t);
    store.save({url: "https://archive.example", apiKey: "secret"});
    const {sessionFile: _, ...ephemeral} = source;
    await assert.rejects(background.enqueue(ephemeral), /Ephemeral/);
    assert.equal((await background.enqueue({...ephemeral, scope: "all"})).queued, true);
    assert.equal(inbox.ids().length, 1);
});
