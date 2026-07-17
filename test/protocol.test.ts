import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSandboxEvent,
  SandboxOperation,
  SandboxPathAccessType,
} from "../src/bubblewrap/sandbox-runner.js";

test("protocol v2 parses typed path accesses", () => {
  const event = parseSandboxEvent(JSON.stringify({
    version: 2,
    sequence: 7,
    pid: 42,
    syscall: "renameat2",
    operation: SandboxOperation.FILESYSTEM,
    pathAccesses: [
      {access: SandboxPathAccessType.DELETE, path: "/workspace/old", sandboxPrivate: false},
      {access: SandboxPathAccessType.WRITE, path: "/workspace/new", sandboxPrivate: false},
    ],
  }));

  assert.deepEqual(event.pathAccesses.map(({access, path}) => ({access, path})), [
    {access: SandboxPathAccessType.DELETE, path: "/workspace/old"},
    {access: SandboxPathAccessType.WRITE, path: "/workspace/new"},
  ]);
});

test("protocol rejects untyped or unsupported path accesses", () => {
  const base = {
    version: 2,
    sequence: 1,
    pid: 1,
    syscall: "openat",
    operation: SandboxOperation.FILESYSTEM,
  };
  assert.throws(() => parseSandboxEvent(JSON.stringify({...base, pathAccesses: [{path: "/x", sandboxPrivate: false}]})));
  assert.throws(() => parseSandboxEvent(JSON.stringify({...base, pathAccesses: [{access: "EDIT", path: "/x", sandboxPrivate: false}]})));
  assert.throws(() => parseSandboxEvent(JSON.stringify({...base, version: 1, pathAccesses: []})));
});
