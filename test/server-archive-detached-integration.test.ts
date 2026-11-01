import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {mock, test} from "node:test";
import Database from "better-sqlite3";
import {SqliteDatabase} from "../src/storage/sqlite.js";
import {ArchiveInbox} from "../src/server/ArchiveInbox.js";
import {ArchiveWorkerEngine} from "../src/server/ArchiveWorkerEngine.js";
import {runArchiveWorker as runProductionArchiveWorker} from "../src/server/ArchiveWorker.js";
import {decodeArchivePublication, type Receipt} from "../src/server/ArchiveProtocol.js";

const root = fileURLToPath(new URL("../", import.meta.url));

// This typed adapter is copied verbatim into the fixture, with absolute imports. Keeping
// its source here makes normal project typechecking cover the subprocess hooks too.
// BEGIN DETACHED FIXTURE
async function runFixtureArchiveWorker(directory: string, configDirectory: string): Promise<void> {
    const fixture = path.dirname(configDirectory);
    const marker = (name: string) => path.join(fixture, name);
    const write = (name: string, value: unknown) => fs.writeFileSync(marker(name), JSON.stringify(value), {mode: 0o600});
    const exited = `${process.pid}.exited`;
    process.once("exit", (code) => write(exited, {code}));
    // Only the worker itself exits on cleanup; no signal is sent to a possibly reused PID.
    const stop = setInterval(() => {
        if (fs.existsSync(marker("STOP"))) process.exit(90);
    }, 25);
    stop.unref();
    setTimeout(() => process.exit(91), 20_000).unref();
    write(`${process.pid}.started`, {env: process.env, argv: process.argv, execArgv: process.execArgv, cwd: process.cwd()});
    try {
        // A deterministic gate is stronger than assuming the parent exits within 750ms.
        while (!fs.existsSync(marker("GO"))) await new Promise(resolve => setTimeout(resolve, 20));
        const parentPid = Number(fs.readFileSync(marker("parent-pid"), "utf8"));
        assert.throws(() => process.kill(parentPid, 0), (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "ESRCH");
        const settings: {id: string; source: string; token: string; origin: string} = JSON.parse(fs.readFileSync(marker("settings.json"), "utf8"));
        const databaseFile = path.join(directory, "archive.sqlite");
        const binding = {server_id: "detached-server", namespace_id: "detached-namespace", history_generation: "detached-history"};
        let writableOpens = 0;
        const modes: string[] = [];
        const originalOpen = SqliteDatabase.test;
        mock.method(SqliteDatabase, "test", (readonly: boolean, file: string) => {
            const database = originalOpen(readonly, file);
            if (!readonly) {
                // Test-only rollback fixture: switch BEFORE ArchiveJournal/State schema access.
                database.exec("PRAGMA journal_mode=DELETE");
                modes.push(String(database.prepare("PRAGMA journal_mode").pluck().get()));
                writableOpens++;
            }
            return database;
        });
        const originalAck = ArchiveInbox.prototype.acknowledge;
        mock.method(ArchiveInbox.prototype, "acknowledge", function(this: ArchiveInbox, id: string) {
            assert.ok(fs.existsSync(path.join(this.directory, `${id}.json`)));
            const database = new Database(databaseFile, {readonly: true});
            try {
                const imported = database.prepare("SELECT manifest FROM archive_worker_scopes WHERE id=?").pluck().get(id);
                assert.deepEqual(JSON.parse(String(imported)), this.readManifest(id));
            } finally { database.close(); }
            originalAck.call(this, id);
            write("acknowledged.json", {id, importedBeforeRemoval: true, removed: !fs.existsSync(path.join(this.directory, `${id}.json`))});
        });
        const originalStep = ArchiveWorkerEngine.prototype.step;
        let reopened = false;
        mock.method(ArchiveWorkerEngine.prototype, "step", async function(this: ArchiveWorkerEngine) {
            const schedule = await originalStep.call(this);
            if (!reopened) {
                const database = new Database(databaseFile, {readonly: true});
                try {
                    const row = database.prepare(`SELECT o.id, o.state, o.attempts, o.due, o.request, c.body
                        FROM archive_worker_operations o JOIN archive_worker_candidates c ON c.id=o.candidate
                        WHERE o.state='uncertain' AND o.attempts>0`).get() as
                        {id: string; state: string; attempts: number; due: number; request: string; body: Buffer} | undefined;
                    if (row) {
                        assert.ok(schedule.eligible);
                        assert.equal(schedule.nextDue, row.due);
                        // Close the actual engine connection during persisted backoff. The next
                        // ordinary worker iteration must reopen state and recover the frozen op.
                        this.close();
                        reopened = true;
                        write("uncertain.json", {...row, body: row.body.toString("base64"), observedAt: Date.now(), writableOpens});
                    }
                } finally { database.close(); }
            }
            return schedule;
        });
        const calls: Array<{endpoint: string; method: string | undefined; at: number; operation?: string}> = [];
        const json = (value: unknown, status = 200) => {
            const body = JSON.stringify(value);
            return new Response(body, {status, headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))}});
        };
        mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
            const url = new URL(String(input));
            assert.equal(url.origin, settings.origin, "fixture must never contact another destination");
            assert.ok(new Headers(init?.headers).get("x-apikey") === settings.token, "expected fixture authentication");
            if (url.pathname === "/v1/version") return json({version: "0.4.0"});
            const call: typeof calls[number] = {endpoint: url.pathname, method: init?.method, at: Date.now()};
            calls.push(call);
            write("calls.json", calls);
            if (url.pathname === "/v1/binding") {
                assert.equal(init?.method, "GET");
                return json({binding, head: "0", capabilities: ["preserved_variants_v1"]});
            }
            assert.equal(init?.method, "POST");
            if (url.pathname === "/v1/download") {
                assert.deepEqual(JSON.parse(Buffer.from(init!.body as Uint8Array).toString()), {binding, session_id: settings.id});
                return json({error: {code: "not_found", retryable: false, publication_outcome: "unconfirmed"}}, 404);
            }
            if (url.pathname === "/v1/publish") {
                assert.ok(!fs.existsSync(marker("remote.json")), "publish must happen only once");
                const header = new Headers(init!.headers).get("x-pi-publication");
                assert.ok(header);
                const request = decodeArchivePublication(JSON.parse(Buffer.from(header, "base64url").toString()));
                const body = Buffer.from(init!.body as Uint8Array);
                assert.equal(body.length, request.byte_length);
                assert.equal(createHash("sha256").update(body).digest("hex"), request.sha256);
                const receipt: Receipt = {request, revision: {binding, seq: "1"}};
                const descriptor = fs.openSync(marker("remote.json"), "wx", 0o600);
                try {
                    fs.writeFileSync(descriptor, JSON.stringify({receipt, body: body.toString("base64")}));
                    fs.fsyncSync(descriptor);
                } finally { fs.closeSync(descriptor); }
                fs.unlinkSync(settings.source); // Captured immutable bytes, not the live source, must survive.
                call.operation = request.operation_id;
                write("calls.json", calls);
                throw new Error("Test-only lost publication response after remote commit");
            }
            assert.equal(url.pathname, "/v1/receipt", "no real network or other endpoint is allowed");
            const request = decodeArchivePublication(JSON.parse(Buffer.from(init!.body as Uint8Array).toString()));
            const remote: {receipt: Receipt; body: string} = JSON.parse(fs.readFileSync(marker("remote.json"), "utf8"));
            assert.deepEqual(request, remote.receipt.request);
            call.operation = request.operation_id;
            write("calls.json", calls);
            while (!fs.existsSync(marker("RECOVER"))) await new Promise(resolve => setTimeout(resolve, 20));
            return json({status: "accepted", receipt: remote.receipt});
        });
        await runProductionArchiveWorker(directory, configDirectory);
        write(`${process.pid}.complete`, {parentAlive: false, reopened, writableOpens, modes});
    } catch {
        write(`${process.pid}.failed`, {failed: true});
        throw new Error("Detached archive integration fixture failed");
    } finally {
        mock.restoreAll();
        clearInterval(stop);
    }
}
// END DETACHED FIXTURE

function externalNode(): string {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        try {
            const executable = fs.realpathSync(path.join(directory, "node"));
            fs.accessSync(executable, fs.constants.X_OK);
            return executable;
        } catch { /* Search absolute PATH entries only; ArchiveRuntime validates Node/SQLite. */ }
    }
    throw new Error("Detached integration requires external Node on PATH");
}

async function waitFor(predicate: () => boolean, milliseconds: number, message: string): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), message);
}

test("actual detached archive worker survives parent exit, reopens uncertain SQLite work and recovers its exact receipt", {timeout: 30_000}, async () => {
    // No host/native-sandbox qualification: ordinary subprocesses, fake HTTP and DELETE fixtures only.
    const directory = fs.mkdtempSync(path.join(root, ".pilot-detached-integration-"));
    fs.chmodSync(directory, 0o700);
    const config = path.join(directory, "config");
    const archive = path.join(config, "server-archive");
    const sessions = path.join(directory, "sessions");
    const source = path.join(sessions, "native.jsonl");
    const id = "detached-native-root";
    const enqueueId = randomUUID();
    const token = "private-fixture-api-key";
    const origin = "https://detached.invalid";
    const bytes = Buffer.from([
        JSON.stringify({type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/fixture/native"}),
        JSON.stringify({type: "message", id: "native-entry", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
            message: {role: "user", content: [{type: "text", text: "Exact native bytes: café 🌲"}], timestamp: 1767225601000}}),
        "",
    ].join("\n"));
    const file = (name: string) => path.join(directory, name);
    const readJson = (name: string) => JSON.parse(fs.readFileSync(file(name), "utf8"));
    let parentClosed = false;
    try {
        fs.mkdirSync(sessions, {mode: 0o700});
        fs.writeFileSync(source, bytes, {mode: 0o600});
        fs.writeFileSync(file("settings.json"), JSON.stringify({id, source, token, origin}), {mode: 0o600});
        const bootstrap = path.join(root, "src/server/archive-worker.mjs");
        fs.copyFileSync(bootstrap, file("archive-worker.mjs"));
        assert.deepEqual(fs.readFileSync(file("archive-worker.mjs")), fs.readFileSync(bootstrap));
        const imports = [
            'import assert from "node:assert/strict";', 'import fs from "node:fs";', 'import path from "node:path";',
            'import {createHash} from "node:crypto";', 'import {mock} from "node:test";', 'import Database from "better-sqlite3";',
            `import {SqliteDatabase} from ${JSON.stringify(pathToFileURL(path.join(root, "src/storage/sqlite.ts")).href)};`,
            `import {ArchiveInbox} from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveInbox.ts")).href)};`,
            `import {ArchiveWorkerEngine} from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveWorkerEngine.ts")).href)};`,
            `import {runArchiveWorker as runProductionArchiveWorker} from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveWorker.ts")).href)};`,
            `import {decodeArchivePublication, type Receipt} from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveProtocol.ts")).href)};`,
        ];
        const testSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
        const adapter = testSource.split("// BEGIN DETACHED FIXTURE\n")[1]!.split("// END DETACHED FIXTURE")[0]!;
        fs.writeFileSync(file("ArchiveWorker.ts"), `${imports.join("\n")}\n${adapter}\nexport {runFixtureArchiveWorker as runArchiveWorker};\n`);
        fs.writeFileSync(file("parent.mjs"), `
import fs from "node:fs";
import childProcess from "node:child_process";
import {mock} from "node:test";
import {createJiti} from "jiti";
const jiti = createJiti(import.meta.url, {fsCache: false});
const {ArchiveRuntime} = await jiti.import(${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveRuntime.ts")).href)});
const {ArchiveBackground} = await jiti.import(${JSON.stringify(pathToFileURL(path.join(root, "src/server/ArchiveBackground.ts")).href)});
const {ServerConfigStore} = await jiti.import(${JSON.stringify(pathToFileURL(path.join(root, "src/server/ServerConfig.ts")).href)});
const launched = [];
const spawn = childProcess.spawn;
mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args);
    child.once("spawn", () => {
        launched.push(child.pid);
        fs.writeFileSync(${JSON.stringify(file("launched.json"))}, JSON.stringify(launched));
    });
    return child;
});
fs.writeFileSync(${JSON.stringify(file("parent-pid"))}, String(process.pid));
process.env.NODE_OPTIONS = "--must-not-reach-worker";
process.env.OPENAI_API_KEY = "provider-secret-must-not-reach-worker";
process.env.PILOT_SESSION_ID = "session-secret-must-not-reach-worker";
const store = new ServerConfigStore(${JSON.stringify(config)});
store.save({url: ${JSON.stringify(origin)}, apiKey: ${JSON.stringify(token)}});
const runtime = new ArchiveRuntime({nodeExecutable: ${JSON.stringify(externalNode())}, bootstrap: ${JSON.stringify(file("archive-worker.mjs"))}});
const background = new ArchiveBackground(store, {runtime});
await background.initialize();
const result = await background.enqueue({version: 1, scope: "current",
    activeSession: {sessionId: ${JSON.stringify(id)}, main: true, rootSessionId: ${JSON.stringify(id)}, identityConflict: false},
    sessionFile: ${JSON.stringify(source)}, sessionDirectory: ${JSON.stringify(sessions)}, rootSessionId: ${JSON.stringify(id)},
    defaultSessionRoots: [${JSON.stringify(sessions)}]}, ${JSON.stringify(enqueueId)});
if (!result.queued || result.warning) throw new Error("Fixture enqueue failed");
mock.restoreAll();
// No process.exit(): ordinary event-loop retirement must leave the detached workers alive.
`);
        const output = await new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
            childProcess.execFile(externalNode(), [file("parent.mjs")], {
                cwd: root, env: {PATH: process.env.PATH, HOME: directory, TMPDIR: directory},
                timeout: 8_000, maxBuffer: 16 * 1024,
            }, (error, stdout, stderr) => {
                parentClosed = true;
                if (error) reject(new Error("Detached integration launcher failed"));
                else resolve({stdout, stderr});
            });
        });
        assert.deepEqual(output, {stdout: "", stderr: ""});
        const parentPid = Number(fs.readFileSync(file("parent-pid"), "utf8"));
        assert.throws(() => process.kill(parentPid, 0), (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "ESRCH");
        const pids: number[] = readJson("launched.json");
        assert.equal(pids.length, 2, "startup wake and enqueue launch real production contenders");
        const manifestFile = path.join(archive, "inbox", `${enqueueId}.json`);
        assert.ok(fs.existsSync(manifestFile), "enqueue survives launcher exit before worker import");
        const manifest = fs.readFileSync(manifestFile, "utf8");
        assert.ok(!manifest.includes(token) && !manifest.includes("Exact native bytes"));
        assert.ok(!fs.existsSync(path.join(archive, "archive.sqlite")), "departure must not open the journal");
        fs.writeFileSync(file("GO"), "");
        await waitFor(() => fs.existsSync(file("uncertain.json")), 10_000, "actual worker must persist uncertain/backoff state after parent exit");
        const uncertain: {id: string; request: string; body: string; state: string; attempts: number; due: number; observedAt: number; writableOpens: number} = readJson("uncertain.json");
        assert.equal(uncertain.state, "uncertain");
        assert.equal(uncertain.attempts, 1);
        assert.ok(uncertain.due > uncertain.observedAt, "retry is a future persisted deadline, not a hot loop");
        assert.deepEqual(Buffer.from(uncertain.body, "base64"), bytes);
        assert.ok(!fs.existsSync(source), "remote commit removes native source after capture");
        assert.deepEqual(readJson("acknowledged.json"), {id: enqueueId, importedBeforeRemoval: true, removed: true});
        assert.ok(!fs.existsSync(manifestFile));
        const remote: {receipt: Receipt; body: string} = readJson("remote.json");
        assert.deepEqual(Buffer.from(remote.body, "base64"), bytes);
        assert.equal(remote.receipt.request.session_id, id);
        assert.equal(remote.receipt.request.operation_id, uncertain.id);
        assert.deepEqual(remote.receipt.request, JSON.parse(uncertain.request));
        assert.equal(remote.receipt.request.sha256, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(remote.receipt.request.byte_length, bytes.length);
        assert.deepEqual(remote.receipt.request.condition, {kind: "absent"});
        fs.writeFileSync(file("RECOVER"), "");
        await waitFor(() => pids.every(pid => fs.existsSync(file(`${pid}.exited`))), 6_000, "workers must drain and exit without another wakeup");
        const completions = pids.map(pid => readJson(`${pid}.complete`));
        const owner = completions.find(result => result.reopened);
        assert.ok(owner, "actual engine must close and reopen after the lost reply");
        assert.ok(owner.writableOpens > uncertain.writableOpens);
        for (const result of completions) {
            assert.equal(result.parentAlive, false);
            assert.ok(result.modes.every((mode: string) => mode === "delete"));
        }
        for (const pid of pids) {
            assert.equal(readJson(`${pid}.exited`).code, 0);
            const started = readJson(`${pid}.started`);
            assert.deepEqual(started.execArgv, []);
            assert.equal(started.cwd, directory);
            assert.ok(Object.keys(started.env).every(key => ["PATH", "HOME", "TMPDIR"].includes(key)));
            assert.ok(!JSON.stringify(started).includes(token));
            assert.ok(!JSON.stringify(started).includes("must-not-reach-worker"));
        }
        const calls: Array<{endpoint: string; method: string; at: number; operation?: string}> = readJson("calls.json");
        assert.equal(calls.filter(call => call.endpoint === "/v1/publish").length, 1);
        const receiptCalls = calls.filter(call => call.endpoint === "/v1/receipt");
        assert.equal(receiptCalls.length, 1);
        assert.equal(receiptCalls[0]!.operation, uncertain.id);
        assert.ok(receiptCalls[0]!.at >= uncertain.due, "worker stayed alive through its actual retry timer");
        // Fresh native read-only reopen AFTER worker close, not a mocked journal view.
        const database = new Database(path.join(archive, "archive.sqlite"), {readonly: true});
        try {
            assert.equal(database.pragma("journal_mode", {simple: true}), "delete");
            assert.deepEqual(database.prepare("SELECT id,state,request,receipt FROM archive_worker_operations").all(),
                [{id: uncertain.id, state: "accepted", request: uncertain.request, receipt: JSON.stringify(remote.receipt)}]);
            assert.deepEqual(database.prepare("SELECT session_id,state,body,sha256,byte_length FROM archive_worker_candidates").all(),
                [{session_id: id, state: "covered", body: null, sha256: remote.receipt.request.sha256, byte_length: bytes.length}]);
            assert.equal(database.prepare("SELECT COUNT(*) FROM archive_worker_coverage").pluck().get(), 1);
            assert.deepEqual(database.prepare("SELECT id,state FROM archive_worker_scopes").all(), [{id: enqueueId, state: "complete"}]);
            assert.deepEqual(database.prepare("SELECT state FROM archive_worker_sources").all(), [{state: "captured"}]);
        } finally { database.close(); }
        assert.match(fs.readFileSync(path.join(root, "src/storage/sqlite.ts"), "utf8"), /journal_mode = WAL/,
            "rollback mode belongs only to this fixture; production WAL must stay unchanged");
    } finally {
        fs.writeFileSync(file("STOP"), "");
        // Both known contenders must acknowledge self-exit before their private control
        // files disappear. If startup/cleanup cannot be confirmed, retain the fixture.
        let safeToRemove = false;
        if (parentClosed && fs.existsSync(file("launched.json"))) {
            const pids: number[] = readJson("launched.json");
            const deadline = Date.now() + 3_000;
            while (!pids.every(pid => fs.existsSync(file(`${pid}.exited`))) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            safeToRemove = pids.every(pid => fs.existsSync(file(`${pid}.exited`)));
        }
        if (safeToRemove) fs.rmSync(directory, {recursive: true, force: true});
        else console.error(`Detached integration retained private cleanup fixture: ${directory}`);
    }
});
