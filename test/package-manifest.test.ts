import assert from "node:assert/strict";
import {EventEmitter, once} from "node:events";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {DefaultPackageManager, DefaultResourceLoader, SettingsManager} from "@earendil-works/pi-coding-agent";
import {PilotHumanWaits} from "../src/herdr/PilotHumanWaits.js";
import type {HerdrRequest} from "../src/herdr/HerdrTransport.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const pilot = "src/pilot-extension.ts";
const herdr = "src/herdr/herdr-extension.ts";

test("host-provided imports are wildcard peers with pinned development copies, never runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
        assert.equal(Object.hasOwn(manifest.dependencies, name), false, `${name} must resolve through Pi's host module mapping`);
        assert.equal(manifest.peerDependencies[name], "*", `${name} must not make managed installs solve another host copy`);
        assert.match(manifest.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} stays pinned for local development`);
    }
});

test("Pi lists both resources and loads only the enabled entries", async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-package-manifest-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const cases: Array<[string[] | undefined, boolean, boolean]> = [
        [undefined, true, true],
        [[`+${pilot}`], true, true], // Exact force-inclusion alone is not an allowlist.
        [[pilot], true, false],
        [[`-${herdr}`], true, false],
        [[`-${pilot}`], false, true],
        [[], false, false],
    ];
    for (const [extensions, hasPilot, hasHerdr] of cases) {
        const options = {
            cwd: directory,
            agentDir: directory,
            settingsManager: SettingsManager.inMemory({packages: [extensions === undefined ? root : {source: root, extensions}]}),
        };
        const resources = await new DefaultPackageManager(options).resolve();
        assert.deepEqual(new Map(resources.extensions.map((item) => [item.path, item.enabled])), new Map([
            [path.join(root, pilot), hasPilot], [path.join(root, herdr), hasHerdr],
        ]), JSON.stringify(extensions));
        const loader = new DefaultResourceLoader({
            ...options, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        assert.deepEqual(loaded.warnings ?? [], []);
        assert.deepEqual(loaded.extensions.map((item) => item.path).sort(), [
            ...(hasPilot ? [path.join(root, pilot)] : []), ...(hasHerdr ? [path.join(root, herdr)] : []),
        ].sort());
    }
});

test("Pi loads a single reporter and delivers wait spans across extension entries", {
    skip: process.platform === "win32", timeout: 15_000,
}, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "lot-pkg-"));
    const socketPath = path.join(directory, "herdr.sock");
    const requests: HerdrRequest[] = [];
    const stateReports = new EventEmitter();
    const nextState = async () => (await once(stateReports, "state", {signal: AbortSignal.timeout(2_000)}))[0];
    const server = createServer((socket) => {
        let input = "";
        socket.setEncoding("utf8");
        socket.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code !== "ECONNRESET" && error.code !== "EPIPE") stateReports.emit("error", error);
        });
        socket.on("data", (chunk) => {
            input += chunk;
            const newline = input.indexOf("\n");
            if (newline < 0) return;
            const request = JSON.parse(input.slice(0, newline)) as HerdrRequest;
            requests.push(request);
            if (request.params.state) socket.once("close", () => stateReports.emit("state", request.params));
            socket.end(JSON.stringify({id: request.id, result: {type: "ok"}}) + "\n");
        });
    });
    const previous: NodeJS.ProcessEnv = {};
    const env = {HERDR_ENV: "1", HERDR_PANE_ID: "test:pane", HERDR_SOCKET_PATH: socketPath, PILOT_HERDR_REPORTING: "1"};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        process.env[key] = value;
    }
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, {recursive: true, force: true});
    });
    server.listen(socketPath);
    await once(server, "listening");
    let publish: ((active: boolean) => void) | undefined;
    const loader = new DefaultResourceLoader({
        cwd: directory, agentDir: directory,
        settingsManager: SettingsManager.inMemory({packages: [root]}),
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi) => {
            // Use the same publisher as Pilot without booting Pilot's storage/native runtime.
            const waits = new PilotHumanWaits(pi.events);
            publish = (active) => waits.setPolicyWaiting(active);
        }],
    });
    await loader.reload();
    const {extensions, errors} = loader.getExtensions();
    assert.deepEqual(errors, []);
    const reporters = extensions.filter((entry) => entry.handlers.has("agent_settled"));
    assert.deepEqual(reporters.map((entry) => entry.path), [path.join(root, herdr)]);
    assert.equal(reporters[0]!.handlers.get("agent_settled")!.length, 1);
    const handlers = reporters[0]!.handlers;
    const ctx = {
        hasUI: true, mode: "tui", isIdle: () => true,
        sessionManager: {getSessionFile: () => undefined, getSessionId: () => "fake-session"},
    };
    try {
        const start = handlers.get("session_start")![0]!({reason: "startup"}, ctx);
        assert.equal((await nextState()).state, "idle");
        await start;
        publish!(true);
        assert.equal((await nextState()).message, "Policy approval required");
        publish!(false);
        assert.equal((await nextState()).state, "idle");
        assert.deepEqual(requests.map(({params}) => params.state), [undefined, "idle", "blocked", "idle"]);
    } finally {
        await handlers.get("session_shutdown")![0]!({reason: "quit"}, ctx);
    }
});
