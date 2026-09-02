import assert from "node:assert/strict";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {PolicyDecisionFlow, PolicyChoice} from "../src/policy/PolicyDecisionFlow.js";
import PolicyRuntime from "../src/policy/PolicyRuntime.js";
import {
    PolicyAccessType,
    PolicyArea,
    PolicyFallbackResponse,
    PolicyLifetime,
    PolicyResponse,
} from "../src/policy/types.js";
import {runNativeFuseSandboxedCommand} from "../src/policy/path/native/native-fuse-runner.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";

const AGENT = "native-fuse-test";

function policyDao(): PolicyDaoInterface {
    return {
        initializeSchema() {
        },
        loadPolicies: () => [],
        upsertPolicies() {
        },
        deletePolicy() {
        },
    };
}

function decisionFlow(choices: PolicyChoice[] = []): PolicyDecisionFlow {
    let index = 0;
    return {
        async askForPolicy(): Promise<PolicyChoice> {
            const choice = choices[index++];
            assert.ok(choice, "Unexpected native FUSE policy request");
            return choice;
        },
    } as unknown as PolicyDecisionFlow;
}

function allowingRuntime(flow: PolicyDecisionFlow = decisionFlow()): PolicyRuntime {
    const runtime = new PolicyRuntime(AGENT, policyDao(), flow);
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);
    return runtime;
}

test("native FUSE preserves the complete writable filesystem contract", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-parity-"));
    const directory = path.join(workspace, "directory");
    const file = path.join(directory, "file.txt");
    const movedLink = path.join(directory, "moved-link.txt");
    const fifo = path.join(directory, "pipe");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    let stdout = "";

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `mkdir ${shellQuote(directory)}`,
                    `printf 'abcdef' > ${shellQuote(file)}`,
                    `chmod 0640 ${shellQuote(file)}`,
                    `touch -m ${shellQuote(file)}`,
                    `setfattr --name=user.pi_lot --value=native ${shellQuote(file)}`,
                    `getfattr --name=user.pi_lot --only-values ${shellQuote(file)}`,
                    `setfattr --remove=user.pi_lot ${shellQuote(file)}`,
                    `mkfifo ${shellQuote(fifo)}`,
                    `ln ${shellQuote(file)} ${shellQuote(path.join(directory, "hard-link.txt"))}`,
                    `mv ${shellQuote(path.join(directory, "hard-link.txt"))} ${shellQuote(movedLink)}`,
                    `ln -s file.txt ${shellQuote(path.join(directory, "symbolic-link.txt"))}`,
                    `test "$(readlink ${shellQuote(path.join(directory, "symbolic-link.txt"))})" = file.txt`,
                    `python3 -c ${shellQuote("import os,sys; f=os.open(sys.argv[1],os.O_RDWR); os.ftruncate(f,3); os.fsync(f); os.close(f)")} ${shellQuote(file)}`,
                    `python3 -c ${shellQuote("import os,sys; f=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY); os.fsync(f); os.close(f)")} ${shellQuote(directory)}`,
                    `cat ${shellQuote(file)}`,
                    `rm ${shellQuote(path.join(directory, "symbolic-link.txt"))} ${shellQuote(movedLink)} ${shellQuote(fifo)} ${shellQuote(file)}`,
                    `rmdir ${shellQuote(directory)}`,
                ].join(" && "),
            ],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
            onStdout: (data) => {
                stdout += data;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.signal, null);
        assert.match(stdout, /native/);
        assert.match(stdout, /abc/);
        assert.equal(existsSync(directory), false);
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE resolves a write miss through PolicyRuntime before creating the file", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-miss-"));
    const target = path.join(workspace, "approved.txt");
    const choice: PolicyChoice = {
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.ONCE,
        status: PolicyResponse.ALLOWED,
        reason: "native write approval test",
    };
    const runtime = new PolicyRuntime(AGENT, policyDao(), decisionFlow([choice]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: ["/bin/bash", "-c", `printf approved > ${shellQuote(target)}`],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(readFileSync(target, "utf8"), "approved");
        assert.equal(view.onceSnapshot().layers[0]!.policies[0]!.pattern, target);
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE re-evaluates policy before writing an already-open descriptor", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-handle-"));
    const target = path.join(workspace, "open-handle.txt");
    const continuePath = path.join(workspace, "continue");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    let defaultChanged = false;

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                `exec 3>${shellQuote(target)}; printf first >&3; echo FIRST_DONE; `
                + `while [ ! -e ${shellQuote(continuePath)} ]; do sleep 0.01; done; `
                + "if printf second >&3; then exit 90; fi",
            ],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
            onStdout: (data) => {
                if (defaultChanged || !data.toString().includes("FIRST_DONE")) return;
                runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.deny);
                writeFileSync(continuePath, "continue");
                defaultChanged = true;
            },
        });

        assert.equal(defaultChanged, true);
        assert.equal(result.exitCode, 0);
        assert.equal(readFileSync(target, "utf8"), "first");
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE authorizes and enumerates the current directory identity", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-readdir-identity-"));
    const directory = path.join(workspace, "directory");
    const moved = path.join(workspace, "moved");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "stale.txt"), "stale");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    let replaced = false;
    let stdout = "";
    const script = [
        "import os,sys,time",
        "descriptor=os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)",
        "print('OPEN_DONE', flush=True)",
        "time.sleep(0.5)",
        "print(','.join(sorted(os.listdir(descriptor))), flush=True)",
        "os.close(descriptor)",
    ].join("\n");

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: ["python3", "-c", script, directory],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
            onStdout: (data) => {
                stdout += data;
                if (replaced || !stdout.includes("OPEN_DONE")) return;
                renameSync(directory, moved);
                mkdirSync(directory);
                writeFileSync(path.join(directory, "current.txt"), "current");
                replaced = true;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(replaced, true);
        assert.match(stdout, /current\.txt/);
        assert.doesNotMatch(stdout, /stale\.txt/);
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE re-evaluates policy before rereading an already-open descriptor", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-read-handle-"));
    const target = path.join(workspace, "open-handle.txt");
    writeFileSync(target, "content");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    let defaultChanged = false;
    const script = [
        "import os,sys,time",
        "descriptor=os.open(sys.argv[1], os.O_RDONLY)",
        "os.read(descriptor, 1)",
        "print('FIRST_DONE', flush=True)",
        "time.sleep(0.5)",
        "os.lseek(descriptor, 0, os.SEEK_SET)",
        "status=90",
        "try:",
        " os.read(descriptor, 1)",
        "except OSError:",
        " status=0",
        "os.close(descriptor)",
        "raise SystemExit(status)",
    ].join("\n");

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: ["python3", "-c", script, target],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
            onStdout: (data) => {
                if (defaultChanged || !data.toString().includes("FIRST_DONE")) return;
                runtime.setDefaultResponse(PolicyArea.fs_read, PolicyFallbackResponse.deny);
                defaultChanged = true;
            },
        });

        assert.equal(defaultChanged, true);
        assert.equal(result.exitCode, 0);
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE preserves physical policy identity for final symlink-node mutations", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-symlink-policy-"));
    const target = path.join(workspace, "target.txt");
    const alias = path.join(workspace, "alias.txt");
    writeFileSync(target, "preserved");
    symlinkSync(target, alias);
    const denial: PolicyChoice = {
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        lifetime: PolicyLifetime.SESSION,
        status: PolicyResponse.DENIED,
        reason: "deny physical symlink target",
    };
    const runtime = new PolicyRuntime(AGENT, policyDao(), decisionFlow([denial]));
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    await view.evaluate(target, PolicyAccessType.FS_WRITE);
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.allow);

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: ["/bin/bash", "-c", `if rm ${shellQuote(alias)}; then exit 91; fi`],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(lstatSync(alias).isSymbolicLink(), true);
        assert.equal(readFileSync(target, "utf8"), "preserved");
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE reports known policy denials with the standard message", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-denial-"));
    const target = path.join(workspace, "denied.txt");
    const runtime = new PolicyRuntime(AGENT, policyDao(), decisionFlow());
    runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.deny);
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    const denials: string[] = [];

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: ["/bin/bash", "-c", `if printf denied > ${shellQuote(target)}; then exit 91; fi`],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
            onPolicyDeny: (message) => denials.push(message),
        });

        assert.equal(result.exitCode, 0);
        assert.equal(existsSync(target), false);
        assert.equal(denials.length > 0, true);
        assert.match(denials.join("\n"), /^ACCESS DENIED/m);
        assert.match(denials.join("\n"), /attempted access of type FS_WRITE/);
        assert.match(denials.join("\n"), /Policy resolution source: SYSTEM/);
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE aborts a pending policy miss and leaves the filesystem unchanged", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-abort-"));
    const target = path.join(workspace, "pending.txt");
    const pendingFlow = {
        askForPolicy: () => new Promise<PolicyChoice>(() => undefined),
    } as unknown as PolicyDecisionFlow;
    const runtime = new PolicyRuntime(AGENT, policyDao(), pendingFlow);
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});
    const controller = new AbortController();
    const started = performance.now();
    const timeout = setTimeout(() => controller.abort(), 100);

    try {
        await assert.rejects(
            runNativeFuseSandboxedCommand({
                command: ["/bin/bash", "-c", `printf pending > ${shellQuote(target)}`],
                cwd: workspace,
                policyView: view,
                signal: controller.signal,
                timeoutSeconds: 20,
            }),
            /aborted/,
        );
        assert.equal(existsSync(target), false);
        assert.equal(performance.now() - started < 2_000, true);
    } finally {
        clearTimeout(timeout);
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("concurrent native FUSE tool calls keep ONCE policy views isolated", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-concurrent-"));
    const target = path.join(workspace, "shared.txt");
    const choices: PolicyChoice[] = [
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.DENIED,
            reason: "deny in the first tool call",
        },
        {
            uri: target,
            accessType: PolicyAccessType.FS_WRITE,
            lifetime: PolicyLifetime.ONCE,
            status: PolicyResponse.ALLOWED,
            reason: "allow in the second tool call",
        },
    ];
    const runtime = new PolicyRuntime(AGENT, policyDao(), decisionFlow(choices));
    const deniedView = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test-denied"});
    const allowedView = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test-allowed"});
    await deniedView.evaluate(target, PolicyAccessType.FS_WRITE);
    await allowedView.evaluate(target, PolicyAccessType.FS_WRITE);

    try {
        const [denied, allowed] = await Promise.all([
            runNativeFuseSandboxedCommand({
                command: ["/bin/bash", "-c", `if printf denied > ${shellQuote(target)}; then exit 91; fi`],
                cwd: workspace,
                policyView: deniedView,
                timeoutSeconds: 20,
            }),
            runNativeFuseSandboxedCommand({
                command: ["/bin/bash", "-c", `sleep 0.1; printf allowed > ${shellQuote(target)}`],
                cwd: workspace,
                policyView: allowedView,
                timeoutSeconds: 20,
            }),
        ]);

        assert.equal(denied.exitCode, 0);
        assert.equal(allowed.exitCode, 0);
        assert.equal(readFileSync(target, "utf8"), "allowed");
        assert.equal(deniedView.onceSnapshot().layers[0]!.policies[0]!.info[PolicyAccessType.FS_WRITE]?.status,
            PolicyResponse.DENIED);
        assert.equal(allowedView.onceSnapshot().layers[0]!.policies[0]!.info[PolicyAccessType.FS_WRITE]?.status,
            PolicyResponse.ALLOWED);
    } finally {
        deniedView.close();
        allowedView.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("native FUSE rejects absolute symbolic-link targets", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-native-fuse-symlink-"));
    const target = path.join(workspace, "absolute-link");
    writeFileSync(path.join(workspace, "existing.txt"), "existing");
    const runtime = allowingRuntime();
    const view = runtime.beginNativeFilesystemToolCall(AGENT, {toolName: "native-fuse-test"});

    try {
        const result = await runNativeFuseSandboxedCommand({
            command: ["/bin/bash", "-c", `if ln -s /etc/hostname ${shellQuote(target)}; then exit 91; fi`],
            cwd: workspace,
            policyView: view,
            timeoutSeconds: 20,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(existsSync(target), false);
        assert.equal(statSync(path.join(workspace, "existing.txt")).isFile(), true);
    } finally {
        view.close();
        rmSync(workspace, {recursive: true, force: true});
    }
});

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
