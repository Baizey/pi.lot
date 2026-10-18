import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {initialPolicyDefaults, PolicyDefaultJsonStorage} from "../src/policy/defaults.js";
import {initialSubagentDefaults, SubagentDefaultsJsonStore} from "../src/subagents/SubagentDefaults.js";

characterizeDefaultsIo("policy defaults", PolicyDefaultJsonStorage, initialPolicyDefaults);
characterizeDefaultsIo("subagent defaults", SubagentDefaultsJsonStore, initialSubagentDefaults);

test("ordinary defaults retain their home-directory paths", () => {
    assert.equal(new PolicyDefaultJsonStorage().file, path.join(os.homedir(), ".pilot", "policy-defaults.json"));
    assert.equal(new SubagentDefaultsJsonStore().file, path.join(os.homedir(), ".pilot", "subagent-defaults.json"));
});

function characterizeDefaultsIo<T>(
    label: string,
    Store: new (filename: string, directory: string) => {readonly file: string; load(): T; save(value: T): void},
    defaults: T,
): void {
    test(`${label} create parents lazily and save formatted JSON with private creation modes`, (t) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "pilot-defaults-io-"));
        t.after(() => rmSync(root, {recursive: true, force: true}));
        const directory = path.join(root, "nested", "defaults");
        const store = new Store("custom", directory);
        assert.equal(store.file, path.join(directory, "custom.json"));
        assert.deepEqual(store.load(), defaults);
        assert.equal(existsSync(directory), false);

        store.save(defaults);

        assert.equal(readFileSync(store.file, "utf8"), `${JSON.stringify(defaults, null, 2)}\n`);
        assert.equal(statSync(directory).mode & 0o777, 0o700 & ~process.umask());
        assert.equal(statSync(path.dirname(directory)).mode & 0o777, 0o700 & ~process.umask());
        assert.equal(statSync(store.file).mode & 0o777, 0o600 & ~process.umask());
    });

    test(`${label} truncate existing files in place without changing existing modes`, (t) => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-defaults-io-"));
        t.after(() => rmSync(directory, {recursive: true, force: true}));
        const store = new Store("defaults", directory);
        chmodSync(directory, 0o750);
        writeFileSync(store.file, "old contents".repeat(1000));
        chmodSync(store.file, 0o640);
        const inode = statSync(store.file).ino;

        store.save(defaults);

        assert.equal(readFileSync(store.file, "utf8"), `${JSON.stringify(defaults, null, 2)}\n`);
        assert.equal(statSync(store.file).ino, inode);
        assert.equal(statSync(store.file).mode & 0o777, 0o640);
        assert.equal(statSync(directory).mode & 0o777, 0o750);
    });

    test(`${label} read and write through existing symbolic and hard links`, (t) => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-defaults-io-"));
        t.after(() => rmSync(directory, {recursive: true, force: true}));
        const target = path.join(directory, "target.json");
        writeFileSync(target, JSON.stringify(defaults));
        chmodSync(target, 0o640);
        const inode = statSync(target).ino;
        for (const kind of ["symbolic", "hard"] as const) {
            const store = new Store(kind, directory);
            if (kind === "symbolic") symlinkSync(target, store.file);
            else linkSync(target, store.file);
            assert.deepEqual(store.load(), defaults);
            writeFileSync(target, "old contents".repeat(1000));

            store.save(defaults);

            assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(defaults, null, 2)}\n`);
            assert.equal(statSync(store.file).ino, inode);
            assert.equal(statSync(target).mode & 0o777, 0o640);
            assert.equal(lstatSync(store.file).isSymbolicLink(), kind === "symbolic");
        }
    });

    test(`${label} treat dangling links as absent and create their target on save`, (t) => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-defaults-io-"));
        t.after(() => rmSync(directory, {recursive: true, force: true}));
        const store = new Store("defaults", directory);
        const target = path.join(directory, "target.json");
        symlinkSync(target, store.file);
        assert.deepEqual(store.load(), defaults);

        store.save(defaults);

        assert.equal(lstatSync(store.file).isSymbolicLink(), true);
        assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(defaults, null, 2)}\n`);
    });

    test(`${label} wrap filesystem read and write failures with their original causes`, (t) => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-defaults-io-"));
        t.after(() => rmSync(directory, {recursive: true, force: true}));
        const store = new Store("defaults", directory);
        mkdirSync(store.file);

        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Unable to read ${label} from ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            assert.equal((error.cause as NodeJS.ErrnoException).code, "EISDIR");
            return true;
        });
        assert.throws(() => store.save(defaults), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Unable to save ${label} to ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            assert.equal((error.cause as NodeJS.ErrnoException).code, "EISDIR");
            return true;
        });
        assert.equal(statSync(store.file).isDirectory(), true);
    });

    test(`${label} do not mistake a non-directory parent for missing defaults or wrap mkdir failures`, (t) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "pilot-defaults-io-"));
        t.after(() => rmSync(root, {recursive: true, force: true}));
        const directory = path.join(root, "not-a-directory");
        writeFileSync(directory, "unchanged");
        const store = new Store("defaults", directory);

        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Unable to read ${label} from ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTDIR");
            return true;
        });
        assert.throws(() => store.save(defaults), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
            assert.equal((error as NodeJS.ErrnoException).syscall, "mkdir");
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.equal(readFileSync(directory, "utf8"), "unchanged");
    });
}
