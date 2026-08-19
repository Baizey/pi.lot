import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {NetworkInspectionCommand} from "../src/commands/NetworkInspectionCommand.js";
import {initialPolicyDefaults} from "../src/policy/defaults.js";
import {PilotSessionRuntime} from "../src/runtime/PilotSessionRuntime.js";
import type {PilotSessionRuntimeInterface} from "../src/runtime/PilotSessionRuntime.js";
import {SqliteDatabase} from "../src/storage/sqlite.js";

type Completion = {value: string; label: string};
type RegisteredCommand = {
    getArgumentCompletions?: (prefix: string) => Completion[] | null | Promise<Completion[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

test("session runtime enables full network inspection by default", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-network-inspection-runtime-"));
    const runtime = new PilotSessionRuntime({cwd: directory} as ExtensionContext, {
        openDatabase: () => SqliteDatabase.test(false, path.join(directory, "pilot.sqlite")),
        policyDefaultsStore: {load: () => structuredClone(initialPolicyDefaults), save() {}},
    });
    try {
        assert.equal(runtime.fullNetworkInspection, true);
        runtime.setFullNetworkInspection(false);
        assert.equal(runtime.fullNetworkInspection, false);
    } finally {
        runtime.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test("network-inspection command reports and changes the session flag", async () => {
    let enabled = true;
    let runtimeRequests = 0;
    const runtime = {
        get fullNetworkInspection() {
            return enabled;
        },
        setFullNetworkInspection(value: boolean) {
            enabled = value;
        },
    } as unknown as PilotSessionRuntimeInterface;
    const command = registeredCommand(() => {
        runtimeRequests++;
        return runtime;
    });
    const notifications: Array<{message: string; type: string}> = [];
    const context = {
        ui: {
            notify(message: string, type: string) {
                notifications.push({message, type});
            },
        },
    } as unknown as ExtensionCommandContext;

    assert.deepEqual(await complete(command, ""), [
        {value: "on", label: "on"},
        {value: "off", label: "off"},
    ]);
    assert.deepEqual(await complete(command, "of"), [{value: "off", label: "off"}]);
    assert.deepEqual(await complete(command, "on "), []);
    assert.equal(runtimeRequests, 0);

    await command.handler("", context);
    assert.match(notifications.at(-1)?.message ?? "", /inspection is on/);

    await command.handler("OFF", context);
    assert.equal(enabled, false);
    assert.match(notifications.at(-1)?.message ?? "", /HTTPS remains end-to-end/);

    await command.handler("on", context);
    assert.equal(enabled, true);

    await command.handler("invalid", context);
    assert.equal(enabled, true);
    assert.match(notifications.at(-1)?.message ?? "", /^Usage: \/network-inspection/);
    assert.equal(notifications.at(-1)?.type, "error");
});

function registeredCommand(
    runtime: ConstructorParameters<typeof NetworkInspectionCommand>[1],
): RegisteredCommand {
    let command: RegisteredCommand | undefined;
    const pi = {
        registerCommand(name: string, options: RegisteredCommand) {
            assert.equal(name, "network-inspection");
            command = options;
        },
    } as unknown as ExtensionAPI;
    new NetworkInspectionCommand(pi, runtime).register();
    assert.ok(command);
    return command;
}

async function complete(command: RegisteredCommand, prefix: string): Promise<Completion[] | null> {
    assert.ok(command.getArgumentCompletions);
    return command.getArgumentCompletions(prefix);
}
