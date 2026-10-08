import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {resolveNativeExecutable} from "../src/runtime/NativeExecutable.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function withImplementation(implementation: string | undefined, run: () => void): void {
    const previous = process.env.PILOT_NATIVE_IMPLEMENTATION;
    if (implementation === undefined) delete process.env.PILOT_NATIVE_IMPLEMENTATION;
    else process.env.PILOT_NATIVE_IMPLEMENTATION = implementation;
    try { run(); }
    finally {
        if (previous === undefined) delete process.env.PILOT_NATIVE_IMPLEMENTATION;
        else process.env.PILOT_NATIVE_IMPLEMENTATION = previous;
    }
}

test("native executable resolution defaults to Rust and never implicitly falls back to C", () => {
    withImplementation(undefined, () => {
        assert.equal(resolveNativeExecutable("pi-fuse-native"), path.join(root, "build/pi-fuse-native"));
        assert.equal(resolveNativeExecutable("does-not-exist"), path.join(root, "build/does-not-exist"));
    });
});

test("native contract tests can explicitly select the fixed C-reference directory", () => {
    withImplementation("c", () => {
        assert.equal(resolveNativeExecutable("pi-fuse-native"), path.join(root, "build/native-c/pi-fuse-native"));
    });
    withImplementation("rust", () => {
        assert.equal(resolveNativeExecutable("pi-fuse-native"), path.join(root, "build/pi-fuse-native"));
    });
});

test("native executable resolution rejects unsupported implementations", () => {
    for (const implementation of ["", "Rust", "other", "../outside"]) {
        withImplementation(implementation, () => assert.throws(() => resolveNativeExecutable("pi-fuse-native"), /Invalid PILOT_NATIVE_IMPLEMENTATION/));
    }
});
