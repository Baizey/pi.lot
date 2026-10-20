import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    DisplayDefaultsJsonStore,
    DisplayDefaultsRuntime,
    initialDisplayDefaults,
} from "../src/tui/tool/DisplayDefaults.js";
import {ToolDisplayMode} from "../src/tui/tool/ToolDisplayMode.js";
import {ToolDisplayModes} from "../src/tui/tool/ToolDisplayModes.js";

test("missing display defaults return fresh mutable copies of the frozen factory pair", () => {
    withStore((store) => {
        assert.deepEqual(initialDisplayDefaults, {
            normal: ToolDisplayMode.MINIMAL,
            alternate: ToolDisplayMode.TRUNCATED,
        });
        assert.equal(Object.isFrozen(initialDisplayDefaults), true);
        const first = store.load();
        const second = store.load();
        const other = new DisplayDefaultsJsonStore("other-defaults", path.dirname(store.file));
        assert.deepEqual(first, initialDisplayDefaults);
        assert.notStrictEqual(first, initialDisplayDefaults);
        assert.notStrictEqual(first, second);
        assert.notStrictEqual(first, other.load());
        assert.equal(Object.isFrozen(first), false);
        first.normal = ToolDisplayMode.FULL;
        first.alternate = ToolDisplayMode.HIDDEN;
        assert.deepEqual(second, initialDisplayDefaults);
        assert.deepEqual(store.load(), initialDisplayDefaults);
        assert.deepEqual(other.load(), initialDisplayDefaults);
        assert.equal(existsSync(store.file), false);
    });
});

test("JSON display defaults round-trip every mode pair, including identical sides", () => {
    withStore((store) => {
        for (const normal of Object.values(ToolDisplayMode)) {
            for (const alternate of Object.values(ToolDisplayMode)) {
                const views = {normal, alternate};
                store.save(views);
                assert.deepEqual(store.load(), views);
                assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), views);
                const loaded = store.load();
                assert.notStrictEqual(loaded, views);
                assert.notStrictEqual(store.load(), loaded);
            }
        }
    });
});

test("JSON display defaults create missing parent directories when saved", () => {
    withStore((store) => {
        const nested = new DisplayDefaultsJsonStore("display-defaults", path.join(path.dirname(store.file), "nested"));
        nested.save(initialDisplayDefaults);
        assert.deepEqual(nested.load(), initialDisplayDefaults);
    });
});

test("JSON display defaults reject malformed JSON and strict schema violations", () => {
    withStore((store) => {
        for (const contents of [
            "{",
            "null",
            "[]",
            "42",
            '"minimal"',
            "true",
            "{}",
            JSON.stringify({normal: ToolDisplayMode.MINIMAL}),
            JSON.stringify({alternate: ToolDisplayMode.TRUNCATED}),
            JSON.stringify({primary: ToolDisplayMode.MINIMAL, alternate: ToolDisplayMode.TRUNCATED}),
            JSON.stringify({...initialDisplayDefaults, expanded: true}),
            JSON.stringify({...initialDisplayDefaults, pilotFullDisplay: false}),
            JSON.stringify({...initialDisplayDefaults, unexpected: "minimal"}),
            ...["", "MINIMAL", "unknown", null, true, 0, [], {}].flatMap((value) => [
                JSON.stringify({...initialDisplayDefaults, normal: value}),
                JSON.stringify({...initialDisplayDefaults, alternate: value}),
            ]),
        ]) {
            writeFileSync(store.file, contents);
            assert.throws(() => store.load(), /Invalid display defaults/, contents);
        }
    });
});

test("JSON display defaults preserve parse and validation error causes", () => {
    withStore((store) => {
        writeFileSync(store.file, "{");
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Invalid display defaults in ${store.file}.`);
            assert.ok(error.cause instanceof SyntaxError);
            return true;
        });
        writeFileSync(store.file, JSON.stringify({...initialDisplayDefaults, normal: "unknown"}));
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Invalid display defaults in ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            return true;
        });
    });
});

test("JSON display defaults propagate read and save failures instead of using factory defaults", () => {
    withStore((store) => {
        // A directory at the file path fails reliably without relying on permission bits.
        mkdirSync(store.file);
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Unable to read display defaults from ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            return true;
        });
        assert.throws(() => store.save(initialDisplayDefaults), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Unable to save display defaults to ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            return true;
        });
    });
});

test("display defaults runtime loads saved views into the supplied modes and returns snapshots", () => {
    withStore((store) => {
        const saved = {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.FULL};
        store.save(saved);
        const modes = new ToolDisplayModes();
        const runtime = new DisplayDefaultsRuntime(modes, store);
        assert.deepEqual(runtime.values, saved);
        assert.deepEqual(modes.values, saved);
        const snapshot = runtime.values;
        assert.notStrictEqual(runtime.values, snapshot);
        assert.notStrictEqual(modes.values, snapshot);
        snapshot.normal = ToolDisplayMode.MINIMAL;
        assert.deepEqual(runtime.values, saved);
        const modesSnapshot = modes.values;
        modesSnapshot.alternate = ToolDisplayMode.MINIMAL;
        assert.deepEqual(modes.values, saved);
        modes.setViews(ToolDisplayMode.FULL, ToolDisplayMode.HIDDEN);
        assert.deepEqual(runtime.values, {normal: ToolDisplayMode.FULL, alternate: ToolDisplayMode.HIDDEN});
    });
});

test("display defaults runtime changes are not persisted until explicitly saved", () => {
    withStore((store) => {
        const runtime = new DisplayDefaultsRuntime(new ToolDisplayModes(), store);
        assert.deepEqual(runtime.values, initialDisplayDefaults);
        runtime.setViews(ToolDisplayMode.HIDDEN, ToolDisplayMode.HIDDEN);
        assert.equal(existsSync(store.file), false);
        assert.deepEqual(store.load(), initialDisplayDefaults);
        runtime.save();
        const saved = {normal: ToolDisplayMode.HIDDEN, alternate: ToolDisplayMode.HIDDEN};
        assert.deepEqual(store.load(), saved);
        runtime.setViews(ToolDisplayMode.FULL, ToolDisplayMode.MINIMAL);
        assert.deepEqual(store.load(), saved);
        runtime.reset();
        assert.deepEqual(runtime.values, saved);
        assert.deepEqual(new DisplayDefaultsRuntime(new ToolDisplayModes(), store).values, saved);
    });
});

test("display defaults reset reloads disk changes and restores factory views when the file is missing", () => {
    withStore((store) => {
        const runtime = new DisplayDefaultsRuntime(new ToolDisplayModes(), store);
        runtime.setViews(ToolDisplayMode.FULL, ToolDisplayMode.FULL);
        runtime.reset();
        assert.deepEqual(runtime.values, initialDisplayDefaults);
        const saved = {normal: ToolDisplayMode.TRUNCATED, alternate: ToolDisplayMode.MINIMAL};
        store.save(saved);
        runtime.reset();
        assert.deepEqual(runtime.values, saved);
        rmSync(store.file);
        runtime.reset();
        assert.deepEqual(runtime.values, initialDisplayDefaults);
        assert.equal(existsSync(store.file), false);
    });
});

test("display defaults notify mode listeners only when the pair changes", () => {
    withStore((store) => {
        const modes = new ToolDisplayModes();
        const runtime = new DisplayDefaultsRuntime(modes, store);
        const notifications: ReturnType<typeof store.load>[] = [];
        const unsubscribe = modes.subscribe(() => notifications.push(modes.values));
        runtime.setViews(ToolDisplayMode.FULL, ToolDisplayMode.HIDDEN);
        assert.deepEqual(notifications, [{normal: ToolDisplayMode.FULL, alternate: ToolDisplayMode.HIDDEN}]);
        runtime.setViews(ToolDisplayMode.FULL, ToolDisplayMode.HIDDEN);
        runtime.save();
        runtime.reset();
        assert.equal(notifications.length, 1);
        store.save(initialDisplayDefaults);
        runtime.reset();
        assert.deepEqual(notifications, [
            {normal: ToolDisplayMode.FULL, alternate: ToolDisplayMode.HIDDEN},
            initialDisplayDefaults,
        ]);
        unsubscribe();
        runtime.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.FULL);
        assert.equal(notifications.length, 2);
    });
});

test("failed display defaults resets leave both views unchanged and do not notify listeners", () => {
    withStore((store) => {
        const modes = new ToolDisplayModes();
        const runtime = new DisplayDefaultsRuntime(modes, store);
        runtime.setViews(ToolDisplayMode.FULL, ToolDisplayMode.HIDDEN);
        const before = runtime.values;
        let notifications = 0;
        modes.subscribe(() => notifications++);
        for (const contents of ["{", JSON.stringify({normal: ToolDisplayMode.MINIMAL, alternate: "invalid"})]) {
            writeFileSync(store.file, contents);
            assert.throws(() => runtime.reset(), /Invalid display defaults/);
            assert.deepEqual(runtime.values, before);
            assert.deepEqual(modes.values, before);
            assert.equal(notifications, 0);
        }
        rmSync(store.file);
        mkdirSync(store.file);
        assert.throws(() => runtime.reset(), /Unable to read display defaults/);
        assert.deepEqual(runtime.values, before);
        assert.deepEqual(modes.values, before);
        assert.equal(notifications, 0);
    });
});

test("display defaults save only the view pair, not active-side or per-tool expansion state", () => {
    withStore((store) => {
        const modes = new ToolDisplayModes();
        const runtime = new DisplayDefaultsRuntime(modes, store);
        runtime.setViews(ToolDisplayMode.MINIMAL, ToolDisplayMode.TRUNCATED);
        assert.equal(modes.resolve(false), ToolDisplayMode.MINIMAL);
        assert.equal(modes.resolve(true), ToolDisplayMode.TRUNCATED);
        assert.equal(modes.resolve(false, {pilotFullDisplay: true}), ToolDisplayMode.FULL);
        runtime.save();
        assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), {
            normal: ToolDisplayMode.MINIMAL,
            alternate: ToolDisplayMode.TRUNCATED,
        });
        assert.deepEqual(runtime.values, initialDisplayDefaults);
        const reloadedModes = new ToolDisplayModes();
        new DisplayDefaultsRuntime(reloadedModes, store);
        assert.equal(reloadedModes.resolve(false), ToolDisplayMode.MINIMAL);
        assert.equal(reloadedModes.resolve(true), ToolDisplayMode.TRUNCATED);
    });
});

function withStore(run: (store: DisplayDefaultsJsonStore) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-display-defaults-"));
    try {
        run(new DisplayDefaultsJsonStore("display-defaults", directory));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}
