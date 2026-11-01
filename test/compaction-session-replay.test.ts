import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {sessionReplay} from "../experiments/compaction/SessionReplay.js";

const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};

test("real-session capture uses the historical checkpoint's parent branch, never saved summary or future/sibling history", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-replay-test-"));
    try {
        const manager = SessionManager.inMemory("/historical-project");
        const user = manager.appendMessage({role: "user", content: "SOURCE_BEFORE_CHECKPOINT " + "x".repeat(84000), timestamp: 1});
        const assistant = manager.appendMessage({role: "assistant", content: [{type: "text", text: "r".repeat(84000)}],
            api: "openai-responses", provider: "offline", model: "offline", usage, stopReason: "stop", timestamp: 2});
        manager.appendCompaction("SAVED_SUMMARY_MUST_NOT_LEAK", assistant, 42000);
        manager.appendMessage({role: "user", content: "FUTURE_MUST_NOT_LEAK", timestamp: 3});
        manager.branch(user);
        manager.appendMessage({role: "user", content: "SIBLING_MUST_NOT_LEAK", timestamp: 4});
        const file = path.join(directory, "old-session.jsonl");
        const raw = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        await writeFile(file, raw);
        const replay = await sessionReplay({file, checkpoint: 0});
        const preparedText = JSON.stringify(replay.preparation);
        assert.match(preparedText, /SOURCE_BEFORE_CHECKPOINT/);
        assert.doesNotMatch(preparedText, /SAVED_SUMMARY_MUST_NOT_LEAK|FUTURE_MUST_NOT_LEAK|SIBLING_MUST_NOT_LEAK/);
        assert.equal(replay.metadata.capturedFirstKeptEntryId, assistant);
        assert.equal(replay.preparation.settings.keepRecentTokens, 20000);
        assert.equal(replay.preparation.settings.reserveTokens, 16384);
        assert.equal(await readFile(file, "utf8"), raw, "capture never rewrites or appends to original history");
        const first = await replay.fixture.prepare();
        first.fileOps.read.add("cross-trial-mutation");
        const second = await replay.fixture.prepare();
        assert.ok(!second.fileOps.read.has("cross-trial-mutation"));
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

test("missing historical checkpoints fail before starting a session or calling a model", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-replay-test-"));
    try {
        const manager = SessionManager.inMemory("/old-project");
        const file = path.join(directory, "empty.jsonl");
        await writeFile(file, JSON.stringify(manager.getHeader()) + "\n");
        await assert.rejects(sessionReplay({file, checkpoint: 0}), /Missing historical checkpoint/);
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});
