import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, type Dir, type Dirent} from "node:fs";
import fsPromises, {opendir} from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import os from "node:os";
import path from "node:path";
import test, {type TestContext} from "node:test";
import {ArchiveDiscovery, type ArchiveDiscoveryPage} from "../src/server/ArchiveDiscovery.js";
import {ArchiveSourceError} from "../src/server/ArchiveSourceError.js";
import {ArchiveSessions} from "../src/server/ArchiveSessions.js";
import type {ArchiveSourceScope} from "../src/server/ArchiveSourceScope.js";

function fixture(t: TestContext, all = false) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-archive-discovery-"));
    const sessions = path.join(directory, "custom");
    const defaults = path.join(directory, "defaults");
    mkdirSync(sessions);
    mkdirSync(defaults);
    const source: ArchiveSourceScope = {version: 1, scope: all ? "all" : "current",
        activeSession: {sessionId: "root", main: true, rootSessionId: "root", identityConflict: false},
        rootSessionId: "root", sessionFile: path.join(sessions, "active.jsonl"),
        sessionDirectory: sessions, defaultSessionRoots: [defaults]};
    const scanners: ArchiveDiscovery[] = [];
    t.after(async () => {
        for (const scanner of scanners) await scanner.close();
        rmSync(directory, {recursive: true, force: true});
    });
    return {directory, sessions, defaults, source, scanner() {
        const scanner = new ArchiveDiscovery(source);
        scanners.push(scanner);
        return scanner;
    }};
}

async function drain(scanner: ArchiveDiscovery, cursor: string | null = null, capacity = 17) {
    const files = new Set<string>();
    const issues: ArchiveDiscoveryPage["issues"] = [];
    let pages = 0;
    while (true) {
        assert.ok(pages++ < 1000, "discovery must make progress");
        const page = await scanner.discoverPage(cursor, capacity);
        assert.ok(page.files.length + page.issues.length <= capacity);
        page.files.forEach((file) => files.add(file));
        issues.push(...page.issues);
        if (page.complete) return {files, issues, pages};
        cursor = page.cursor;
        assert.notEqual(cursor, null);
    }
}

test("discovery pages list paths without parsing transcripts, and retain missing active sources", async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 43; i++) writeFileSync(path.join(f.sessions, `${i}.jsonl`), "not a transcript");
    writeFileSync(path.join(f.sessions, "unrelated.txt"), "ignored");
    const result = await drain(f.scanner(), null, 3);
    assert.equal(result.files.size, 44);
    assert.ok(result.files.has(f.source.sessionFile!));
    assert.deepEqual(result.issues, []);
    assert.ok(result.pages >= 15);
});

test("zero source capacity does not advance discovery and cursor is bound to its scope", async (t) => {
    const f = fixture(t);
    const scanner = f.scanner();
    assert.deepEqual(await scanner.discoverPage(null, 0), {files: [], issues: [], cursor: null, complete: false});
    const first = await scanner.discoverPage(null, 1);
    assert.equal(first.complete, false);
    assert.deepEqual((await scanner.discoverPage(first.cursor, 0)).cursor, first.cursor);
    await assert.rejects(scanner.discoverPage(first.cursor, 10001), {code: "invalid"});
    const other = fixture(t).scanner();
    await assert.rejects(other.discoverPage(first.cursor, 1), {code: "invalid"});
    await assert.rejects(scanner.discoverPage('{"secret":"not a cursor"}', 1), (error: unknown) => {
        assert.ok(error instanceof ArchiveSourceError);
        assert.equal(error.code, "invalid");
        assert.doesNotMatch(error.message, /secret/);
        return true;
    });
});

test("fresh instances replay late cursors and advance with bounded output, not bounded replay I/O", async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 700; i++) writeFileSync(path.join(f.sessions, `${i}.jsonl`), "invalid");
    const initial = f.scanner();
    const seen = new Set<string>();
    let cursor: string | null = null;
    while (seen.size < 500) {
        const page = await initial.discoverPage(cursor, 100);
        page.files.forEach((file) => seen.add(file));
        cursor = page.cursor;
        assert.equal(page.complete, false);
    }
    assert.ok(Buffer.byteLength(cursor!) < 2048);
    await initial.close();
    const restarted = f.scanner();
    const replay = await restarted.discoverPage(cursor, 100);
    assert.equal(replay.files.length, 100, "a fresh scanner must progress past a prefix larger than its new-entry budget");
    replay.files.forEach((file) => seen.add(file));
    assert.equal(replay.complete, false);
    assert.notEqual(replay.cursor, cursor);
    const remaining = await drain(f.scanner(), replay.cursor, 100);
    remaining.files.forEach((file) => seen.add(file));
    assert.equal(seen.size, 701);
    assert.deepEqual(remaining.issues, []);
});

test("directory changes restart a continuation without skipping newly added paths", async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 9; i++) writeFileSync(path.join(f.sessions, `${i}.jsonl`), "invalid");
    const scanner = f.scanner();
    const first = await scanner.discoverPage(null, 4);
    const fresh = path.join(f.sessions, "new.jsonl");
    writeFileSync(fresh, "invalid");
    const rest = await drain(scanner, first.cursor, 3);
    assert.ok(rest.files.has(fresh));
    assert.equal(new Set([...first.files, ...rest.files]).size, 11);
});

test("replaced directories restart saved ordinals and full admission leaves continuation intact", async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 12; i++) writeFileSync(path.join(f.sessions, `${i}.jsonl`), "invalid");
    const first = await f.scanner().discoverPage(null, 7);
    assert.equal(first.files.length, 7);
    const paused = await f.scanner().discoverPage(first.cursor, 0);
    assert.equal(paused.cursor, first.cursor);
    assert.equal(paused.complete, false);
    renameSync(f.sessions, path.join(f.directory, "old"));
    mkdirSync(f.sessions);
    const replacement = path.join(f.sessions, "replacement.jsonl");
    writeFileSync(replacement, "invalid");
    const resumed = await drain(f.scanner(), paused.cursor, 1);
    assert.deepEqual([...resumed.files], [replacement], "a saved ordinal cannot skip a replacement directory");
    assert.deepEqual(resumed.issues, []);
});

test("every page closes readers, including scope/retry alternation and cancellation", async (t) => {
    const f = fixture(t, true);
    const native = await opendir(f.sessions);
    const prototype = Object.getPrototypeOf(native);
    await native.close();
    const read = prototype.read;
    const close = prototype.close;
    const live = new Set<Dir>();
    const controller = new AbortController();
    let abortOnRead = false;
    t.mock.method(prototype, "read", function (this: Dir, ...args: unknown[]) {
        live.add(this);
        if (abortOnRead) controller.abort();
        return read.apply(this, args);
    });
    t.mock.method(prototype, "close", function (this: Dir, ...args: unknown[]) {
        live.delete(this);
        return close.apply(this, args);
    });
    for (let i = 0; i < 10; i++) writeFileSync(path.join(f.sessions, `${i}.jsonl`), "invalid");
    const scanner = f.scanner();
    const first = await scanner.discoverPage(null, 4);
    assert.equal(live.size, 0);
    rmSync(f.defaults, {recursive: true});
    const full = await drain(scanner);
    assert.equal(live.size, 0);
    assert.equal(full.issues.length, 1);
    await assert.rejects(scanner.discoverPage(full.issues[0]!.retryCursor, 4), {code: "missing"});
    const resumed = await scanner.discoverPage(first.cursor, 4);
    assert.equal(resumed.files.length, 4);
    assert.equal(live.size, 0);
    abortOnRead = true;
    await assert.rejects(scanner.discoverPage(first.cursor, 4, controller.signal), {name: "AbortError"});
    assert.equal(live.size, 0);
});

test("all scope stays in recorded directories and a missing directory has an independent retry cursor", async (t) => {
    const f = fixture(t, true);
    rmSync(f.sessions, {recursive: true});
    const project = path.join(f.defaults, "project");
    mkdirSync(project);
    const healthy = path.join(project, "healthy.jsonl");
    writeFileSync(healthy, "invalid");
    const outside = path.join(f.directory, "outside.jsonl");
    writeFileSync(outside, "invalid");
    const scanner = f.scanner();
    const result = await drain(scanner, null, 2);
    assert.deepEqual([...result.files].sort(), [f.source.sessionFile!, healthy].sort());
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.path, f.sessions);
    assert.equal(result.issues[0]!.code, "missing");
    await assert.rejects(f.scanner().discoverPage(result.issues[0]!.retryCursor, 2), {code: "missing"});
    mkdirSync(f.sessions);
    const recovered = path.join(f.sessions, "recovered.jsonl");
    writeFileSync(recovered, "invalid");
    const retry = await drain(f.scanner(), result.issues[0]!.retryCursor, 1);
    assert.deepEqual([...retry.files], [recovered]);
    assert.deepEqual(retry.issues, []);
    assert.equal(scanner.ownsFile(outside), false);
    assert.equal(scanner.ownsFile(healthy), true);
    assert.equal(scanner.ownsFile(path.join(project, "nested", "no.jsonl")), false);
});

test("partial directory reads retain observed files and retry evidence while healthy projects continue", async (t) => {
    const f = fixture(t, true);
    for (let i = 0; i < 10; i++) writeFileSync(path.join(f.sessions, `${i}.jsonl`), "invalid");
    const project = path.join(f.defaults, "healthy");
    mkdirSync(project);
    const healthy = path.join(project, "healthy.jsonl");
    writeFileSync(healthy, "invalid");
    const handle = await opendir(f.sessions);
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const original = prototype.read;
    let reads = 0;
    t.mock.method(prototype, "read", function (this: Dir, ...args: unknown[]) {
        if (this.path === f.sessions && args.length === 0 && ++reads === 4) {
            throw Object.assign(new Error("private filesystem detail"), {code: "EIO"});
        }
        return original.apply(this, args);
    });
    const result = await drain(f.scanner(), null, 64);
    assert.ok(result.files.size > 2);
    assert.ok(result.files.has(healthy));
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.code, "unreadable");
    assert.doesNotMatch(JSON.stringify(result.issues), /private filesystem detail/);
    const retry = await drain(f.scanner(), result.issues[0]!.retryCursor, 64);
    assert.equal(retry.files.size, 10);
    assert.equal(new Set([...result.files, ...retry.files]).size, 12);
});

test("ephemeral current is empty, but explicit all enumerates recorded default projects", async (t) => {
    const f = fixture(t);
    delete f.source.sessionFile;
    assert.deepEqual(await f.scanner().discoverPage(null, 10), {files: [], issues: [], cursor: null, complete: true});
    f.source.scope = "all";
    const project = path.join(f.defaults, "project");
    mkdirSync(project);
    const file = path.join(project, "history.jsonl");
    writeFileSync(file, "invalid");
    assert.deepEqual([...(await drain(f.scanner())).files], [file]);
});

test("trusted custom-directory aliases use target stamps and preserve aliased pagination across fresh instances", async (t) => {
    const f = fixture(t);
    let target = path.join(f.directory, "target-one");
    mkdirSync(target);
    for (let index = 0; index < 8; index++) writeFileSync(path.join(f.sessions, `${index}.jsonl`), "invalid");
    const boundary = mockSeedAlias(t, f.sessions, () => target);
    const first = await f.scanner().discoverPage(null, 3);
    assert.equal(first.files.length, 3);
    assert.equal(first.complete, false);
    assert.equal(JSON.parse(first.cursor!).frames[0].stamp, await boundary.targetStamp());
    const second = await f.scanner().discoverPage(first.cursor, 2);
    assert.equal(second.files.length, 2);
    assert.notEqual(second.cursor, first.cursor);
    assert.ok([...first.files, ...second.files].every((file) => path.dirname(file) === f.sessions));
    assert.ok(!second.cursor!.includes(target));
    for (let index = 0; index < 8; index++) rmSync(path.join(f.sessions, `${index}.jsonl`));
    target = path.join(f.directory, "target-two");
    mkdirSync(target);
    const replacement = path.join(f.sessions, "replacement.jsonl");
    writeFileSync(replacement, "invalid");
    const restarted = await drain(f.scanner(), second.cursor, 2);
    assert.deepEqual([...restarted.files], [replacement]);
    assert.deepEqual(restarted.issues, []);
    assert.ok(boundary.statCalls.length > 0);
    assert.ok(boundary.statCalls.every((file) => file === f.sessions));
    assert.ok(!boundary.lstatCalls.includes(f.sessions));
    const nonDirectory = path.join(f.directory, "not-a-directory");
    writeFileSync(nonDirectory, "invalid");
    target = nonDirectory;
    const invalid = await drain(f.scanner());
    assert.equal(invalid.issues[0]?.code, "invalid", "a trusted alias must still target a directory");
});

test("trusted collection aliases follow only the seed while child aliases remain rejected", async (t) => {
    const f = fixture(t, true);
    delete f.source.sessionFile;
    let target = path.join(f.directory, "collection-target-one");
    mkdirSync(target);
    const project = path.join(f.defaults, "project");
    const linked = path.join(f.defaults, "linked-project");
    const raced = path.join(f.defaults, "raced-project");
    for (const directory of [project, linked, raced]) mkdirSync(directory);
    for (let index = 0; index < 8; index++) writeFileSync(path.join(project, `${index}.jsonl`), "invalid");
    writeFileSync(path.join(linked, "must-not-discover.jsonl"), "invalid");
    writeFileSync(path.join(raced, "must-not-follow.jsonl"), "invalid");
    const boundary = mockSeedAlias(t, f.defaults, () => target, new Set([raced]));
    const probe = await opendir(f.defaults);
    const observedEntry = await probe.read();
    assert.ok(observedEntry);
    const entryPrototype = Object.getPrototypeOf(observedEntry);
    await probe.close();
    const isDirectory = entryPrototype.isDirectory;
    t.mock.method(entryPrototype, "isDirectory", function (this: Dirent) {
        return this.name === "linked-project" ? false : isDirectory.call(this);
    });
    const first = await f.scanner().discoverPage(null, 2);
    assert.equal(first.complete, false);
    const second = await f.scanner().discoverPage(first.cursor, 2);
    assert.equal(second.complete, false);
    assert.ok([...first.files, ...second.files].every((file) => path.dirname(file) === project));
    assert.equal(JSON.parse(second.cursor!).frames[0].stamp, await boundary.targetStamp());
    assert.ok(!second.cursor!.includes(target));
    for (let index = 0; index < 8; index++) rmSync(path.join(project, `${index}.jsonl`));
    target = path.join(f.directory, "collection-target-two");
    mkdirSync(target);
    const replacement = path.join(project, "replacement.jsonl");
    writeFileSync(replacement, "invalid");
    const newProject = path.join(f.defaults, "replacement-project");
    mkdirSync(newProject);
    const newSibling = path.join(newProject, "new-sibling.jsonl");
    writeFileSync(newSibling, "invalid");
    const restarted = await drain(f.scanner(), second.cursor, 2);
    assert.ok(restarted.files.has(replacement));
    assert.ok(restarted.files.has(newSibling), "target replacement must restart the collection's saved ordinal too");
    assert.ok([...restarted.files].every((file) => [project, newProject].includes(path.dirname(file))));
    assert.ok(restarted.issues.every((issue) => issue.path === raced && issue.code === "invalid"));
    assert.equal([...first.issues, ...second.issues, ...restarted.issues].some((issue) => issue.path === raced && issue.code === "invalid"), true);
    assert.ok(boundary.statCalls.length > 0);
    assert.ok(boundary.statCalls.every((file) => file === f.defaults));
    assert.ok(!boundary.lstatCalls.includes(f.defaults));
    assert.ok(boundary.lstatCalls.includes(project));
    assert.ok(boundary.lstatCalls.includes(raced));
    assert.ok(!boundary.lstatCalls.includes(linked), "enumerated child links are rejected by the dirent guard");
});

test("seed-alias support does not permit leaf symlink transcript capture", async (t) => {
    const f = fixture(t);
    const target = path.join(f.directory, "seed-target");
    mkdirSync(target);
    const linkedFile = path.join(f.sessions, "linked.jsonl");
    writeFileSync(linkedFile, JSON.stringify({type: "session", id: "root", version: 3}) + "\n");
    mockSeedAlias(t, f.sessions, () => target, new Set([linkedFile]));
    assert.ok((await drain(f.scanner())).files.has(linkedFile));
    await assert.rejects(new ArchiveSessions(f.source).captureSource(linkedFile, []), {code: "invalid"});
});

test("actual custom and collection seed symlinks retain aliased file and evidence paths", async (t) => {
    const f = fixture(t, true);
    const customTarget = path.join(f.directory, "custom-target");
    const collectionTarget = path.join(f.directory, "collection-target");
    const project = path.join(collectionTarget, "project");
    mkdirSync(customTarget);
    mkdirSync(project, {recursive: true});
    rmSync(f.sessions, {recursive: true});
    rmSync(f.defaults, {recursive: true});
    try {
        symlinkSync(customTarget, f.sessions);
        symlinkSync(collectionTarget, f.defaults);
        symlinkSync(customTarget, path.join(collectionTarget, "linked-project"));
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
            t.skip("Host sandbox does not allow this symlink fixture.");
            return;
        }
        throw error;
    }
    const body = JSON.stringify({type: "session", id: "root", version: 3}) + "\n";
    writeFileSync(path.join(customTarget, "active.jsonl"), body);
    writeFileSync(path.join(customTarget, "sibling.jsonl"), body);
    writeFileSync(path.join(project, "history.jsonl"), body);
    const discovered = await drain(f.scanner(), null, 1);
    assert.deepEqual([...discovered.files].sort(), [f.source.sessionFile!, path.join(f.sessions, "sibling.jsonl"),
        path.join(f.defaults, "project", "history.jsonl")].sort());
    assert.deepEqual(discovered.issues, []);
    const captured = await new ArchiveSessions(f.source).captureSource(f.source.sessionFile!, []);
    assert.equal(captured.file, f.source.sessionFile);
    assert.equal(captured.evidence.file, f.source.sessionFile);
    assert.deepEqual(captured.body, Buffer.from(body));
});

function mockSeedAlias(t: TestContext, alias: string, target: () => string, leafAliases = new Set<string>()) {
    // Real directories back listing and target stats. Only the filesystem boundary
    // models the alias, so these regressions run where symlink creation is denied.
    const originalStat = fsPromises.stat;
    const originalLstat = fsPromises.lstat;
    const statCalls: string[] = [];
    const lstatCalls: string[] = [];
    t.mock.method(fsPromises, "stat", (file: Parameters<typeof fsPromises.stat>[0], options: Parameters<typeof fsPromises.stat>[1]) => {
        statCalls.push(String(file));
        return originalStat(file === alias ? target() : file, options);
    });
    t.mock.method(fsPromises, "lstat", async (file: Parameters<typeof fsPromises.lstat>[0], options: Parameters<typeof fsPromises.lstat>[1]) => {
        lstatCalls.push(String(file));
        const observed = await originalLstat(file, options);
        if (file === alias || (typeof file === "string" && leafAliases.has(file))) {
            observed.isDirectory = () => false;
            observed.isFile = () => false;
            observed.isSymbolicLink = () => true;
        }
        return observed;
    });
    syncBuiltinESMExports();
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    return {statCalls, lstatCalls, async targetStamp() {
        const observed = await originalStat(target(), {bigint: true});
        return `${observed.dev}:${observed.ino}:${observed.mtimeNs}:${observed.ctimeNs}`;
    }};
}

test("non-regular JSONL entries become explicit file obligations and cancellation is sanitized", async (t) => {
    const f = fixture(t);
    const unsafe = path.join(f.sessions, "directory.jsonl");
    mkdirSync(unsafe);
    assert.ok((await drain(f.scanner())).files.has(unsafe));
    const controller = new AbortController();
    controller.abort(new Error("secret"));
    await assert.rejects(f.scanner().discoverPage(null, 2, controller.signal), (error: Error) => {
        assert.equal(error.name, "AbortError");
        assert.doesNotMatch(error.message, /secret/);
        return true;
    });
});
