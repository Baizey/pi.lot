import {renameSync, rmSync, writeFileSync} from "node:fs";
import {encodeNativeFilesystemPolicySnapshot} from "./NativeFilesystemPolicyProtocol.js";
import type {NativeFilesystemPolicySnapshot} from "./NativeFilesystemPolicyView.js";

let temporarySequence = 0;

export function replaceNativeFilesystemSnapshotFile(
    snapshotPath: string,
    snapshot: NativeFilesystemPolicySnapshot,
): void {
    const temporaryPath = `${snapshotPath}.next-${process.pid}-${temporarySequence++}`;
    try {
        writeFileSync(
            temporaryPath,
            encodeNativeFilesystemPolicySnapshot(snapshot),
            {mode: 0o600},
        );
        renameSync(temporaryPath, snapshotPath);
    } finally {
        rmSync(temporaryPath, {force: true});
    }
}
