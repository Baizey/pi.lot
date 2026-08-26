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

test("JSON subagent defaults reject malformed or unsupported mappings", () => {
    withStore((store) => {
        for (const value of [
            "{",
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
