import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {PolicyArea, PolicyFallbackResponse} from "../src/policy/types.js";
import {NativeFuseSessionBroker} from "../src/policy/path/native/NativeFuseSessionBroker.js";
import {runNativeFuseSandboxedCommand} from "../src/policy/path/native/native-fuse-runner.js";

const AGENT = "native-mmap-test";

function runtime(): PolicyRuntime {
    const policy = new PolicyRuntime(AGENT, {
        initializeSchema() {}, loadPolicies: () => [], upsertPolicies() {}, deletePolicy() {},
    }, {
        async resolveQueuedPolicy() { throw new Error("Unexpected mmap policy approval"); },
    });
    policy.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);
    return policy;
}

for (const brokered of [false, true]) {
    test(`writable mmap is per-call and drains unflushed forked/closed-fd mappings (broker=${brokered})`, async () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mmap-host-"));
        const policy = runtime();
        const broker = brokered ? new NativeFuseSessionBroker() : undefined;
        const target = path.join(directory, "output");
        const script = [
            "import errno,mmap,os,sys",
            "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_TRUNC,0o600)",
            "os.ftruncate(fd,2*mmap.PAGESIZE)",
            "try:",
            " mapping=mmap.mmap(fd,0,flags=mmap.MAP_SHARED,prot=mmap.PROT_READ|mmap.PROT_WRITE)",
            "except OSError as error:",
            " assert sys.argv[2] == 'off' and error.errno == errno.ENODEV, error",
            " os.close(fd)",
            " sys.exit(0)",
            "assert sys.argv[2] == 'on'",
            "os.close(fd)",
            "pid=os.fork()",
            "if pid == 0:",
            " mapping[-7:]=b'content'",
            " os._exit(0)",
            "assert os.waitpid(pid,0)[1] == 0",
            "mapping[:7]=b'parent!'",
            // No msync/fsync: teardown must flush before reporting success.
            "mapping.close()",
        ].join("\n");
        try {
            for (const writableMmap of [true, false, true]) {
                const view = policy.beginNativeFilesystemToolCall(AGENT, {toolName: "mmap-test"});
                let stderr = "";
                try {
                    const result = await runNativeFuseSandboxedCommand({
                        command: ["python3", "-c", script, target, writableMmap ? "on" : "off"],
                        cwd: directory, policyView: view, sessionBroker: broker, writableMmap,
                        timeoutSeconds: 20, onStderr: (data) => { stderr += data; },
                    });
                    assert.equal(result.exitCode, 0, stderr);
                    if (writableMmap) {
                        const bytes = readFileSync(target);
                        assert.equal(bytes.subarray(0, 7).toString(), "parent!");
                        assert.equal(bytes.subarray(-7).toString(), "content");
                    }
                    assert.equal(broker?.activeMountCount ?? 0, 0);
                } finally {
                    view.close();
                }
            }
        } finally {
            await broker?.close();
            policy.beginShutdown();
            rmSync(directory, {recursive: true, force: true});
        }
    });

    test(`Go linker output reaches the host through writable mmap (broker=${brokered})`, {timeout: 180_000}, async (t) => {
        if (spawnSync("go", ["version"], {encoding: "utf8"}).status !== 0) {
            t.skip("Go is required for the writable-mmap linker integration test");
            return;
        }
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mmap-go-"));
        const target = path.join(directory, "hello");
        writeFileSync(path.join(directory, "main.go"), 'package main\nfunc main() { println("mapped linker output") }\n');
        const policy = runtime();
        const broker = brokered ? new NativeFuseSessionBroker() : undefined;
        const view = policy.beginNativeFilesystemToolCall(AGENT, {toolName: "mmap-go-test"});
        let stderr = "";
        try {
            const result = await runNativeFuseSandboxedCommand({
                command: ["go", "build", "-o", target, path.join(directory, "main.go")],
                cwd: directory, policyView: view, sessionBroker: broker, writableMmap: true,
                env: {...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOENV: "off",
                    GOWORK: "off", GO111MODULE: "off", GOCACHE: path.join(directory, "go-cache")},
                timeoutSeconds: 150, onStderr: (data) => { stderr += data; },
            });
            assert.equal(result.exitCode, 0, stderr);
            assert.equal(readFileSync(target).subarray(0, 4).toString(), "\x7fELF");
            const executed = spawnSync(target, [], {encoding: "utf8", timeout: 10_000});
            assert.ifError(executed.error);
            assert.equal(executed.status, 0, executed.stderr);
            assert.match(executed.stderr, /mapped linker output/);
        } finally {
            view.close();
            await broker?.close();
            policy.beginShutdown();
            rmSync(directory, {recursive: true, force: true});
        }
    });
}
