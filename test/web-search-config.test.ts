import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    defaultWebSearchConfig,
    defaultWebSearchConfigFile,
    loadWebSearchConfig,
} from "../src/web-search/WebSearchConfig.js";
import {WebSearchProviderId} from "../src/web-search/SearchProvider.js";

test("web-search configuration defaults to a dependency-free provider chain", () => {
    assert.equal(defaultWebSearchConfigFile(), path.join(os.homedir(), ".pilot", "web-search.json"));
    assert.deepEqual(defaultWebSearchConfig().providers, [
        WebSearchProviderId.SEARXNG,
        WebSearchProviderId.BRAVE,
        WebSearchProviderId.TAVILY,
        WebSearchProviderId.SERPER,
        WebSearchProviderId.NATIVE,
        WebSearchProviderId.DUCKDUCKGO,
    ]);
});

test("web-search configuration preserves provider order and loads credentials", () => {
    withConfig({
        version: 1,
        providers: ["brave", "searxng", "duckduckgo"],
        requestTimeoutMs: 12_000,
        maxResponseBytes: 50_000,
        searxng: {baseUrl: "https://search.example.test/root/"},
        brave: {apiKey: "  brave-secret  "},
    }, (file) => {
        assert.deepEqual(loadWebSearchConfig(file), {
            providers: [
                WebSearchProviderId.BRAVE,
                WebSearchProviderId.SEARXNG,
                WebSearchProviderId.DUCKDUCKGO,
            ],
            requestTimeoutMs: 12_000,
            maxResponseBytes: 50_000,
            searxng: {baseUrl: "https://search.example.test/root"},
            brave: {apiKey: "brave-secret"},
        });
    });
});

test("web-search configuration rejects unknown, duplicate, and unsafe provider settings", () => {
    for (const config of [
        {version: 2, providers: ["duckduckgo"]},
        {version: 1, providers: []},
        {version: 1, providers: ["unknown"]},
        {version: 1, providers: ["brave", "brave"]},
        {version: 1, providers: ["searxng"], searxng: {baseUrl: "file:///tmp/search"}},
        {version: 1, providers: ["searxng"], searxng: {baseUrl: "https://user:secret@example.test"}},
        {version: 1, providers: ["brave"], brave: {apiKey: ""}},
        {version: 1, providers: ["brave"], brave: {apiKey: "secret", unexpected: true}},
        {version: 1, providers: ["duckduckgo"], unexpected: true},
    ]) {
        withConfig(config, (file) => assert.throws(() => loadWebSearchConfig(file), /Invalid web-search configuration/));
    }
});

function withConfig(value: unknown, run: (file: string) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-web-search-config-"));
    const file = path.join(directory, "web-search.json");
    try {
        writeFileSync(file, JSON.stringify(value));
        run(file);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
}
