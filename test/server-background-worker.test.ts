import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {ArchiveWorker} from "../src/server/ArchiveWorker.js";
import {ArchiveWorkerEngine} from "../src/server/ArchiveWorkerEngine.js";
import {ArchiveManifestError} from "../src/server/ArchiveWorkerState.js";
import {ArchiveInbox, ArchiveInboxBusyError, type ArchiveManifest} from "../src/server/ArchiveInbox.js";
import {ArchiveLock} from "../src/server/ArchiveLock.js";
import type {ArchiveSourceScope} from "../src/server/ArchiveSourceScope.js";
import {ServerConfigStore} from "../src/server/ServerConfig.js";

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-background-worker-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const store = new ServerConfigStore(directory);
    const root = store.archiveDirectory;
    const inbox = new ArchiveInbox(root);
    const source: ArchiveSourceScope = {
        version: 1, scope: "current", sessionDirectory: directory, sessionFile: path.join(directory, "native.jsonl"),
        defaultSessionRoots: [directory], rootSessionId: "native",
        activeSession: {sessionId: "native", main: true, rootSessionId: "native", identityConflict: false},
    };
    const enqueue = () => inbox.publish(source, "https://archive.example", randomUUID());
    const contender = new ArchiveLock(path.join(root, "worker.lock"));
    t.after(() => contender.release());
    return {store, root, inbox, enqueue, contender, worker: new ArchiveWorker(root, store)};
}

test("worker imports before deleting, mutates only while elected, and inspects after unlocking", async t => {
    const {inbox, enqueue, contender, worker} = fixture(t);
    const manifest = enqueue();
    t.mock.method(ArchiveWorkerEngine.prototype, "import", (value: ArchiveManifest) => {
        assert.equal(value.id, manifest.id);
        assert.ok(inbox.readManifest(manifest.id));
        assert.equal(contender.acquire(), false);
        return true;
    });
    t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => {
        assert.deepEqual(inbox.ids(), []);
        assert.equal(contender.acquire(), false);
        return {eligible: false};
    });
    const close = t.mock.method(ArchiveWorkerEngine.prototype, "close", () => {
        assert.equal(contender.acquire(), false, "writable WAL cleanup must precede unlock");
    });
    const inspect = t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => {
        assert.equal(contender.acquire(), true);
        contender.release();
        return {eligible: false};
    });
    await worker.run();
    assert.equal(inspect.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 1);
});

test("failed import retains its exact manifest for an idempotent successor worker", async t => {
    const {inbox, enqueue, contender, worker} = fixture(t);
    const manifest = enqueue();
    t.mock.method(ArchiveWorkerEngine.prototype, "import", () => { throw new Error("transaction failed"); });
    await assert.rejects(worker.run(), /transaction failed/);
    assert.deepEqual(inbox.readManifest(manifest.id), manifest);
    assert.equal(contender.acquire(), true);
    contender.release();
});

test("a typed imported identity collision retains its descriptor while healthy work continues", async t => {
    const {inbox, enqueue, worker} = fixture(t);
    const manifests = [enqueue(), enqueue()].sort((a, b) => a.id.localeCompare(b.id));
    const collision = manifests[0]!;
    const healthy = manifests[1]!;
    const imported: string[] = [];
    t.mock.method(ArchiveWorkerEngine.prototype, "import", (manifest: ArchiveManifest) => {
        imported.push(manifest.id);
        if (manifest.id === collision.id) throw new ArchiveManifestError("Archive enqueue identity collision.");
        return true;
    });
    const step = t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => ({eligible: false}));
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.deepEqual(imported, [collision.id, healthy.id], "healthy B is processed after colliding A");
    assert.deepEqual(inbox.readManifest(collision.id), collision);
    assert.equal(inbox.readManifest(healthy.id), undefined);
    assert.equal(step.mock.callCount(), 1);
});

test("import storage failures propagate rather than being classified as invalid descriptors", async t => {
    const {inbox, enqueue, worker} = fixture(t);
    const manifest = enqueue();
    const failure = Object.assign(new Error("database I/O failure"), {code: "SQLITE_IOERR"});
    t.mock.method(ArchiveWorkerEngine.prototype, "import", () => { throw failure; });
    const step = t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => ({eligible: false}));
    await assert.rejects(worker.run(), error => error === failure);
    assert.deepEqual(inbox.readManifest(manifest.id), manifest);
    assert.equal(step.mock.callCount(), 0);
});

test("enqueue during the final locked step is detected after unlock and reimported under ownership", async t => {
    const {inbox, enqueue, contender, worker} = fixture(t);
    inbox.signal();
    let turns = 0;
    const imported = t.mock.method(ArchiveWorkerEngine.prototype, "import", () => {
        assert.equal(contender.acquire(), false);
        return true;
    });
    t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => {
        if (++turns === 1) enqueue();
        return {eligible: false};
    });
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.equal(turns, 2);
    assert.equal(imported.mock.callCount(), 1);
    assert.deepEqual(inbox.ids(), []);
});

test("configuration replacement during retirement retains its new control token and revalidates", async t => {
    const {store, inbox, worker} = fixture(t);
    store.save({url: "https://archive.example", apiKey: "first"});
    const first = inbox.control()!;
    let turns = 0;
    t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => {
        if (++turns === 1) store.save({url: "https://archive.example", apiKey: "second"});
        else {
            assert.equal(store.connection()!.config.apiKey, "second");
            assert.notEqual(inbox.control()!.token, first.token);
        }
        return {eligible: false};
    });
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.equal(turns, 2);
    assert.equal(inbox.control(), undefined);
});

test("worker stays alive across future retry and imports an enqueue arriving during backoff", async t => {
    const {inbox, enqueue, worker} = fixture(t);
    inbox.signal();
    let turns = 0;
    const imported = t.mock.method(ArchiveWorkerEngine.prototype, "import", () => true);
    t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => {
        if (++turns === 1) {
            setTimeout(enqueue, 5);
            return {eligible: true, nextDue: Date.now() + 30};
        }
        return {eligible: false};
    });
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.equal(turns, 2);
    assert.equal(imported.mock.callCount(), 1);
});

test("normal acknowledgment contention retains the worker and retries exact imported work", async t => {
    const {inbox, enqueue, worker} = fixture(t);
    enqueue();
    const acknowledge = ArchiveInbox.prototype.acknowledge;
    let attempts = 0;
    t.mock.method(ArchiveInbox.prototype, "acknowledge", function(this: ArchiveInbox, id: string) {
        if (++attempts === 1) throw new ArchiveInboxBusyError("busy");
        acknowledge.call(this, id);
    });
    const imported = t.mock.method(ArchiveWorkerEngine.prototype, "import", () => true);
    t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => ({eligible: false}));
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.equal(imported.mock.callCount(), 2);
    assert.deepEqual(inbox.ids(), []);
});

test("corrupt descriptors and control retain evidence without starving valid work", async t => {
    const {inbox, enqueue, worker} = fixture(t);
    const valid = enqueue();
    const invalid = randomUUID();
    fs.writeFileSync(path.join(inbox.directory, `${invalid}.json`), "not-json", {mode: 0o600});
    fs.writeFileSync(path.join(inbox.directory, "control.json"), "not-json", {mode: 0o600});
    const imported = t.mock.method(ArchiveWorkerEngine.prototype, "import", (value: ArchiveManifest) => {
        assert.equal(value.id, valid.id);
        return true;
    });
    const step = t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => ({eligible: false}));
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.equal(imported.mock.callCount(), 1);
    assert.equal(step.mock.callCount(), 1);
    assert.deepEqual(inbox.ids(), [invalid]);
    assert.equal(fs.readFileSync(path.join(inbox.directory, `${invalid}.json`), "utf8"), "not-json");
});

test("unchanged admission-full paused manifests do not hot-loop or get deleted", async t => {
    const {inbox, enqueue, worker} = fixture(t);
    const manifest = enqueue();
    const imported = t.mock.method(ArchiveWorkerEngine.prototype, "import", () => false);
    t.mock.method(ArchiveWorkerEngine.prototype, "step", async () => ({eligible: false}));
    t.mock.method(ArchiveWorkerEngine.prototype, "inspect", () => ({eligible: false}));
    await worker.run();
    assert.equal(imported.mock.callCount(), 1);
    assert.deepEqual(inbox.readManifest(manifest.id), manifest);
});
