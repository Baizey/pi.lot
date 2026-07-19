import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {registerExperiments} from "../src/experiment/registerExperiments.js";
import {FuseAccessType} from "../src/fuse/FuseFilesystem.js";

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

test("the bash-fuse experiment applies Pi approval before changing the host filesystem", async () => {
  const bashTool = registeredBashTools().get("bash-fuse");
  assert.ok(bashTool);

  const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-extension-"));
  const allowedPath = path.join(workspace, "allowed.txt");
  const deniedPath = path.join(workspace, "denied.txt");
  const prompts: string[] = [];
  const ctx = {
    cwd: workspace,
    hasUI: true,
    ui: {
      async confirm(_title: string, message: string) {
        prompts.push(message);
        return !message.split("\n").some((line) => line === `${FuseAccessType.WRITE}: ${deniedPath}`);
      },
    },
  } as unknown as ExtensionContext;

  try {
    await assert.rejects(
      bashTool.execute(
        "fuse-test-call",
        {command: "printf 'allowed\\n' > allowed.txt; printf 'denied\\n' > denied.txt"},
        undefined,
        undefined,
        ctx,
      ),
      /Command exited with code 1/,
    );

    assert.equal(readFileSync(allowedPath, "utf8"), "allowed\n");
    assert.equal(existsSync(deniedPath), false);
    assert.equal(prompts.some((message) => message.includes(`${FuseAccessType.WRITE}: ${allowedPath}`)), true);
    assert.equal(prompts.some((message) => message.includes(`${FuseAccessType.WRITE}: ${deniedPath}`)), true);
    assert.equal(prompts.every((message) => message.includes("paused in the kernel")), true);
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

function registeredBashTools(): Map<string, RegisteredBashTool> {
  const bashTools = new Map<string, RegisteredBashTool>();
  const pi = {
    registerTool(tool: RegisteredBashTool) {
      bashTools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  registerExperiments(pi);
  return bashTools;
}
