import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {PolicyAccessType, PolicyArea, PolicyFallbackResponse, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";
import {NativeFuseSessionBroker} from "../src/policy/path/native/NativeFuseSessionBroker.js";
import {runNativeFuseSandboxedCommand} from "../src/policy/path/native/native-fuse-runner.js";
import {scriptedPolicyApproval} from "./fixtures/QueuedPolicyApproval.js";

const AGENT = "native-mmap-test";

function runtime(approval = scriptedPolicyApproval(() => assert.fail("Unexpected filesystem approval"))): PolicyRuntime {
    const policy = new PolicyRuntime(AGENT, {
        initializeSchema() {}, loadPolicies: () => [], upsertPolicies() {}, deletePolicy() {},
    }, approval);
    policy.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);
    return policy;
}

for (const brokered of [false, true]) {
    test(`default mmap policy asks for dirty mappings, not ordinary opens and writes (broker=${brokered})`, async () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mmap-approval-"));
        const ordinary = path.join(directory, "ordinary");
        const mapped = path.join(directory, "mapping");
        const broker = brokered ? new NativeFuseSessionBroker() : undefined;
        const prompts: string[] = [];
        let decision = PolicyResponse.ALLOWED;
        const policy = runtime(scriptedPolicyApproval((uri, accessType) => {
            assert.equal(accessType, PolicyAccessType.FS_MMAP);
            prompts.push(uri);
            return {uri, accessType, status: decision, lifetime: PolicyLifetime.ONCE, reason: "test decision"};
        }));
        const run = async (script: string, target: string) => {
            const view = policy.beginNativeFilesystemToolCall(AGENT, {toolName: "mmap-test"});
            try {
                return await runNativeFuseSandboxedCommand({
                    command: ["python3", "-c", script, target], cwd: directory, policyView: view,
                    sessionBroker: broker, timeoutSeconds: 20,
                });
            } finally {
                view.close();
            }
        };
        const change = [
            "import mmap,sys",
            "with open(sys.argv[1],'r+b') as f:",
            " with mmap.mmap(f.fileno(),0) as m: m[:8]=b'modified'",
        ].join("\n");
        try {
            assert.equal((await run("import sys; open(sys.argv[1], 'w+b').write(b'direct')", ordinary)).exitCode, 0);
            assert.deepEqual(prompts, []);
            assert.equal(readFileSync(ordinary, "utf8"), "direct");
            writeFileSync(mapped, "original");
            const clean = "import mmap,sys\nwith open(sys.argv[1], 'r+b') as f:\n with mmap.mmap(f.fileno(),0) as m: assert m[:8]==b'original'";
            assert.equal((await run(clean, mapped)).exitCode, 0);
            assert.deepEqual(prompts, []);
            assert.equal((await run(change, mapped)).exitCode, 0);
            assert.deepEqual(prompts, [mapped]);
            assert.equal(readFileSync(mapped, "utf8"), "modified");
            writeFileSync(mapped, "original");
            decision = PolicyResponse.DENIED;
            await assert.rejects(run(change, mapped), /filesystem sync failed/);
            assert.deepEqual(prompts, [mapped, mapped]);
            assert.equal(readFileSync(mapped, "utf8"), "original");
        } finally {
            await broker?.close();
            policy.beginShutdown();
            rmSync(directory, {recursive: true, force: true});
        }
    });

    test(`writable mmap drains unflushed forked/closed-fd mappings (broker=${brokered})`, async () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-mmap-host-"));
        const policy = runtime();
        const broker = brokered ? new NativeFuseSessionBroker() : undefined;
        const target = path.join(directory, "output");
        const script = [
            "import mmap,os,sys",
            "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_TRUNC,0o600)",
            "os.ftruncate(fd,2*mmap.PAGESIZE)",
            "mapping=mmap.mmap(fd,0,flags=mmap.MAP_SHARED,prot=mmap.PROT_READ|mmap.PROT_WRITE)",
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
            policy.setDefaultResponse(PolicyArea.fs_mmap, PolicyFallbackResponse.allow);
            const view = policy.beginNativeFilesystemToolCall(AGENT, {toolName: "mmap-test"});
            let stderr = "";
            try {
                const result = await runNativeFuseSandboxedCommand({
                    command: ["python3", "-c", script, target],
                    cwd: directory, policyView: view, sessionBroker: broker,
                    timeoutSeconds: 20, onStderr: (data) => { stderr += data; },
                });
                assert.equal(result.exitCode, 0, stderr);
                const bytes = readFileSync(target);
                assert.equal(bytes.subarray(0, 7).toString(), "parent!");
                assert.equal(bytes.subarray(-7).toString(), "content");
                assert.equal(broker?.activeMountCount ?? 0, 0);
            } finally {
                view.close();
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
        policy.setDefaultResponse(PolicyArea.fs_mmap, PolicyFallbackResponse.allow);
        const view = policy.beginNativeFilesystemToolCall(AGENT, {toolName: "mmap-go-test"});
        let stderr = "";
        try {
            const result = await runNativeFuseSandboxedCommand({
                command: ["go", "build", "-o", target, path.join(directory, "main.go")],
                cwd: directory, policyView: view, sessionBroker: broker,
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
