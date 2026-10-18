import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {initialPolicyDefaults, PolicyDefaultJsonStorage} from "../src/policy/defaults.js";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResolutionSource,
    PolicyResponse,
} from "../src/policy/types.js";
import type {QueuedPolicyApproval} from "../src/policy/PolicyDecisionFlow.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";

test("JSON policy defaults are absent until saved and round-trip exactly", () => {
    withStore((store) => {
        assert.deepEqual(store.load(), initialPolicyDefaults);

        const defaults = {
            ...initialPolicyDefaults,
            fs_read: PolicyFallbackResponse.deny,
            web_smtp: PolicyFallbackResponse.allow,
        };
        store.save(defaults);

        assert.deepEqual(store.load(), defaults);
        assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), defaults);

        const updated = {...defaults, fs_write: PolicyFallbackResponse.allow};
        store.save(updated);
        assert.deepEqual(store.load(), updated);
    });
});

test("missing policy defaults share the frozen built-in object across stores", () => {
    withStore((store) => {
        const defaults = store.load();
        const other = new PolicyDefaultJsonStorage("other-defaults", path.dirname(store.file));
        assert.strictEqual(defaults, initialPolicyDefaults);
        assert.strictEqual(store.load(), defaults);
        assert.strictEqual(other.load(), defaults);
        assert.equal(Object.isFrozen(defaults), true);
        assert.equal(Reflect.set(defaults, "fs_read", PolicyFallbackResponse.deny), false);
        assert.equal(store.load().fs_read, PolicyFallbackResponse.allow);
    });
});

test("JSON policy defaults retain permissive parsing without merging or validation", () => {
    withStore((store) => {
        for (const value of [{fs_write: "deny"}, {unexpected: "value"}, null, [], "allow", 42]) {
            writeFileSync(store.file, JSON.stringify(value));
            assert.deepEqual(store.load(), value);
        }
        store.save({...initialPolicyDefaults});
        const defaults = store.load();
        assert.notStrictEqual(store.load(), defaults);
        assert.equal(Object.isFrozen(defaults), false);
        defaults.fs_read = PolicyFallbackResponse.deny;
        assert.equal(store.load().fs_read, PolicyFallbackResponse.allow);
    });
});

test("JSON policy defaults reject malformed JSON with its parse error as cause", () => {
    withStore((store) => {
        writeFileSync(store.file, "{");
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, `Invalid policy defaults in ${store.file}.`);
            assert.ok(error.cause instanceof SyntaxError);
            return true;
        });
    });
});

test("policy runtime loads, saves, and resets active defaults through its store", () => {
    withStore((store) => {
        store.save({
            ...initialPolicyDefaults,
            fs_write: PolicyFallbackResponse.deny,
        });
        const runtime = new PolicyRuntime("defaults-test-agent", emptyPolicyDao(), unusedDecisionFlow(), store);
        assert.equal(runtime.defaultResponses.fs_write, PolicyFallbackResponse.deny);

        runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);
        runtime.saveDefaultResponses();
        runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);

        runtime.resetDefaultResponses();
        assert.equal(runtime.defaultResponses.fs_write, PolicyFallbackResponse.allow);
    });
});

test("a persisted ask_llm default routes policy misses to the structured reviewer", async () => {
    await withAsyncStore(async (store) => {
        store.save({...initialPolicyDefaults, fs_write: PolicyFallbackResponse.ask_llm});
        const target = path.join(os.tmpdir(), "pilot-persisted-ask-llm", "file.ts");
        let reviews = 0;
        const runtime = new PolicyRuntime("defaults-test-agent", emptyPolicyDao(), unusedDecisionFlow(), store);
        runtime.setAgentDecisionFlow({
            async askForPolicy(request) {
                reviews++;
                return {
                    uri: request.allowedScopes[0]!,
                    accessType: request.accessType,
                    lifetime: PolicyLifetime.ONCE,
                    status: PolicyResponse.ALLOWED,
                    reason: "Persisted ask_llm default reviewed the request.",
                };
            },
        });

        const result = await runtime.beginToolCall("defaults-test-agent")(
            target,
            PolicyAccessType.FS_WRITE,
        );

        assert.equal(runtime.defaultResponses.fs_write, PolicyFallbackResponse.ask_llm);
        assert.equal(result.matchedStatus, PolicyResponse.ALLOWED);
        assert.equal(result.resolutionSource, PolicyResolutionSource.NEW_DEFAULT_LLM_DECISION);
        assert.equal(reviews, 1);
    });
});

test("policy runtime resets to built-in defaults when no JSON file exists", () => {
    withStore((store) => {
        const runtime = new PolicyRuntime("defaults-test-agent", emptyPolicyDao(), unusedDecisionFlow(), store);
        runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.deny);

        runtime.resetDefaultResponses();
        assert.deepEqual(runtime.defaultResponses, initialPolicyDefaults);
    });
});

async function withAsyncStore(
    run: (store: PolicyDefaultJsonStorage) => Promise<void>,
): Promise<void> {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-policy-defaults-"));
    try {
        await run(new PolicyDefaultJsonStorage("policy-defaults", directory));
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}

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
        initializeSchema() {
        },
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
    };
}

function unusedDecisionFlow(): QueuedPolicyApproval {
    return {
        async resolveQueuedPolicy(): Promise<never> {
            throw new Error("Unexpected policy decision request");
        },
    };
}
