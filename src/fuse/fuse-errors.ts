import Fuse from "fuse-native";

export class FuseError extends Error {
    static toFuseErrno(error: unknown): number {
        if (FuseError.hasFuseErrno(error)) return error.fuseErrno;
        if (FuseError.isNodeError(error) && typeof error.errno === "number") {
            return error.errno > 0 ? -error.errno : error.errno;
        }
        return Fuse.EIO;
    }

    private static hasFuseErrno(error: unknown): error is {fuseErrno: number} {
        return typeof error === "object" && error !== null && "fuseErrno" in error
            && typeof (error as {fuseErrno?: unknown}).fuseErrno === "number";
    }

    private static isNodeError(error: unknown): error is NodeJS.ErrnoException {
        return error instanceof Error;
    }
}

export class FusePolicyError extends FuseError {
    readonly fuseErrno = Fuse.EACCES;
}

export class FuseErrnoError extends FuseError {
    constructor(readonly fuseErrno: number, message: string) {
        super(message);
    }
}

export class FusePathError extends FuseError {
    readonly fuseErrno = Fuse.EPERM;

    constructor(message: string) {
        super(message);
    }
}

export class FuseHandleError extends FuseError {
    readonly fuseErrno = Fuse.EBADF;
}

export class FuseInvalidArgumentError extends FuseError {
    readonly fuseErrno = Fuse.EINVAL;
}

export class FuseHiddenPathError extends FuseError {
    readonly fuseErrno = Fuse.ENOENT;
}