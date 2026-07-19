declare module "fuse-native" {
  import type {Stats} from "node:fs";

  type StatusCallback = (status: number) => void;

  export type FuseStatfs = {
    bsize: number;
    frsize: number;
    blocks: number;
    bfree: number;
    bavail: number;
    files: number;
    ffree: number;
    favail: number;
    fsid: number;
    flag: number;
    namemax: number;
  };

  export type FuseOperations = {
    init: (callback: StatusCallback) => void;
    error: (callback: StatusCallback) => void;
    access: (path: string, mode: number, callback: StatusCallback) => void;
    statfs: (path: string, callback: (status: number, statfs?: FuseStatfs) => void) => void;
    getattr: (path: string, callback: (status: number, stat?: Stats) => void) => void;
    fgetattr: (path: string, fileHandle: number, callback: (status: number, stat?: Stats) => void) => void;
    readdir: (path: string, callback: (status: number, names?: string[]) => void) => void;
    opendir: (path: string, flags: number, callback: (status: number, fileHandle?: number) => void) => void;
    fsyncdir: (path: string, dataOnly: boolean, fileHandle: number, callback: StatusCallback) => void;
    releasedir: (path: string, fileHandle: number, callback: StatusCallback) => void;
    open: (path: string, flags: number, callback: (status: number, fileHandle?: number) => void) => void;
    read: (
      path: string,
      fileHandle: number,
      buffer: Buffer,
      length: number,
      position: number,
      callback: (result: number) => void,
    ) => void;
    write: (
      path: string,
      fileHandle: number,
      buffer: Buffer,
      length: number,
      position: number,
      callback: (result: number) => void,
    ) => void;
    create: (path: string, mode: number, callback: (status: number, fileHandle?: number) => void) => void;
    utimens: (path: string, atimeMilliseconds: number, mtimeMilliseconds: number, callback: StatusCallback) => void;
    chmod: (path: string, mode: number, callback: StatusCallback) => void;
    chown: (path: string, uid: number, gid: number, callback: StatusCallback) => void;
    getxattr: (
      path: string,
      name: string,
      position: number,
      callback: (status: number, value?: Buffer) => void,
    ) => void;
    listxattr: (path: string, callback: (status: number, names?: string[]) => void) => void;
    setxattr: (
      path: string,
      name: string,
      value: Buffer,
      position: number,
      flags: number,
      callback: StatusCallback,
    ) => void;
    removexattr: (path: string, name: string, callback: StatusCallback) => void;
    mknod: (path: string, mode: number, device: number, callback: StatusCallback) => void;
    release: (path: string, fileHandle: number, callback: StatusCallback) => void;
    flush: (path: string, fileHandle: number, callback: StatusCallback) => void;
    fsync: (path: string, dataOnly: boolean, fileHandle: number, callback: StatusCallback) => void;
    truncate: (path: string, size: number, callback: StatusCallback) => void;
    ftruncate: (path: string, fileHandle: number, size: number, callback: StatusCallback) => void;
    mkdir: (path: string, mode: number, callback: StatusCallback) => void;
    rmdir: (path: string, callback: StatusCallback) => void;
    unlink: (path: string, callback: StatusCallback) => void;
    rename: (source: string, destination: string, callback: StatusCallback) => void;
    link: (source: string, destination: string, callback: StatusCallback) => void;
    readlink: (path: string, callback: (status: number, target?: string) => void) => void;
    symlink: (target: string, path: string, callback: StatusCallback) => void;
  };

  export type FuseOptions = {
    mkdir?: boolean;
    force?: boolean;
    debug?: boolean;
    autoUnmount?: boolean;
    timeout?: number | false;
    fsname?: string;
    subtype?: string;
    entryTimeout?: number;
    attrTimeout?: number;
    acAttrTimeout?: number;
    kernelCache?: boolean;
    autoCache?: boolean;
  };

  class Fuse {
    static readonly EACCES: number;
    static readonly EBADF: number;
    static readonly EINVAL: number;
    static readonly EIO: number;
    static readonly ENOENT: number;
    static readonly ENOSYS: number;
    static readonly EPERM: number;

    constructor(mountpoint: string, operations: FuseOperations, options?: FuseOptions);
    mount(callback: (error?: Error | null) => void): void;
    unmount(callback: (error?: Error | null) => void): void;
  }

  // noinspection JSUnusedGlobalSymbols
  export default Fuse;
}
