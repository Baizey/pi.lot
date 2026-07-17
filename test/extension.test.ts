import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import piSandboxExtension from "../src/extension.js";
import {SandboxPathAccessType} from "../src/bubblewrap/sandbox-runner.js";

type RegisteredBashTool = {
  name: string;
  execute: (
    id: string,
    params: {command: string; timeout?: number},
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};

test("the Pi extension routes bash resource accesses through blocking yes/no approval", async () => {
  let bashTool: RegisteredBashTool | undefined;
  const pi = {
    registerTool(tool: RegisteredBashTool) {
      bashTool = tool;
    },
  } as unknown as ExtensionAPI;
  piSandboxExtension(pi);
  assert.equal(bashTool?.name, "bash-bubblewrap");

  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-bubblewrap-extension-"));
  const allowedPath = path.join(workspace, "allowed.txt");
  const deniedPath = path.join(workspace, "denied.txt");
  const deletedPath = path.join(workspace, "deleted.txt");
  const prompts: string[] = [];
  const ctx = {
    cwd: workspace,
    hasUI: true,
    ui: {
      async confirm(_title: string, message: string) {
        prompts.push(message);
        return !message.split("\n").some((line) => line.startsWith(`${SandboxPathAccessType.WRITE}: ${deniedPath}`));
      },
    },
  } as unknown as ExtensionContext;

  try {
    await assert.rejects(
      bashTool!.execute(
        "test-call",
        {command: "printf 'allowed\\n' > allowed.txt; cat allowed.txt; touch deleted.txt; rm deleted.txt; printf 'denied\\n' > denied.txt"},
        undefined,
        undefined,
        ctx,
      ),
      /Command exited with code 1/,
    );

    assert.equal(readFileSync(allowedPath, "utf8"), "allowed\n");
    assert.equal(existsSync(deniedPath), false);
    assert.equal(existsSync(deletedPath), false);
    assert.equal(prompts.some((message) => message.split("\n").some((line) => line.startsWith(`${SandboxPathAccessType.WRITE}: ${allowedPath}`))), true);
    assert.equal(prompts.some((message) => message.split("\n").some((line) => line.startsWith(`${SandboxPathAccessType.READ}: ${allowedPath}`))), true);
    assert.equal(prompts.some((message) => message.split("\n").some((line) => line.startsWith(`${SandboxPathAccessType.WRITE}: ${deniedPath}`))), true);
    assert.equal(prompts.some((message) => message.split("\n").some((line) => line.startsWith(`${SandboxPathAccessType.DELETE}: ${deletedPath}`))), true);
    assert.equal(prompts.some((message) => message.includes(`${SandboxPathAccessType.EXECUTE}: /usr/bin/bash`)), true);
    assert.equal(prompts.every((message) => message.includes("paused in the kernel")), true);
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});
