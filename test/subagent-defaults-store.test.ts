import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    initialSubagentDefaults,
    SubagentDefaultsJsonStore,
    SubagentDefaultsRuntime,
} from "../src/subagents/SubagentDefaults.js";
import {SubagentReasoningSkill} from "../src/subagents/SubagentReasoning.js";

test("JSON subagent defaults are auto until saved and round-trip exact model mappings", () => {
    withStore((store) => {
        assert.deepEqual(store.load(), initialSubagentDefaults);
        const defaults = {
            ...initialSubagentDefaults,
            low: "provider/cheap",
            max: "provider/strong",
        };

        store.save(defaults);

        assert.deepEqual(store.load(), defaults);
        assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), defaults);
    });
});

test("missing subagent defaults are fresh mutable copies across loads and stores", () => {
    withStore((store) => {
        const defaults = store.load();
        const other = new SubagentDefaultsJsonStore("other-defaults", path.dirname(store.file));
        assert.notStrictEqual(defaults, initialSubagentDefaults);
        assert.notStrictEqual(store.load(), defaults);
        assert.notStrictEqual(other.load(), defaults);
        assert.equal(Object.isFrozen(defaults), false);
        defaults.mid = "provider/balanced";
        assert.equal(store.load().mid, "auto");
        assert.equal(other.load().mid, "auto");
        assert.equal(initialSubagentDefaults.mid, "auto");
        assert.equal(Object.isFrozen(initialSubagentDefaults), true);

        const runtime = new SubagentDefaultsRuntime(store);
        const activeValues = runtime.values;
        runtime.set(SubagentReasoningSkill.MID, "provider/balanced");
        runtime.reset();
        assert.strictEqual(runtime.values, activeValues);
        assert.deepEqual(runtime.values, initialSubagentDefaults);
    });
});

test("JSON subagent defaults preserve parse and validation error causes", () => {
    withStore((store) => {
        writeFileSync(store.file, "{");
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Invalid subagent defaults in ${store.file}.`);
            assert.ok(error.cause instanceof SyntaxError);
            return true;
        });
        writeFileSync(store.file, JSON.stringify({...initialSubagentDefaults, mid: "bare-model"}));
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Invalid subagent defaults in ${store.file}.`);
            assert.ok(error.cause instanceof Error);
            assert.equal(error.cause.message, "mid must be auto or a canonical provider/model");
            return true;
        });
    });
});

test("JSON subagent defaults reject malformed or unsupported mappings", () => {
    withStore((store) => {
        for (const value of [
            "{",
            "null",
            "[]",
            "42",
            JSON.stringify({...initialSubagentDefaults, unexpected: "auto"}),
            JSON.stringify({...initialSubagentDefaults, mid: "bare-model"}),
            JSON.stringify({...initialSubagentDefaults, high: ""}),
            JSON.stringify({min: "auto"}),
        ]) {
            writeFileSync(store.file, value);
            assert.throws(() => store.load(), /Invalid subagent defaults/);
        }
    });
});

test("subagent defaults runtime saves and resets active mappings", () => {
    withStore((store) => {
        const defaults = new SubagentDefaultsRuntime(store);
        defaults.set(SubagentReasoningSkill.MID, "provider/balanced");
        defaults.save();
        defaults.set(SubagentReasoningSkill.MID, "auto");

        defaults.reset();

        assert.equal(defaults.values.mid, "provider/balanced");
    });
});

function withStore(run: (store: SubagentDefaultsJsonStore) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-subagent-defaults-"));
    try {
        run(new SubagentDefaultsJsonStore("subagent-defaults", directory));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}
