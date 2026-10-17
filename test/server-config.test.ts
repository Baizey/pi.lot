import assert from "node:assert/strict";
import {chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {ServerConfigError, ServerConfigStore} from "../src/server/ServerConfig.js";

const CONFIG = {url: "https://sessions.example.com", apiKey: "private-test-api-key"};

function fixture(t: test.TestContext): {directory: string; store: ServerConfigStore} {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-server-config-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    return {directory, store: new ServerConfigStore(directory)};
}

test("server config belongs to .pilot independently of the Pi agent directory", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "unrelated-pi-agent");
        assert.equal(new ServerConfigStore().file, path.join(os.homedir(), ".pilot", "server.json"));
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test("missing server config is logged out without creating files", (t) => {
    const {directory, store} = fixture(t);
    assert.equal(store.load(), undefined);
    assert.deepEqual(readdirSync(directory), []);
    store.logout();
    assert.deepEqual(readdirSync(directory), []);
});

test("server config stores only normalized URL and key with private permissions", (t) => {
    const {directory} = fixture(t);
    const pilotDirectory = path.join(directory, ".pilot");
    const store = new ServerConfigStore(pilotDirectory);
    store.save({url: " HTTPS://Sessions.Example.COM:443/ ", apiKey: " private-test-api-key "});
    assert.deepEqual(store.load(), CONFIG);
    assert.deepEqual(JSON.parse(readFileSync(store.file, "utf8")), CONFIG);
    assert.equal(statSync(pilotDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(pilotDirectory), ["server.json"]);
});

test("replacing existing configuration repairs permissions without modifying linked files", (t) => {
    const {directory, store} = fixture(t);
    const other = path.join(directory, "other.json");
    writeFileSync(other, "unrelated", {mode: 0o644});
    linkSync(other, store.file);
    assert.throws(() => store.load(), ServerConfigError);
    store.save(CONFIG);
    assert.equal(readFileSync(other, "utf8"), "unrelated");
    assert.equal(statSync(other).mode & 0o777, 0o644);
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    assert.deepEqual(store.load(), CONFIG);
});

test("saving replaces a symlink rather than writing credentials through it", (t) => {
    const {directory, store} = fixture(t);
    const other = path.join(directory, "other.json");
    writeFileSync(other, "unrelated");
    symlinkSync(other, store.file);
    assert.throws(() => store.load(), /Unable to read server configuration/);
    store.save(CONFIG);
    assert.equal(readFileSync(other, "utf8"), "unrelated");
    assert.deepEqual(store.load(), CONFIG);
});

test("logout removes only the connection config and is idempotent", (t) => {
    const {directory, store} = fixture(t);
    const session = path.join(directory, "session.jsonl");
    writeFileSync(session, "synthetic session");
    store.save(CONFIG);
    store.logout();
    store.logout();
    assert.equal(store.load(), undefined);
    assert.equal(readFileSync(session, "utf8"), "synthetic session");
    assert.deepEqual(readdirSync(directory), ["session.jsonl"]);
});

test("logout removes a credential symlink without removing its target", (t) => {
    const {directory, store} = fixture(t);
    const other = path.join(directory, "other.json");
    writeFileSync(other, "unrelated");
    symlinkSync(other, store.file);
    store.logout();
    assert.equal(readFileSync(other, "utf8"), "unrelated");
    assert.equal(existsSync(store.file), false);
});

test("HTTP and HTTPS are accepted for configured local, LAN, and remote servers", (t) => {
    const {store} = fixture(t);
    for (const url of [
        "https://sessions.example.com", "http://sessions.example.com", "http://localhost:8080",
        "http://192.168.1.10:8080", "http://127.0.0.1:8080", "http://[::1]:8080",
    ]) {
        store.save({...CONFIG, url});
        assert.equal(store.load()?.url, url);
    }
});

test("invalid URLs and credentials leave the previous config untouched", (t) => {
    const {store} = fixture(t);
    store.save(CONFIG);
    const invalid = [
        {...CONFIG, url: ""}, {...CONFIG, url: "not a URL"},
        {...CONFIG, url: "file:///tmp/server"}, {...CONFIG, url: "ftp://sessions.example.com"},
        {...CONFIG, url: "https://user:private-test-api-key@sessions.example.com"},
        {...CONFIG, url: "https://sessions.example.com/api"},
        {...CONFIG, url: "https://sessions.example.com?token=private-test-api-key"},
        {...CONFIG, url: "https://sessions.example.com#private-test-api-key"},
        {...CONFIG, apiKey: " "}, {...CONFIG, apiKey: "key with spaces"},
        {...CONFIG, apiKey: "key\nline"}, {...CONFIG, apiKey: "key\x00"},
        {...CONFIG, apiKey: "x".repeat(4097)},
        {...CONFIG, version: "0.1.1"},
    ];
    for (const config of invalid) {
        assert.throws(() => store.save(config), (error: unknown) => {
            assert.ok(error instanceof ServerConfigError);
            assert.equal(error.message.includes(CONFIG.apiKey), false);
            return true;
        });
        assert.deepEqual(store.load(), CONFIG);
    }
});

test("malformed, incomplete, oversized or nonprivate JSON is rejected without leaking its contents", (t) => {
    const {store} = fixture(t);
    const malformed = [
        CONFIG.apiKey, "null", "[]", "{}", JSON.stringify({url: CONFIG.url}),
        JSON.stringify({apiKey: CONFIG.apiKey}), JSON.stringify({...CONFIG, version: "0.1.1"}),
        JSON.stringify({...CONFIG, apiKey: 42}), " ".repeat(16385),
    ];
    for (const contents of malformed) {
        writeFileSync(store.file, contents, {mode: 0o600});
        assert.throws(() => store.load(), (error: unknown) => {
            assert.ok(error instanceof ServerConfigError);
            assert.equal(error.message.includes(CONFIG.apiKey), false);
            assert.equal(error.cause, undefined);
            return true;
        });
    }
    store.save(CONFIG);
    chmodSync(store.file, 0o644);
    assert.throws(() => store.load(), /Invalid server configuration/);
});

test("configuration directories and failed replacements are not silently accepted", (t) => {
    const {directory, store} = fixture(t);
    mkdirSync(store.file);
    assert.throws(() => store.load(), ServerConfigError);
    assert.throws(() => store.save(CONFIG), /Unable to save server configuration/);
    assert.deepEqual(readdirSync(directory), ["server.json"]);
    assert.throws(() => store.logout(), /Unable to remove server configuration/);
});
