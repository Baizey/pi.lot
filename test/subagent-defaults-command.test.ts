import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionAPI, ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {SubagentDefaultsCommand} from "../src/commands/SubagentDefaultsCommand.js";
import {
    AUTO_SUBAGENT_MODEL,
    type SubagentDefaultValues,
    SubagentDefaultsRuntime,
    type SubagentDefaultsStore,
    initialSubagentDefaults,
} from "../src/subagents/SubagentDefaults.js";

const MODELS = ["provider/cheap", "provider/strong", "other/model"];

type Completion = {value: string; label: string};
type RegisteredCommand = {
    getArgumentCompletions?: (prefix: string) => Completion[] | null | Promise<Completion[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

test("subagent-defaults autocompletes actions, auto, authenticated models, and skills", async () => {
    const command = registeredCommand(new SubagentDefaultsRuntime(memoryStore()), () => MODELS);

    assert.deepEqual(await complete(command, "s"), [{value: "save", label: "save"}]);
    assert.deepEqual(await complete(command, "a"), [{value: "auto", label: "auto"}]);
    assert.deepEqual(await complete(command, "provider/"), [
        {value: "provider/cheap", label: "provider/cheap"},
        {value: "provider/strong", label: "provider/strong"},
    ]);
    assert.deepEqual(
        (await complete(command, "auto "))?.map((item) => item.value),
        ["auto all", "auto min", "auto low", "auto mid", "auto high", "auto max"],
    );
    assert.deepEqual(await complete(command, "other/model h"), [
        {value: "other/model high", label: "high"},
    ]);
    assert.deepEqual(await complete(command, "save "), []);
    assert.equal(await complete(command, "missing/model "), null);
});

test("subagent-defaults reports and changes exact or automatic skill mappings", async () => {
    const defaults = new SubagentDefaultsRuntime(memoryStore());
    const command = registeredCommand(defaults, () => MODELS);
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = commandContext(notifications);

    await command.handler("", ctx);
    assert.equal(notifications.at(-1)?.message, [
        "Subagent defaults for this session:",
        "min = provider/min (auto)",
        "low = provider/low (auto)",
        "mid = provider/mid (auto)",
        "high = provider/high (auto)",
        "max = provider/max (auto)",
    ].join("\n"));

    await command.handler("OTHER/MODEL HIGH", ctx);
    assert.equal(defaults.values.high, "other/model");
    assert.deepEqual(notifications.at(-1), {
        message: "Subagent default high = other/model for this session.",
        type: "info",
    });

    await command.handler("AUTO ALL", ctx);
    assert.equal(Object.values(defaults.values).every((value) => value === AUTO_SUBAGENT_MODEL), true);

    await command.handler("unqualified mid", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /^Usage: \/subagent-defaults/);
    assert.equal(notifications.at(-1)?.type, "error");
});

test("subagent-defaults saves and resets active mappings", async () => {
    const store = memoryStore();
    const defaults = new SubagentDefaultsRuntime(store);
    const command = registeredCommand(defaults, () => MODELS);
    const notifications: Array<{message: string; type: string}> = [];
    const ctx = commandContext(notifications);

    await command.handler("provider/cheap low", ctx);
    await command.handler("save", ctx);
    assert.deepEqual(notifications.at(-1), {
        message: "Saved current subagent defaults to ~/.pilot/subagent-defaults.json.",
        type: "info",
    });

    await command.handler("auto low", ctx);
    await command.handler("reset", ctx);
    assert.equal(defaults.values.low, "provider/cheap");
    assert.deepEqual(notifications.at(-1), {
        message: "Reset subagent defaults.",
        type: "info",
    });
});

function registeredCommand(
    defaults: SubagentDefaultsRuntime,
    availableModels: () => readonly string[],
): RegisteredCommand {
    let command: RegisteredCommand | undefined;
    const pi = {
        registerCommand(name: string, options: RegisteredCommand) {
            assert.equal(name, "subagent-defaults");
            command = options;
        },
    } as unknown as ExtensionAPI;
    new SubagentDefaultsCommand(
        pi,
        () => defaults,
        availableModels,
        async (skill) => `provider/${skill}`,
    ).register();
    assert.ok(command);
    return command;
}

async function complete(command: RegisteredCommand, prefix: string): Promise<Completion[] | null> {
    assert.ok(command.getArgumentCompletions);
    return command.getArgumentCompletions(prefix);
}

function commandContext(notifications: Array<{message: string; type: string}>): ExtensionCommandContext {
    return {
        ui: {
            notify(message: string, type: string) {
                notifications.push({message, type});
            },
        },
    } as unknown as ExtensionCommandContext;
}

function memoryStore(initial: SubagentDefaultValues = {...initialSubagentDefaults}): SubagentDefaultsStore {
    let persisted = structuredClone(initial);
    return {
        load: () => structuredClone(persisted),
        save(defaults) {
            persisted = structuredClone(defaults);
        },
    };
}
