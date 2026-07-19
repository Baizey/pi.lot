import {constants} from "node:fs";
import type {StatsFs} from "node:fs";
import Promises from "node:fs/promises";
import type {FileHandle} from "node:fs/promises";
import path from "node:path";
import Fuse from "fuse-native";
import type {FuseOperations, FuseStatfs} from "fuse-native";
import {getAttribute, listAttributes, removeAttribute, setAttribute} from "fs-xattr";
import {
    FuseError,
    FuseHandleError,
    FuseHiddenPathError,
    FuseInvalidArgumentError,
    FusePathError,
    FusePolicyError,
} from "./fuse-errors";
import {mknod} from "./mknod.js";

const FUSE_UNCHANGED_OWNER_ID = 0xffffffff;

export enum FuseAccessType {
    READ = "READ",
    WRITE = "WRITE",
    DELETE = "DELETE",
}

export enum FuseDecision {
    ALLOW = "ALLOW",
    DENY = "DENY",
}

export enum FuseOperation {
    READDIR = "READDIR",
    OPEN = "OPEN",
    READ = "READ",
    CREATE = "CREATE",
    UTIMENS = "UTIMENS",
    CHMOD = "CHMOD",
    CHOWN = "CHOWN",
    GETXATTR = "GETXATTR",
    LISTXATTR = "LISTXATTR",
    SETXATTR = "SETXATTR",
    REMOVEXATTR = "REMOVEXATTR",
    WRITE = "WRITE",
    TRUNCATE = "TRUNCATE",
    MKNOD = "MKNOD",
    MKDIR = "MKDIR",
    RMDIR = "RMDIR",
    UNLINK = "UNLINK",
    RENAME = "RENAME",
    LINK = "LINK",
    SYMLINK = "SYMLINK",
}

export type FuseFilesystemOptions = {
    backingRoot: string;
    mountpoint: string;
    hiddenFusePaths?: string[];
    decide: (event: FusePolicyEvent) => FuseDecision | Promise<FuseDecision>;
    onDecisionError?: (error: unknown) => void;
};

export type FusePolicyEvent = {
    sequence: number;
    operation: FuseOperation;
    pathAccesses: FusePathAccess[];
};

export type FusePathAccess = {
    access: FuseAccessType;
    path: string;
};

export class FuseFilesystem {
    readonly backingRoot: string;
    readonly mountpoint: string;

    private readonly fuse: Fuse;
    private readonly decide: FuseFilesystemOptions["decide"];
    private readonly onDecisionError: FuseFilesystemOptions["onDecisionError"];
    private readonly hiddenFusePaths: string[];
    private readonly handles = new Map<number, FileHandle>();
    private sequence = 0;
    private decisionQueue: Promise<void> = Promise.resolve();
    private isMounted = false;

    constructor(options: FuseFilesystemOptions) {
        this.backingRoot = path.resolve(options.backingRoot);
        this.mountpoint = path.resolve(options.mountpoint);
        this.hiddenFusePaths = (options.hiddenFusePaths ?? []).map((candidate) => this.validatedFusePath(candidate));
        if (this.hiddenFusePaths.includes("/")) throw new Error("The FUSE root cannot be hidden");
        this.decide = options.decide;
        this.onDecisionError = options.onDecisionError;
        this.fuse = new Fuse(this.mountpoint, this.createOperations(), {
            timeout: false,
            autoUnmount: true,
            fsname: "pilot-fuse",
            subtype: "pilot-fuse",
            entryTimeout: 0.001,
            attrTimeout: 0.001,
            acAttrTimeout: 0.001,
            kernelCache: false,
            autoCache: false,
        });
    }

    async mount(): Promise<void> {
        if (this.isMounted) throw new Error("FUSE filesystem is already mounted");

        await new Promise<void>((resolve, reject) => {
            this.fuse.mount((error) => error ? reject(error) : resolve());
        });
        this.isMounted = true;
    }

    async unmount(): Promise<void> {
        let unmountError: unknown;
        if (this.isMounted) {
            try {
                await new Promise<void>((resolve, reject) => {
                    this.fuse.unmount((error) => error ? reject(error) : resolve());
                });
            } catch (error) {
                unmountError = error;
            } finally {
                this.isMounted = false;
            }
        }

        const handles = [...this.handles.values()];
        this.handles.clear();
        await Promise.allSettled(handles.map((handle) => handle.close()));
        if (unmountError) throw unmountError;
    }

    private createOperations(): FuseOperations {
        return {
            init: (callback) => callback(0),
            error: (callback) => callback(0),

            access: (fusePath, mode, callback) => this.status(callback, async () => {
                await Promises.access(await this.existingPath(fusePath), mode);
            }),

            statfs: (fusePath, callback) => this.value(callback, async () => (
                toFuseStatfs(await Promises.statfs(await this.existingPath(fusePath)))
            )),

            getattr: (fusePath, callback) => this.value(callback, async () => (
                Promises.lstat(await this.nodePath(fusePath))
            )),

            fgetattr: (_fusePath, fileHandle, callback) => this.value(callback, async () => (
                this.handle(fileHandle).stat()
            )),

            readdir: (fusePath, callback) => this.value(callback, async () => {
                await this.authorize(FuseOperation.READDIR, [{access: FuseAccessType.READ, path: fusePath}]);
                const names = await Promises.readdir(await this.existingPath(fusePath));
                return names.filter((name) => !this.isHiddenFusePath(this.childFusePath(fusePath, name)));
            }),

            opendir: (fusePath, flags, callback) => this.value(callback, async () => {
                const handle = await Promises.open(
                    await this.existingPath(fusePath),
                    flags | constants.O_DIRECTORY,
                );
                this.handles.set(handle.fd, handle);
                return handle.fd;
            }),

            fsyncdir: (_fusePath, dataOnly, fileHandle, callback) => this.status(callback, async () => {
                const handle = this.handle(fileHandle);
                await (dataOnly ? handle.datasync() : handle.sync());
            }),

            releasedir: (_fusePath, fileHandle, callback) => this.status(callback, async () => {
                await this.closeHandle(fileHandle);
            }),

            open: (fusePath, flags, callback) => this.value(callback, async () => {
                const accessModeMask = constants.O_WRONLY | constants.O_RDWR;
                const accessType = (flags & accessModeMask) === constants.O_RDONLY
                    ? FuseAccessType.READ
                    : FuseAccessType.WRITE;
                await this.authorize(FuseOperation.OPEN, [{access: accessType, path: fusePath}]);
                const handle = await Promises.open(await this.existingPath(fusePath), flags);
                this.handles.set(handle.fd, handle);
                return handle.fd;
            }),

            create: (fusePath, mode, callback) => this.value(callback, async () => {
                await this.authorize(FuseOperation.CREATE, [{access: FuseAccessType.WRITE, path: fusePath}]);
                const handle = await Promises.open(
                    await this.destinationPath(fusePath),
                    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
                    mode,
                );
                this.handles.set(handle.fd, handle);
                return handle.fd;
            }),

            utimens: (fusePath, atimeMilliseconds, mtimeMilliseconds, callback) => this.status(
                callback,
                async () => {
                    await this.authorize(FuseOperation.UTIMENS, [{access: FuseAccessType.WRITE, path: fusePath}]);
                    await Promises.lutimes(
                        await this.nodePath(fusePath),
                        new Date(atimeMilliseconds),
                        new Date(mtimeMilliseconds),
                    );
                },
            ),

            chmod: (fusePath, mode, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.CHMOD, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await Promises.chmod(await this.existingPath(fusePath), mode);
            }),

            chown: (fusePath, uid, gid, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.CHOWN, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await Promises.lchown(
                    await this.nodePath(fusePath),
                    normalizeOwnerId(uid),
                    normalizeOwnerId(gid),
                );
            }),

            getxattr: (fusePath, name, position, callback) => this.value(callback, async () => {
                await this.authorize(FuseOperation.GETXATTR, [{access: FuseAccessType.READ, path: fusePath}]);
                const value = await getAttribute(await this.existingPath(fusePath), name);
                return position === 0 ? value : value.subarray(position);
            }),

            listxattr: (fusePath, callback) => this.value(callback, async () => {
                await this.authorize(FuseOperation.LISTXATTR, [{access: FuseAccessType.READ, path: fusePath}]);
                return listAttributes(await this.existingPath(fusePath));
            }),

            setxattr: (fusePath, name, value, position, flags, callback) => this.status(callback, async () => {
                if (position !== 0 || flags !== 0) throw new FuseInvalidArgumentError();
                await this.authorize(FuseOperation.SETXATTR, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await setAttribute(await this.existingPath(fusePath), name, value);
            }),

            removexattr: (fusePath, name, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.REMOVEXATTR, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await removeAttribute(await this.existingPath(fusePath), name);
            }),

            mknod: (fusePath, mode, device, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.MKNOD, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await mknod(await this.destinationPath(fusePath), mode, device);
            }),

            read: (fusePath, fileHandle, buffer, length, position, callback) => this.io(callback, async () => {
                await this.authorize(FuseOperation.READ, [{access: FuseAccessType.READ, path: fusePath}]);
                const result = await this.handle(fileHandle).read(buffer, 0, length, position);
                return result.bytesRead;
            }),

            write: (fusePath, fileHandle, buffer, length, position, callback) => this.io(callback, async () => {
                await this.authorize(FuseOperation.WRITE, [{access: FuseAccessType.WRITE, path: fusePath}]);
                const result = await this.handle(fileHandle).write(buffer, 0, length, position);
                return result.bytesWritten;
            }),

            truncate: (fusePath, size, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.TRUNCATE, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await Promises.truncate(await this.existingPath(fusePath), size);
            }),

            ftruncate: (fusePath, fileHandle, size, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.TRUNCATE, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await this.handle(fileHandle).truncate(size);
            }),

            flush: (_fusePath, _fileHandle, callback) => callback(0),

            fsync: (_fusePath, dataOnly, fileHandle, callback) => this.status(callback, async () => {
                const handle = this.handle(fileHandle);
                await (dataOnly ? handle.datasync() : handle.sync());
            }),

            release: (_fusePath, fileHandle, callback) => this.status(callback, async () => {
                await this.closeHandle(fileHandle);
            }),

            mkdir: (fusePath, mode, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.MKDIR, [{access: FuseAccessType.WRITE, path: fusePath}]);
                await Promises.mkdir(await this.destinationPath(fusePath), {mode});
            }),

            rmdir: (fusePath, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.RMDIR, [{access: FuseAccessType.DELETE, path: fusePath}]);
                await Promises.rmdir(await this.mutableNodePath(fusePath));
            }),

            unlink: (fusePath, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.UNLINK, [{access: FuseAccessType.DELETE, path: fusePath}]);
                await Promises.unlink(await this.mutableNodePath(fusePath));
            }),

            rename: (source, destination, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.RENAME, [
                    {access: FuseAccessType.DELETE, path: source},
                    {access: FuseAccessType.WRITE, path: destination},
                ]);
                await Promises.rename(await this.mutableNodePath(source), await this.destinationPath(destination));
            }),

            link: (source, destination, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.LINK, [
                    {access: FuseAccessType.READ, path: source},
                    {access: FuseAccessType.WRITE, path: destination},
                ]);
                await Promises.link(await this.nodePath(source), await this.destinationPath(destination));
            }),

            readlink: (fusePath, callback) => this.value(callback, async () => (
                Promises.readlink(await this.nodePath(fusePath))
            )),

            symlink: (target, fusePath, callback) => this.status(callback, async () => {
                await this.authorize(FuseOperation.SYMLINK, [{access: FuseAccessType.WRITE, path: fusePath}]);
                const destination = await this.destinationPath(fusePath);
                this.validateSymlinkTarget(target, destination);
                await Promises.symlink(target, destination);
            }),
        } satisfies FuseOperations;
    }

    private async authorize(operation: FuseOperation, pathAccesses: FusePathAccess[]): Promise<void> {
        const event: FusePolicyEvent = {
            sequence: ++this.sequence,
            operation,
            pathAccesses: pathAccesses.map((access) => ({...access, path: this.normalizeFusePath(access.path)})),
        };

        let resolveDecision: (decision: FuseDecision) => void;
        const decision = new Promise<FuseDecision>((resolve) => {
            resolveDecision = resolve;
        });
        this.decisionQueue = this.decisionQueue.then(async () => {
            let result = FuseDecision.DENY;
            try {
                const requested = await this.decide(event);
                if (requested !== FuseDecision.ALLOW && requested !== FuseDecision.DENY) {
                    // noinspection ExceptionCaughtLocallyJS
                    throw new Error(`invalid FUSE decision: ${String(requested)}`);
                }
                result = requested;
            } catch (error) {
                try {
                    this.onDecisionError?.(error);
                } catch {
                    // Error reporting must not strand a kernel request.
                }
            } finally {
                resolveDecision(result);
            }
        });

        if (await decision !== FuseDecision.ALLOW) throw new FusePolicyError();
    }

    private normalizeFusePath(fusePath: string): string {
        const normalized = this.validatedFusePath(fusePath);
        if (this.isHiddenFusePath(normalized)) throw new FuseHiddenPathError();
        return normalized;
    }

    private validatedFusePath(fusePath: string): string {
        if (!fusePath.startsWith("/") || fusePath.includes("\0")) throw new FusePathError("invalid FUSE path");
        if (fusePath === "/") return fusePath;
        const segments = fusePath.slice(1).split("/");
        if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
            throw new FusePathError("FUSE path escapes the governed filesystem");
        }
        return `/${segments.join("/")}`;
    }

    private isHiddenFusePath(fusePath: string): boolean {
        return this.hiddenFusePaths.some((hiddenPath) => (
            fusePath === hiddenPath || fusePath.startsWith(`${hiddenPath}/`)
        ));
    }

    private childFusePath(parent: string, name: string): string {
        const normalizedParent = this.validatedFusePath(parent);
        return normalizedParent === "/" ? `/${name}` : `${normalizedParent}/${name}`;
    }

    private lexicalPath(fusePath: string): string {
        const normalized = this.normalizeFusePath(fusePath);
        const candidate = path.join(this.backingRoot, normalized.slice(1));
        this.assertContained(candidate);
        return candidate;
    }

    private async existingPath(fusePath: string): Promise<string> {
        const resolved = await Promises.realpath(this.lexicalPath(fusePath));
        this.assertContained(resolved);
        return resolved;
    }

    private async nodePath(fusePath: string): Promise<string> {
        const lexical = this.lexicalPath(fusePath);
        if (lexical === this.backingRoot) return lexical;
        const parent = await Promises.realpath(path.dirname(lexical));
        this.assertContained(parent);
        const candidate = path.join(parent, path.basename(lexical));
        await Promises.lstat(candidate);
        return candidate;
    }

    private async mutableNodePath(fusePath: string): Promise<string> {
        const candidate = await this.nodePath(fusePath);
        if (candidate === this.backingRoot) throw new FusePathError("cannot mutate the filesystem root");
        return candidate;
    }

    private async destinationPath(fusePath: string): Promise<string> {
        const lexical = this.lexicalPath(fusePath);
        if (lexical === this.backingRoot) throw new FusePathError("cannot replace the filesystem root");
        const parent = await Promises.realpath(path.dirname(lexical));
        this.assertContained(parent);
        return path.join(parent, path.basename(lexical));
    }

    private validateSymlinkTarget(target: string, destination: string): void {
        if (target.includes("\0") || path.isAbsolute(target)) {
            throw new FusePathError("absolute or malformed symlink target is not allowed");
        }
        this.assertContained(path.resolve(path.dirname(destination), target));
    }

    private assertContained(candidate: string): void {
        const relative = path.relative(this.backingRoot, candidate);
        const isContained = relative === ""
            || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
        if (!isContained) throw new FusePathError("path escapes the backing filesystem");

        const fusePath = relative === ""
            ? "/"
            : `/${relative.split(path.sep).join("/")}`;
        if (this.isHiddenFusePath(fusePath)) throw new FuseHiddenPathError();
    }

    private handle(fileHandle: number): FileHandle {
        const handle = this.handles.get(fileHandle);
        if (!handle) throw new FuseHandleError();
        return handle;
    }

    private async closeHandle(fileHandle: number): Promise<void> {
        const handle = this.handle(fileHandle);
        this.handles.delete(fileHandle);
        await handle.close();
    }

    private status(callback: (status: number) => void, action: () => Promise<void>): void {
        void action().then(() => callback(0), (error: unknown) => callback(FuseError.toFuseErrno(error)));
    }

    private value<T>(
        callback: (status: number, value?: T) => void,
        action: () => Promise<T>,
    ): void {
        void action().then((value) => callback(0, value), (error: unknown) => callback(FuseError.toFuseErrno(error)));
    }

    private io(callback: (result: number) => void, action: () => Promise<number>): void {
        void action().then(callback, (error: unknown) => callback(FuseError.toFuseErrno(error)));
    }
}

function toFuseStatfs(statfs: StatsFs): FuseStatfs {
    return {
        bsize: statfs.bsize,
        frsize: statfs.frsize,
        blocks: statfs.blocks,
        bfree: statfs.bfree,
        bavail: statfs.bavail,
        files: statfs.files,
        ffree: statfs.ffree,
        favail: statfs.ffree,
        fsid: 0,
        flag: 0,
        namemax: 255,
    };
}

function normalizeOwnerId(id: number): number {
    return id === FUSE_UNCHANGED_OWNER_ID ? -1 : id;
}
