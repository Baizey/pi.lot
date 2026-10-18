import assert from "node:assert/strict";
import {readdirSync} from "node:fs";
import test from "node:test";
import {TestRunner} from "../scripts/TestRunner.mjs";

const hostContracts = [
    "test/native-fuse.test.ts",
    "test/native-fuse-session-broker.test.ts",
    "test/bash-sandbox.test.ts",
    "test/network.test.ts",
];

function recorder(options = {}) {
    const commands = [];
    const runner = new TestRunner({
        run(command, arguments_) { commands.push([command, arguments_]); },
        hasFuse: () => true,
        log() {},
        ...options,
    });
    return {runner, commands};
}

function selectedTests(command) {
    assert.equal(command[0], process.execPath);
    assert.deepEqual(command[1].slice(0, 3), ["--import", "jiti/register", "--test"]);
    return command[1].slice(3);
}

test("full test profile builds once and executes every discovered file exactly once", () => {
    const {runner, commands} = recorder();
    runner.all();
    assert.equal(commands.length, 4);
    assert.deepEqual(commands[0], ["npm", ["run", "build"]]);
    assert.deepEqual(commands[1], ["cargo", ["test", "--locked", "--manifest-path", "native/rust/Cargo.toml"]]);
    const native = selectedTests(commands[2]);
    const runtime = selectedTests(commands[3]);
    const all = [...native, ...runtime];
    const discovered = readdirSync(new URL(".", import.meta.url))
        .filter((name) => /\.test\.(ts|mjs)$/.test(name))
        .map((name) => `test/${name}`);
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual([...all].sort(), discovered.sort());
    for (const file of hostContracts) {
        assert.equal(native.includes(file), false);
        assert.equal(runtime.includes(file), true);
    }
});

test("standalone runtime discovers both test extensions and retains native coverage", () => {
    const {runner, commands} = recorder({
        testFiles: () => ["z.test.mjs", "fixture.ts", "native-fuse-protocol.test.ts", "a.test.ts"],
    });
    runner.runtime();
    assert.equal(commands.length, 1);
    assert.deepEqual(selectedTests(commands[0]), [
        "test/a.test.ts", "test/native-fuse-protocol.test.ts", "test/z.test.mjs",
    ]);
});

test("native default builds before Rust units and stays mount-free", () => {
    const {runner, commands} = recorder();
    const files = runner.native();
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[0], [process.execPath, ["scripts/build-native.mjs"]]);
    assert.equal(commands[1][0], "cargo");
    assert.deepEqual(selectedTests(commands[2]), files);
    assert.equal(files.includes("test/native-fuse-callbacks.test.ts"), true);
    for (const file of hostContracts) assert.equal(files.includes(file), false);
});

test("native no-build still executes Rust units and contract tests", () => {
    const {runner, commands} = recorder();
    runner.native({build: false});
    assert.equal(commands.length, 2);
    assert.equal(commands[0][0], "cargo");
    assert.equal(selectedTests(commands[1]).includes("test/native-fuse-contract.test.ts"), true);
});

test("native host profile adds mounted contracts after the same Rust stage", () => {
    const {runner, commands} = recorder();
    runner.native({host: true, build: false});
    assert.equal(commands[0][0], "cargo");
    const files = selectedTests(commands[1]);
    for (const file of hostContracts) assert.equal(files.includes(file), true);
    assert.equal(new Set(files).size, files.length);
});

test("missing FUSE prevents any host build or test process", () => {
    const {runner, commands} = recorder({hasFuse: () => false});
    assert.throws(() => runner.native({host: true}), /normal Linux terminal outside pi.lot/);
    assert.deepEqual(commands, []);
});

test("full test profile stops at a failed build, Rust stage, or native contracts", () => {
    for (const failingStage of [0, 1, 2]) {
        const failure = new Error(`stage ${failingStage} failed`);
        const commands = [];
        const {runner} = recorder({
            run(command, arguments_) {
                commands.push([command, arguments_]);
                if (commands.length === failingStage + 1) throw failure;
            },
        });
        assert.throws(() => runner.all(), (error) => error === failure);
        assert.equal(commands.length, failingStage + 1);
    }
});
