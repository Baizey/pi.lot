import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    HostCredentialIpcConfigStore,
    defaultHostCredentialIpcOptions,
} from "../src/policy/network/ipc/HostCredentialIpcConfig.js";

test("credential IPC config defaults to Secret Service and SSH agent protocols", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-ipc-config-default-test-"));
    try {
        const store = new HostCredentialIpcConfigStore(path.join(directory, "missing.json"));
        assert.deepEqual(store.load({}), defaultHostCredentialIpcOptions());
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("credential IPC config loads D-Bus names and extensible Unix socket declarations", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-ipc-config-test-"));
    const file = path.join(directory, "credential-ipc.json");
    writeFileSync(file, JSON.stringify({
        version: 1,
        sessionBus: {
            enabled: true,
            talk: ["org.freedesktop.secrets", "com.example.Wallet"],
        },
        unixSockets: [
            {id: "custom-agent", environment: "CUSTOM_AGENT_SOCK", optional: false},
            {id: "gpg-agent", path: "${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent"},
            {id: "disabled-agent", enabled: false, path: "/run/disabled.sock"},
        ],
    }));

    try {
        const store = new HostCredentialIpcConfigStore(file);
        assert.deepEqual(store.load({XDG_RUNTIME_DIR: "/run/user/1000"}), {
            sessionBus: {
                talk: ["org.freedesktop.secrets", "com.example.Wallet"],
            },
            unixSockets: [
                {id: "custom-agent", environment: "CUSTOM_AGENT_SOCK", optional: false},
                {id: "gpg-agent", path: "/run/user/1000/gnupg/S.gpg-agent", optional: true},
            ],
        });
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("credential IPC config can disable the session bus and all built-in sockets", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-ipc-config-disabled-test-"));
    const file = path.join(directory, "credential-ipc.json");
    writeFileSync(file, JSON.stringify({
        version: 1,
        sessionBus: {enabled: false, talk: []},
        unixSockets: [],
    }));

    try {
        const store = new HostCredentialIpcConfigStore(file);
        assert.deepEqual(store.load({}), {unixSockets: []});
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("credential IPC config rejects unsafe expansion and duplicate socket IDs", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-ipc-config-invalid-test-"));
    const file = path.join(directory, "credential-ipc.json");
    try {
        writeFileSync(file, JSON.stringify({
            version: 1,
            sessionBus: {enabled: true, talk: ["org.freedesktop.secrets"]},
            unixSockets: [{id: "bad", path: "$(id)/agent.sock"}],
        }));
        assert.throws(
            () => new HostCredentialIpcConfigStore(file).load({}),
            /Invalid credential IPC configuration/,
        );

        writeFileSync(file, JSON.stringify({
            version: 1,
            sessionBus: {enabled: true, talk: ["org.freedesktop.secrets"]},
            unixSockets: [
                {id: "duplicate", environment: "FIRST_SOCK"},
                {id: "duplicate", environment: "SECOND_SOCK"},
            ],
        }));
        assert.throws(
            () => new HostCredentialIpcConfigStore(file).load({}),
            /Invalid credential IPC configuration/,
        );
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
