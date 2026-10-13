import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {DefaultResourceLoader, SettingsManager} from "@earendil-works/pi-coding-agent";

test("bundled theme passes Pi's strict startup validation", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-theme-compatibility-"));
    const themePath = fileURLToPath(new URL("../themes/pilot-dark.json", import.meta.url));
    const themeJson = JSON.parse(readFileSync(themePath, "utf8"));
    assert.equal(themeJson.$schema, "https://pi.dev/schemas/theme.schema.json");
    const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: path.join(directory, "agent"),
        settingsManager: SettingsManager.inMemory(),
        additionalThemePaths: [themePath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    try {
        await loader.reload();
        const {themes, diagnostics} = loader.getThemes();
        assert.deepEqual(diagnostics, []);
        assert.equal(themes.length, 1);
        assert.equal(themes[0]?.name, "pilot-dark");
        assert.equal(themes[0]?.appearance, "dark");
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
