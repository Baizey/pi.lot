import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {DefaultResourceLoader, SettingsManager} from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));

test("host-provided imports are wildcard peers with pinned development copies, never runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
        assert.equal(Object.hasOwn(manifest.dependencies, name), false, `${name} must resolve through Pi's host module mapping`);
        assert.equal(manifest.peerDependencies[name], "*", `${name} must not make managed installs solve another host copy`);
        assert.match(manifest.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} stays pinned for local development`);
    }
});

test("Pi loads the production package manifest without extension package warnings", async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-package-manifest-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory({packages: [root]}),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.extensions.some((extension) => extension.path === path.join(root, "src/pilot-extension.ts")),
        "the actual package extension must load, not just an inline factory");
    assert.deepEqual(loaded.warnings ?? [], []);
});
