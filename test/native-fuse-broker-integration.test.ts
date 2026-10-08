import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, readlinkSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {NativeFuseSessionBroker} from "../src/policy/path/native/NativeFuseSessionBroker.js";
import {resolveNativeExecutable} from "../src/runtime/NativeExecutable.js";

// Exercise the production TypeScript broker owner and the real selected helper,
// without creating a mount or replacing ManagedChildProcess.spawn with a mock.
test("production FUSE broker launches the selected executable and cleans up without mounting", {timeout: 20_000}, async () => {
    const executable = resolveNativeExecutable("pi-fuse-native");
    const broker = new NativeFuseSessionBroker();
    let pid: number | undefined;
    let directory: string | undefined;
    try {
        await Promise.all([broker.start(), broker.start()]);
        pid = broker.pid;
        directory = broker.hiddenHostPath;
        assert.ok(pid);
        assert.ok(directory);
        assert.equal(broker.activeMountCount, 0);
        assert.equal(broker.mountedFilesystemCount, 0);
        assert.equal(readlinkSync(`/proc/${pid}/exe`), executable);
        assert.deepEqual(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, 2), [executable, "--broker"]);
        assert.equal(createHash("sha256").update(readFileSync(`/proc/${pid}/exe`)).digest("hex"),
            createHash("sha256").update(readFileSync(executable)).digest("hex"));
        assert.ok(existsSync(path.join(directory, "policy.sock")));
        await broker.start();
        assert.equal(broker.pid, pid, "idempotent start must keep the same daemon");
        await Promise.all([broker.close(), broker.close()]);
        assert.equal(broker.pid, undefined);
        assert.equal(broker.hiddenHostPath, undefined);
        assert.equal(existsSync(`/proc/${pid}`), false, "close must reap the daemon");
        assert.equal(existsSync(directory), false, "close must remove broker resources");
    } finally {
        await broker.close();
    }
});
