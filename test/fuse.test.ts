import assert from "node:assert/strict";
import {
    chmodSync,
    constants,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import {open, readdir, readlink, stat, statfs} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {getAttribute, setAttribute} from "fs-xattr";
import {runFuseSandboxedCommand} from "../src/policy/path/fuse/fuse-runner.js";
import {
    FuseAccessType,
    FuseDecision,
    FuseFilesystem,
    FuseOperation,
} from "../src/policy/path/fuse/FuseFilesystem.js";
import type {FusePolicyEvent} from "../src/policy/path/fuse/FuseFilesystem.js";

test("the FUSE worker mediates the host root while preserving paths outside its cwd", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-test-"));
    const allowedPath = path.join(workspace, "allowed.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    const descendantPath = path.join(workspace, "descendant.txt");
    const hostOnlyPath = path.join(workspace, "host-only.txt");
    const hostOnlyCopyPath = path.join(workspace, "host-only-copy.txt");
    const hostnameCopyPath = path.join(workspace, "hostname-copy.txt");
    const listingPath = path.join(workspace, "listing.txt");
    const outsideDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-outside-"));
    const outsidePath = path.join(outsideDirectory, "outside.txt");
    const outsideWritablePath = path.join(outsideDirectory, "worker-write.txt");
    writeFileSync(hostOnlyPath, "host-only\n");
    writeFileSync(outsidePath, "untouched\n");
    symlinkSync(outsidePath, path.join(workspace, "escape"));
    const events: FusePolicyEvent[] = [];
    const deniedWrites = new Set([deniedPath, outsidePath]);

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    "printf 'allowed\\n' > allowed.txt",
                    "if printf 'denied\\n' > denied.txt; then exit 80; fi",
                    "sh -c \"printf 'descendant\\n' > descendant.txt\"",
                    `cat ${shellQuote(hostOnlyPath)} > ${shellQuote(hostOnlyCopyPath)}`,
                    `cat /etc/hostname > ${shellQuote(hostnameCopyPath)}`,
                    "printf ignored > /dev/null || exit 86",
                    `ls > ${shellQuote(listingPath)}`,
                    `printf 'transparent\\n' > ${shellQuote(outsideWritablePath)}`,
                    "if printf hacked > escape; then exit 83; fi",
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.pathAccesses.some(
                    (access) => access.access === FuseAccessType.WRITE && deniedWrites.has(access.path),
                );
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(readFileSync(allowedPath, "utf8"), "allowed\n");
        assert.equal(readFileSync(descendantPath, "utf8"), "descendant\n");
        assert.equal(readFileSync(hostOnlyCopyPath, "utf8"), "host-only\n");
        assert.equal(readFileSync(hostnameCopyPath, "utf8"), readFileSync("/etc/hostname", "utf8"));
        assert.equal(existsSync(deniedPath), false);
        assert.equal(readFileSync(outsidePath, "utf8"), "untouched\n");
        assert.equal(readFileSync(outsideWritablePath, "utf8"), "transparent\n");
        assert.equal(hasAccess(events, FuseAccessType.WRITE, deniedPath), true);
        assert.equal(hasAccess(events, FuseAccessType.READ, hostOnlyPath), true);
        assert.equal(hasAccess(events, FuseAccessType.READ, "/etc/hostname"), true);
        assert.equal(
            events.some((event) => event.operation === FuseOperation.READDIR
                && event.pathAccesses.some((access) => access.path === workspace)),
            true,
        );
        assert.equal(
            hasAccess(events, FuseAccessType.READ, "/bin/bash")
                || hasAccess(events, FuseAccessType.READ, "/usr/bin/bash"),
            true,
        );
        assert.equal(hasAccess(events, FuseAccessType.WRITE, outsideWritablePath), true);
        assert.equal(hasAccess(events, FuseAccessType.WRITE, outsidePath), true);
    } finally {
        rmSync(workspace, {recursive: true, force: true});
        rmSync(outsideDirectory, {recursive: true, force: true});
    }
});

test("FUSE mediates timestamp updates used by touch", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-utimens-test-"));
    const createdPath = path.join(workspace, "created.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    const oldTimestamp = new Date("2001-02-03T04:05:06.000Z");
    writeFileSync(deniedPath, "unchanged\n");
    utimesSync(deniedPath, oldTimestamp, oldTimestamp);
    const deniedMtimeBefore = statSync(deniedPath).mtimeMs;
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                `touch ${shellQuote(createdPath)}; if touch ${shellQuote(deniedPath)}; then exit 87; fi`,
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.UTIMENS
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(existsSync(createdPath), true);
        assert.equal(
            events.some((event) => event.operation === FuseOperation.UTIMENS
                && event.pathAccesses.some((access) => access.path === createdPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.UTIMENS
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
        assert.equal(statSync(deniedPath).mtimeMs, deniedMtimeBefore);
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates chmod as a write", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-chmod-test-"));
    const allowedPath = path.join(workspace, "allowed.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    writeFileSync(allowedPath, "allowed\n");
    writeFileSync(deniedPath, "denied\n");
    chmodSync(allowedPath, 0o600);
    chmodSync(deniedPath, 0o600);
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                `chmod 0644 ${shellQuote(allowedPath)}; if chmod 0644 ${shellQuote(deniedPath)}; then exit 87; fi`,
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.CHMOD
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(statSync(allowedPath).mode & 0o777, 0o644);
        assert.equal(statSync(deniedPath).mode & 0o777, 0o600);
        assert.equal(
            events.some((event) => event.operation === FuseOperation.CHMOD
                && event.pathAccesses.some((access) => access.path === allowedPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.CHMOD
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates chown as a write", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-chown-test-"));
    const ownerOnlyPath = path.join(workspace, "owner-only.txt");
    const groupOnlyPath = path.join(workspace, "group-only.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    writeFileSync(ownerOnlyPath, "owner\n");
    writeFileSync(groupOnlyPath, "group\n");
    writeFileSync(deniedPath, "denied\n");
    const initialOwnership = statSync(ownerOnlyPath);
    const uid = initialOwnership.uid;
    const gid = initialOwnership.gid;
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `chown ${uid} ${shellQuote(ownerOnlyPath)}`,
                    `chown :${gid} ${shellQuote(groupOnlyPath)}`,
                    `if chown ${uid}:${gid} ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.CHOWN
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        for (const allowedPath of [ownerOnlyPath, groupOnlyPath]) {
            const metadata = statSync(allowedPath);
            assert.equal(metadata.uid, uid);
            assert.equal(metadata.gid, gid);
            assert.equal(
                events.some((event) => event.operation === FuseOperation.CHOWN
                    && event.pathAccesses.some((access) => access.path === allowedPath)),
                true,
            );
        }
        const deniedMetadata = statSync(deniedPath);
        assert.equal(deniedMetadata.uid, uid);
        assert.equal(deniedMetadata.gid, gid);
        assert.equal(
            events.some((event) => event.operation === FuseOperation.CHOWN
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates extended-attribute reads", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-getxattr-test-"));
    const allowedPath = path.join(workspace, "allowed.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    const attributeName = "user.pi.lot.test";
    writeFileSync(allowedPath, "allowed\n");
    writeFileSync(deniedPath, "denied\n");
    await setAttribute(allowedPath, attributeName, "allowed-attribute");
    await setAttribute(deniedPath, attributeName, "denied-attribute");
    const events: FusePolicyEvent[] = [];
    let stdout = "";

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `getfattr --name=${attributeName} --only-values ${shellQuote(allowedPath)}`,
                    `if getfattr --name=${attributeName} --only-values ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.GETXATTR
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
            onStdout(data) {
                stdout += data.toString();
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(stdout.trim(), "allowed-attribute");
        assert.equal(
            events.some((event) => event.operation === FuseOperation.GETXATTR
                && event.pathAccesses.some((access) => access.path === allowedPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.GETXATTR
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates extended-attribute listings", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-listxattr-test-"));
    const allowedPath = path.join(workspace, "allowed.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    writeFileSync(allowedPath, "allowed\n");
    writeFileSync(deniedPath, "denied\n");
    await setAttribute(allowedPath, "user.pi.lot.first", "first");
    await setAttribute(allowedPath, "user.pi.lot.second", "second");
    await setAttribute(deniedPath, "user.pi.lot.denied", "denied");
    const listScript = "import os, sys; print('\\n'.join(sorted(os.listxattr(sys.argv[1]))))";
    const probeScript = "import os, sys; os.listxattr(sys.argv[1])";
    const events: FusePolicyEvent[] = [];
    let stdout = "";

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `python3 -c ${shellQuote(listScript)} ${shellQuote(allowedPath)}`,
                    `if python3 -c ${shellQuote(probeScript)} ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.LISTXATTR
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
            onStdout(data) {
                stdout += data.toString();
            },
        });

        assert.equal(result.exitCode, 0);
        const attributeNames = new Set(stdout.trim().split("\n"));
        assert.equal(attributeNames.has("user.pi.lot.first"), true);
        assert.equal(attributeNames.has("user.pi.lot.second"), true);
        assert.equal(
            events.some((event) => event.operation === FuseOperation.LISTXATTR
                && event.pathAccesses.some((access) => access.path === allowedPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.LISTXATTR
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates extended-attribute writes", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-setxattr-test-"));
    const allowedPath = path.join(workspace, "allowed.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    const attributeName = "user.pi.lot.test";
    writeFileSync(allowedPath, "allowed\n");
    writeFileSync(deniedPath, "denied\n");
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `setfattr --name=${attributeName} --value=allowed-attribute ${shellQuote(allowedPath)}`,
                    `if setfattr --name=${attributeName} --value=denied-attribute ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.SETXATTR
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal((await getAttribute(allowedPath, attributeName)).toString(), "allowed-attribute");
        await assert.rejects(getAttribute(deniedPath, attributeName));
        assert.equal(
            events.some((event) => event.operation === FuseOperation.SETXATTR
                && event.pathAccesses.some((access) => access.path === allowedPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.SETXATTR
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates extended-attribute removal", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-removexattr-test-"));
    const allowedPath = path.join(workspace, "allowed.txt");
    const deniedPath = path.join(workspace, "denied.txt");
    const attributeName = "user.pi.lot.test";
    writeFileSync(allowedPath, "allowed\n");
    writeFileSync(deniedPath, "denied\n");
    await setAttribute(allowedPath, attributeName, "allowed-attribute");
    await setAttribute(deniedPath, attributeName, "denied-attribute");
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `setfattr --remove=${attributeName} ${shellQuote(allowedPath)}`,
                    `if setfattr --remove=${attributeName} ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.REMOVEXATTR
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        await assert.rejects(getAttribute(allowedPath, attributeName));
        assert.equal((await getAttribute(deniedPath, attributeName)).toString(), "denied-attribute");
        assert.equal(
            events.some((event) => event.operation === FuseOperation.REMOVEXATTR
                && event.pathAccesses.some((access) => access.path === allowedPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.REMOVEXATTR
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates special-node creation", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-mknod-test-"));
    const allowedPath = path.join(workspace, "allowed.fifo");
    const deniedPath = path.join(workspace, "denied.fifo");
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `mkfifo ${shellQuote(allowedPath)}`,
                    `if mkfifo ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.MKNOD
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(statSync(allowedPath).isFIFO(), true);
        assert.equal(existsSync(deniedPath), false);
        assert.equal(
            events.some((event) => event.operation === FuseOperation.MKNOD
                && event.pathAccesses.some((access) => access.path === allowedPath)),
            true,
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.MKNOD
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("FUSE mediates hard-link creation across both paths", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-link-test-"));
    const sourcePath = path.join(workspace, "source.txt");
    const allowedPath = path.join(workspace, "allowed-link.txt");
    const deniedPath = path.join(workspace, "denied-link.txt");
    writeFileSync(sourcePath, "linked\n");
    const events: FusePolicyEvent[] = [];

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                [
                    `ln ${shellQuote(sourcePath)} ${shellQuote(allowedPath)}`,
                    `if ln ${shellQuote(sourcePath)} ${shellQuote(deniedPath)}; then exit 87; fi`,
                ].join("; "),
            ],
            cwd: workspace,
            decide(event) {
                events.push(event);
                const denied = event.operation === FuseOperation.LINK
                    && event.pathAccesses.some((access) => access.path === deniedPath);
                return denied ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(existsSync(allowedPath), true);
        assert.equal(existsSync(deniedPath), false);
        assert.equal(statSync(allowedPath).ino, statSync(sourcePath).ino);
        assert.equal(statSync(sourcePath).nlink, 2);
        assert.deepEqual(
            events.find((event) => event.operation === FuseOperation.LINK
                && event.pathAccesses.some((access) => access.path === allowedPath))?.pathAccesses,
            [
                {access: FuseAccessType.READ, path: sourcePath},
                {access: FuseAccessType.WRITE, path: allowedPath},
            ],
        );
        assert.equal(
            events.some((event) => event.operation === FuseOperation.LINK
                && event.pathAccesses.some((access) => access.path === deniedPath)),
            true,
        );
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

test("root-wide FUSE mediation covers hard-link aliases", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-hardlink-test-"));
    const outsideDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-hardlink-outside-"));
    const governedPath = path.join(workspace, "governed.txt");
    const aliasPath = path.join(outsideDirectory, "alias.txt");
    writeFileSync(governedPath, "unchanged\n");
    linkSync(governedPath, aliasPath);
    let aliasWriteObserved = false;

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                `if printf changed > ${shellQuote(aliasPath)}; then exit 85; fi`,
            ],
            cwd: workspace,
            decide(event) {
                const writesAlias = event.pathAccesses.some(
                    (access) => access.access === FuseAccessType.WRITE && access.path === aliasPath,
                );
                aliasWriteObserved ||= writesAlias;
                return writesAlias ? FuseDecision.DENY : FuseDecision.ALLOW;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(aliasWriteObserved, true);
        assert.equal(readFileSync(governedPath, "utf8"), "unchanged\n");
    } finally {
        rmSync(workspace, {recursive: true, force: true});
        rmSync(outsideDirectory, {recursive: true, force: true});
    }
});

test("FUSE keeps lookup metadata transparent and hides its reserved broker subtree", async () => {
    const backingRoot = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-hidden-backing-"));
    const mountDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-hidden-mount-"));
    const mountpoint = path.join(mountDirectory, "root");
    const hiddenDirectory = path.join(backingRoot, "broker-internal");
    mkdirSync(mountpoint);
    mkdirSync(hiddenDirectory);
    writeFileSync(path.join(backingRoot, "visible.txt"), "visible\n");
    symlinkSync("visible.txt", path.join(backingRoot, "visible-link"));
    writeFileSync(path.join(hiddenDirectory, "secret.txt"), "secret\n");
    const events: FusePolicyEvent[] = [];
    const filesystem = new FuseFilesystem({
        backingRoot,
        mountpoint,
        hiddenFusePaths: ["/broker-internal"],
        decide(event) {
            events.push(event);
            return FuseDecision.ALLOW;
        },
    });
    let mounted = false;

    try {
        await filesystem.mount();
        mounted = true;
        await stat(path.join(mountpoint, "visible.txt"));
        assert.equal(await readlink(path.join(mountpoint, "visible-link")), "visible.txt");
        const directoryHandle = await open(mountpoint, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
        const filesystemStats = await statfs(mountpoint);
        assert.equal(filesystemStats.bsize > 0, true);
        assert.equal(filesystemStats.blocks > 0, true);
        assert.equal(events.length, 0);
        assert.equal(hasAccess(events, FuseAccessType.READ, "/visible.txt"), false);
        assert.equal(hasAccess(events, FuseAccessType.READ, "/visible-link"), false);
        assert.deepEqual((await readdir(mountpoint)).sort(), ["visible-link", "visible.txt"]);
        await assert.rejects(
            stat(path.join(mountpoint, "broker-internal")),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
        assert.equal(hasAccess(events, FuseAccessType.READ, "/broker-internal"), false);
    } finally {
        if (mounted) await filesystem.unmount();
        rmSync(backingRoot, {recursive: true, force: true});
        rmSync(mountDirectory, {recursive: true, force: true});
    }
});

test("FUSE write policy is re-evaluated for an already-open descriptor", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pi-fuse-handle-test-"));
    const openHandlePath = path.join(workspace, "open-handle.txt");
    let writes = 0;

    try {
        const result = await runFuseSandboxedCommand({
            command: [
                "/bin/bash",
                "-c",
                "exec 3>open-handle.txt; printf first >&3; if printf second >&3; then exit 90; fi",
            ],
            cwd: workspace,
            decide(event) {
                if (event.operation !== FuseOperation.WRITE
                    || event.pathAccesses[0]?.path !== openHandlePath) {
                    return FuseDecision.ALLOW;
                }
                writes++;
                return writes === 1 ? FuseDecision.ALLOW : FuseDecision.DENY;
            },
        });

        assert.equal(result.exitCode, 0);
        assert.equal(writes, 2);
        assert.equal(readFileSync(openHandlePath, "utf8"), "first");
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

function hasAccess(events: FusePolicyEvent[], accessType: FuseAccessType, target: string): boolean {
    return events.some((event) => event.pathAccesses.some(
        (access) => access.access === accessType && access.path === target,
    ));
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
