import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {ArchiveInbox} from "../src/server/ArchiveInbox.js";
import {ArchiveLock, ensurePrivateDirectory} from "../src/server/ArchiveLock.js";
import type {ArchiveSourceScope} from "../src/server/ArchiveSourceScope.js";

function fixture(t: test.TestContext): {directory: string; inbox: ArchiveInbox; source: ArchiveSourceScope} {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-background-inbox-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    return {directory, inbox: new ArchiveInbox(directory), source: {
        version: 1, scope: "current", sessionDirectory: directory, sessionFile: path.join(directory, "native.jsonl"),
        defaultSessionRoots: [directory], rootSessionId: "native",
        activeSession: {sessionId: "native", main: true, rootSessionId: "native", identityConflict: false},
    }};
}

test("durable inbox publishes only bounded source descriptors and acknowledges an exact identity", t => {
    const {directory, inbox, source} = fixture(t);
    const manifest = inbox.publish(source, "https://archive.example", randomUUID());
    assert.deepEqual(inbox.readManifest(manifest.id), manifest);
    assert.deepEqual(inbox.ids(), [manifest.id]);
    assert.equal(fs.statSync(path.join(directory, "inbox", `${manifest.id}.json`)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(source.sessionFile!), false, "enqueue does not read or create source files");
    assert.deepEqual(inbox.publish(source, manifest.origin, manifest.generation, manifest.id), manifest);
    assert.throws(() => inbox.publish(source, manifest.origin, randomUUID(), manifest.id), /collision/);
    inbox.acknowledge(manifest.id);
    assert.deepEqual(inbox.ids(), []);
});

test("identical enqueue retry re-syncs after validation and cannot hide an earlier directory fsync failure", t => {
    const {inbox, source} = fixture(t);
    inbox.signal();
    const id = randomUUID();
    const generation = randomUUID();
    const file = path.join(inbox.directory, `${id}.json`);
    const directoryStat = fs.statSync(inbox.directory);
    const sync = fs.fsyncSync;
    const open = fs.openSync;
    let retry = false;
    let validated = false;
    let fail = true;
    let failures = 0;
    const observeOpen: typeof fs.openSync = (name, flags, mode) => {
        if (name === file && flags !== "wx") validated = true;
        return open(name, flags, mode);
    };
    t.mock.method(fs, "openSync", observeOpen);
    t.mock.method(fs, "fsyncSync", (descriptor: number) => {
        const stat = fs.fstatSync(descriptor);
        if (fail && stat.ino === directoryStat.ino && stat.dev === directoryStat.dev
            && fs.existsSync(file) && (!retry || validated)) {
            failures++;
            throw new Error("injected inbox directory fsync failure");
        }
        sync(descriptor);
    });
    assert.throws(() => inbox.publish(source, "https://archive.example", generation, id), /injected/);
    assert.equal(fs.existsSync(file), true, "rename completed before synchronization failed");
    retry = true;
    assert.throws(() => inbox.publish(source, "https://archive.example", generation, id), /injected/);
    assert.equal(validated, true, "retry validated the existing descriptor before its failing synchronization");
    assert.equal(failures, 2);
    fail = false;
    assert.equal(inbox.publish(source, "https://archive.example", generation, id).id, id);
});

test("descriptor read I/O failure propagates without being mislabeled as invalid content", t => {
    const {inbox, source} = fixture(t);
    const manifest = inbox.publish(source, "https://archive.example", randomUUID());
    const failure = Object.assign(new Error("injected read I/O failure"), {code: "EIO"});
    t.mock.method(fs, "readSync", () => { throw failure; });
    assert.throws(() => inbox.readManifest(manifest.id), error => error === failure);
});

test("custom roots reject missing ancestors without partially creating a hierarchy", t => {
    const {directory} = fixture(t);
    const ancestor = path.join(directory, "missing");
    const root = path.join(ancestor, "nested", "archive");
    assert.throws(() => ensurePrivateDirectory(root), {code: "ENOENT"});
    assert.equal(fs.existsSync(ancestor), false);
    fs.mkdirSync(path.dirname(root), {recursive: true, mode: 0o700});
    ensurePrivateDirectory(root);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});

test("leaf creation retries parent synchronization after an interrupted durable-directory creation", t => {
    const {directory} = fixture(t);
    const leaf = path.join(directory, "leaf");
    const parent = fs.statSync(directory);
    const sync = fs.fsyncSync;
    let fail = true;
    let attempts = 0;
    t.mock.method(fs, "fsyncSync", (descriptor: number) => {
        const stat = fs.fstatSync(descriptor);
        if (stat.ino === parent.ino && stat.dev === parent.dev) {
            attempts++;
            if (fail) throw new Error("injected parent synchronization failure");
        }
        sync(descriptor);
    });
    assert.throws(() => ensurePrivateDirectory(leaf), /injected/);
    assert.equal(fs.existsSync(leaf), true);
    assert.throws(() => ensurePrivateDirectory(leaf), /injected/);
    assert.equal(attempts, 2, "existing-leaf retry must repeat the failed parent synchronization");
    fail = false;
    ensurePrivateDirectory(leaf);
    assert.equal(attempts, 3);
});

test("control replacement cannot be acknowledged by an older imported event", t => {
    const {inbox} = fixture(t);
    const old = inbox.signal();
    const newer = inbox.signal();
    inbox.acknowledgeControl(old);
    assert.deepEqual(inbox.control(), newer);
    inbox.acknowledgeControl(newer);
    assert.equal(inbox.control(), undefined);
});

test("full data inbox rejects newest but retains an independent coalesced control slot", t => {
    const {directory, inbox, source} = fixture(t);
    inbox.signal();
    for (let i = 0; i < 1024; i++) fs.writeFileSync(path.join(directory, "inbox", `${randomUUID()}.json`), "{}", {mode: 0o600});
    assert.throws(() => inbox.publish(source, "https://archive.example", randomUUID()), /full/);
    const control = inbox.signal();
    assert.deepEqual(inbox.control(), control);
    assert.equal(inbox.ids().length, 1024);
});

test("oversized descriptors fail without admitting work", t => {
    const {inbox, source} = fixture(t);
    assert.throws(() => inbox.publish({...source, parentSession: "x".repeat(16384)}, "https://archive.example", randomUUID()), /16 KiB/);
    assert.deepEqual(inbox.ids(), []);
});

test("kernel locks retain ownership after helper exit and release only with the owning fd", t => {
    const {directory} = fixture(t);
    const file = path.join(directory, "worker.lock");
    const owner = new ArchiveLock(file);
    const contender = new ArchiveLock(file);
    try {
        assert.equal(owner.acquire(), true);
        const inode = fs.statSync(file).ino;
        assert.equal(contender.acquire(), false);
        owner.release();
        assert.equal(contender.acquire(), true);
        assert.equal(fs.statSync(file).ino, inode, "lock inode is never replaced");
    } finally { owner.release(); contender.release(); }
});

test("inbox admission times out rather than waiting on an unrelated worker critical section", t => {
    const {directory, inbox, source} = fixture(t);
    const lock = new ArchiveLock(path.join(directory, "inbox.lock"));
    assert.equal(lock.acquire(), true);
    try {
        const start = Date.now();
        assert.throws(() => inbox.publish(source, "https://archive.example", randomUUID()), /busy|helper failed/);
        assert.ok(Date.now() - start < 750, "250ms helper bound plus scheduler tolerance");
        assert.deepEqual(inbox.ids(), []);
    } finally { lock.release(); }
    assert.ok(inbox.publish(source, "https://archive.example", randomUUID()));
});
