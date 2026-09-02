import {
    PolicyAccessType,
    PolicyResponse,
} from "../../types.js";
import type {NativeFilesystemPolicySnapshot} from "./NativeFilesystemPolicyView.js";

const SNAPSHOT_MAGIC = Buffer.from("PILOTNP2", "ascii");
const SNAPSHOT_HEADER_BYTES = SNAPSHOT_MAGIC.length + 8 + 4;
const RULE_HEADER_BYTES = 4 + 1 + 1 + 2 + 4;
const CONTROL_HEADER_BYTES = 8;
const MAX_CONTROL_PAYLOAD_BYTES = 16 * 1024 * 1024;

export enum NativeFilesystemAccess {
    READ = 1,
    WRITE = 2,
}

export enum NativeFilesystemDecision {
    ALLOW = 1,
    DENY = 2,
}

export enum NativeFilesystemRequestMessage {
    MISS = 1,
    DENIAL = 2,
    READY = 4,
}

export enum NativeFilesystemResponseMessage {
    ONCE_SNAPSHOT = 1,
    RESOLUTION = 2,
}

export type NativeFilesystemControlFrame = {
    type: number;
    payload: Buffer;
};

export type NativeFilesystemPolicyMiss = {
    requestId: bigint;
    baseRevision: bigint;
    onceRevision: bigint;
    access: NativeFilesystemAccess;
    path: string;
};

export function encodeNativeFilesystemPolicySnapshot(snapshot: NativeFilesystemPolicySnapshot): Buffer {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
        throw new Error(`Invalid native filesystem policy revision: ${snapshot.revision}`);
    }
    if (snapshot.layers.length > 64) {
        throw new Error(`Too many native filesystem policy layers: ${snapshot.layers.length}`);
    }
    const rules = snapshot.layers.flatMap((layer, layerIndex) => (
        layer.policies.flatMap((policy) => Object.values(policy.info).flatMap((status) => {
            if (!status) return [];
            if (status.accessType !== PolicyAccessType.FS_READ
                && status.accessType !== PolicyAccessType.FS_WRITE) return [];
            const path = Buffer.from(policy.pattern, "utf8");
            if (!policy.pattern.startsWith("/") || policy.pattern.includes("\0") || path.length >= 4096) {
                throw new Error(`Invalid native filesystem policy path: ${JSON.stringify(policy.pattern)}`);
            }
            return [{
                layer: layerIndex,
                access: status.accessType === PolicyAccessType.FS_READ
                    ? NativeFilesystemAccess.READ
                    : NativeFilesystemAccess.WRITE,
                decision: status.status === PolicyResponse.ALLOWED
                    ? NativeFilesystemDecision.ALLOW
                    : NativeFilesystemDecision.DENY,
                path,
            }];
        }))
    ));
    if (rules.length > 0xffff_ffff) {
        throw new Error(`Too many native filesystem policy rules: ${rules.length}`);
    }
    const bytes = SNAPSHOT_HEADER_BYTES + rules.reduce(
        (total, rule) => total + RULE_HEADER_BYTES + rule.path.length,
        0,
    );
    const output = Buffer.allocUnsafe(bytes);
    let offset = 0;
    SNAPSHOT_MAGIC.copy(output, offset);
    offset += SNAPSHOT_MAGIC.length;
    output.writeBigUInt64LE(BigInt(snapshot.revision), offset);
    offset += 8;
    output.writeUInt32LE(rules.length, offset);
    offset += 4;
    for (const rule of rules) {
        output.writeUInt32LE(rule.layer, offset);
        offset += 4;
        output.writeUInt8(rule.access, offset++);
        output.writeUInt8(rule.decision, offset++);
        output.writeUInt16LE(0, offset);
        offset += 2;
        output.writeUInt32LE(rule.path.length, offset);
        offset += 4;
        rule.path.copy(output, offset);
        offset += rule.path.length;
    }
    return output;
}

export function encodeNativeFilesystemOnceSnapshotMessage(snapshot: NativeFilesystemPolicySnapshot): Buffer {
    return encodeControlFrame(
        NativeFilesystemResponseMessage.ONCE_SNAPSHOT,
        encodeNativeFilesystemPolicySnapshot(snapshot),
    );
}

export function encodeNativeFilesystemResolutionMessage(
    requestId: bigint,
    baseRevision: number,
    onceRevision: number,
    decision: NativeFilesystemDecision,
): Buffer {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        throw new Error(`Invalid native filesystem base resolution revision: ${baseRevision}`);
    }
    if (!Number.isSafeInteger(onceRevision) || onceRevision < 0) {
        throw new Error(`Invalid native filesystem ONCE resolution revision: ${onceRevision}`);
    }
    const payload = Buffer.allocUnsafe(25);
    payload.writeBigUInt64LE(requestId, 0);
    payload.writeBigUInt64LE(BigInt(baseRevision), 8);
    payload.writeBigUInt64LE(BigInt(onceRevision), 16);
    payload.writeUInt8(decision, 24);
    return encodeControlFrame(NativeFilesystemResponseMessage.RESOLUTION, payload);
}

export function decodeNativeFilesystemControlFrames(bytes: Buffer): {
    frames: NativeFilesystemControlFrame[];
    remainder: Buffer;
} {
    const frames: NativeFilesystemControlFrame[] = [];
    let offset = 0;
    while (bytes.length - offset >= CONTROL_HEADER_BYTES) {
        const type = bytes.readUInt32LE(offset);
        const payloadLength = bytes.readUInt32LE(offset + 4);
        if (payloadLength > MAX_CONTROL_PAYLOAD_BYTES) {
            throw new Error(`Native filesystem control payload is too large: ${payloadLength}`);
        }
        const frameLength = CONTROL_HEADER_BYTES + payloadLength;
        if (bytes.length - offset < frameLength) break;
        frames.push({
            type,
            payload: bytes.subarray(offset + CONTROL_HEADER_BYTES, offset + frameLength),
        });
        offset += frameLength;
    }
    return {frames, remainder: bytes.subarray(offset)};
}

export function decodeNativeFilesystemPolicyMiss(payload: Buffer): NativeFilesystemPolicyMiss {
    if (payload.length < 32) throw new Error("Native filesystem policy miss payload is truncated");
    const pathLength = payload.readUInt32LE(28);
    if (pathLength === 0 || pathLength >= 4096 || payload.length !== 32 + pathLength) {
        throw new Error("Native filesystem policy miss has an invalid path length");
    }
    const access = payload.readUInt8(24);
    if (access !== NativeFilesystemAccess.READ && access !== NativeFilesystemAccess.WRITE) {
        throw new Error(`Native filesystem policy miss has an invalid access type: ${access}`);
    }
    const pathBytes = payload.subarray(32);
    if (pathBytes[0] !== 0x2f || pathBytes.includes(0)) {
        throw new Error("Native filesystem policy miss has an invalid path");
    }
    return {
        requestId: payload.readBigUInt64LE(0),
        baseRevision: payload.readBigUInt64LE(8),
        onceRevision: payload.readBigUInt64LE(16),
        access,
        path: pathBytes.toString("utf8"),
    };
}

function encodeControlFrame(type: number, payload: Buffer): Buffer {
    if (payload.length > MAX_CONTROL_PAYLOAD_BYTES) {
        throw new Error(`Native filesystem control payload is too large: ${payload.length}`);
    }
    const output = Buffer.allocUnsafe(CONTROL_HEADER_BYTES + payload.length);
    output.writeUInt32LE(type, 0);
    output.writeUInt32LE(payload.length, 4);
    payload.copy(output, CONTROL_HEADER_BYTES);
    return output;
}
