import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {PolicyDefaultsCommand} from "../src/commands/PolicyDefaultsCommand.js";
import type {ResponseDefaults} from "../src/policy/types.js";
import {ResponseType} from "../src/policy/types.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";

type Completion = {
    value: string;
    label: string;
};

type RegisteredCommand = {
    getArgumentCompletions?: (prefix: string) => Completion[] | null | Promise<Completion[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

test("policy-defaults autocompletes responses and full response/key arguments", async () => {
    const defaults = initialDefaults();
    let runtimeRequests = 0;
    const command = registeredCommand(() => {
        runtimeRequests++;
        return runtime(defaults);
    });

    assert.deepEqual(await complete(command, "s"), [
        {value: "save", label: "save"},
    ]);
    assert.deepEqual(await complete(command, "r"), [
        {value: "reset", label: "reset"},
    ]);
    assert.deepEqual(await complete(command, "save "), []);
    assert.deepEqual(await complete(command, "a"), [
        {value: "allow", label: "allow"},
        {value: "ask_user", label: "ask_user"},
        {value: "ask_llm", label: "ask_llm"},
    ]);
    assert.deepEqual(
        (await complete(command, "allow "))?.map((item) => item.value),
        [
            "allow all",
            "allow fs_read",
            "allow fs_write",
            "allow web_read",
            "allow web_write",
            "allow web_extra",
        ],
    );
    assert.deepEqual(
        (await complete(command, "deny web_"))?.map((item) => item.value),
        ["deny web_read", "deny web_write", "deny web_extra"],
    );
    assert.equal((await complete(command, "ask_llm "))?.[0]?.value, "ask_llm all");
    assert.deepEqual(await complete(command, "allow fs_read "), []);
    assert.equal(runtimeRequests, 0);
});

test("policy-defaults reports and changes session defaults", async () => {
    const defaults = initialDefaults();
    const changes: Array<[keyof ResponseDefaults, ResponseType]> = [];
    const command = registeredCommand(() => runtime(defaults, (key, response) => {
        changes.push([key, response]);
    }));
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        ui: {
            notify(message: string, type: string) {
                notifications.push({message, type});
            },
        },
    } as unknown as ExtensionCommandContext;

    await command.handler("", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /fs_read = allow/);

    await command.handler("ALLOW FS_READ", ctx);
    assert.deepEqual(changes, [["fs_read", ResponseType.allow]]);
    assert.equal(defaults.fs_read, ResponseType.allow);
    assert.deepEqual(notifications.at(-1), {
        message: "Policy default fs_read = allow for this session.",
        type: "info",
    });

    await command.handler("ask_llm fs_read", ctx);
    assert.deepEqual(changes.at(-1), ["fs_read", ResponseType.ask_llm]);
    assert.equal(defaults.fs_read, ResponseType.ask_llm);
    assert.deepEqual(notifications.at(-1), {
        message: "Policy default fs_read = ask_llm for this session.",
        type: "info",
    });
});

test("policy-defaults saves and resets active defaults", async () => {
    const defaults = initialDefaults();
    const sessionRuntime = runtime(defaults);
    const command = registeredCommand(() => sessionRuntime);
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = {
        ui: {
            notify(message: string, type: string) {
                notifications.push({message, type});
            },
        },
    } as unknown as ExtensionCommandContext;

    await command.handler("deny all", ctx);
    await command.handler("save", ctx);
    assert.deepEqual(notifications.at(-1), {
        message: "Saved current policy defaults to ~/.pilot/policy-defaults.json.",
        type: "info",
    });

    await command.handler("allow all", ctx);
    await command.handler("reset", ctx);
    assert.deepEqual(defaults, Object.fromEntries(
        Object.keys(initialPolicyDefaults).map((key) => [key, ResponseType.deny]),
    ));
    assert.deepEqual(notifications.at(-1), {
        message: "Reset policy defaults from saved defaults.",
        type: "info",
    });

    await command.handler("save fs_read", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /^Usage: \/policy-defaults/);
    assert.equal(notifications.at(-1)?.type, "error");
});

function registeredCommand(runtimeProvider: ConstructorParameters<typeof PolicyDefaultsCommand>[1]): RegisteredCommand {
    let command: RegisteredCommand | undefined;
    const pi = {
        registerCommand(name: string, options: RegisteredCommand) {
            assert.equal(name, "policy-defaults");
            command = options;
        },
    } as unknown as ExtensionAPI;

    new PolicyDefaultsCommand(pi, runtimeProvider).register();
    assert.ok(command);
    return command;
}

async function complete(command: RegisteredCommand, prefix: string): Promise<Completion[] | null> {
    assert.ok(command.getArgumentCompletions);
    return command.getArgumentCompletions(prefix);
}

function initialDefaults(): ResponseDefaults {
    return structuredClone(initialPolicyDefaults);
}

function runtime(
    defaultResponses: ResponseDefaults,
    onChange?: (key: keyof ResponseDefaults, response: ResponseType) => void,
): PilotSessionRuntimeInterface {
    let savedDefaults: ResponseDefaults | null = null;
    return {
        policyRuntime: {
            defaultResponses,
            setDefaultResponse(key: keyof ResponseDefaults, response: ResponseType) {
                onChange?.(key, response);
                defaultResponses[key] = response;
            },
            saveDefaultResponses() {
                savedDefaults = structuredClone(defaultResponses);
            },
            resetDefaultResponses() {
                Object.assign(defaultResponses, savedDefaults ?? initialPolicyDefaults);
                return savedDefaults ? "saved" : "built-in";
            },
        },
        decisionFlows: undefined,
        toolDisplay: undefined,
        close() {},
    } as unknown as PilotSessionRuntimeInterface;
}
