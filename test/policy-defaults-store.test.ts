import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {initialPolicyDefaults, PolicyDefaultJsonStorage} from "../src/policy/defaults.js";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {ResponseType} from "../src/policy/types.js";
import type {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";

test("JSON policy defaults are absent until saved and round-trip exactly", () => {
    withStore((store) => {
        assert.deepEqual(store.load(), initialPolicyDefaults);

        const defaults = {
            ...initialPolicyDefaults,
            fs_read: ResponseType.deny,
            web_extra: ResponseType.allow,
        };
        store.save(defaults);

        assert.deepEqual(store.load(), defaults);
        assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), defaults);

        const updated = {...defaults, fs_write: ResponseType.allow};
        store.save(updated);
        assert.deepEqual(store.load(), updated);
    });
});

test("JSON policy defaults reject malformed JSON", () => {
    withStore((store) => {
        writeFileSync(store.file, "{");
        assert.throws(() => store.load(), /Invalid policy defaults/);
    });
});

test("policy runtime loads, saves, and resets active defaults through its store", () => {
    withStore((store) => {
        store.save({
            ...initialPolicyDefaults,
            fs_write: ResponseType.deny,
        });
        const runtime = new PolicyRuntime(emptyPolicyDao(), unusedDecisionFlow(), store);
        assert.equal(runtime.defaultResponses.fs_write, ResponseType.deny);

        runtime.setDefaultResponse("fs_write", ResponseType.allow);
        runtime.saveDefaultResponses();
        runtime.setDefaultResponse("fs_write", ResponseType.ask_user);

        runtime.resetDefaultResponses();
        assert.equal(runtime.defaultResponses.fs_write, ResponseType.allow);
    });
});

test("policy runtime resets to built-in defaults when no JSON file exists", () => {
    withStore((store) => {
        const runtime = new PolicyRuntime(emptyPolicyDao(), unusedDecisionFlow(), store);
        runtime.setDefaultResponse("fs_read", ResponseType.deny);

        runtime.resetDefaultResponses();
        assert.deepEqual(runtime.defaultResponses, initialPolicyDefaults);
    });
});

function withStore(run: (store: PolicyDefaultJsonStorage) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-policy-defaults-"));
    try {
        run(new PolicyDefaultJsonStorage("policy-defaults", directory));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}

function emptyPolicyDao(): PolicyDaoInterface {
    return {
        initializeSchema() {},
        loadPolicies: () => [],
        upsertPolicies() {},
        deletePolicy() {},
    };
}

function unusedDecisionFlow(): PolicyDecisionFlow {
    return {
        async askForPolicy(): Promise<never> {
            throw new Error("Unexpected policy decision request");
        },
    } as unknown as PolicyDecisionFlow;
}
