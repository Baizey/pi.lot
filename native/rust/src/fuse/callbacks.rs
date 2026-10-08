use super::*;
use libc::{c_char, c_void};

// The ABI adapter supplies an internal argument record; policy and backing I/O
// do not depend on libfuse's struct layout or bitfield representation.
#[derive(Default)]
pub struct Call {
    pub(super) path: *const c_char,
    pub(super) second: *const c_char,
    pub(super) buffer: *mut c_void,
    pub(super) size: usize,
    pub(super) offset: libc::off_t,
    pub(super) fh: u64,
    pub(super) flags: i32,
    pub(super) mode: libc::mode_t,
    pub(super) uid: libc::uid_t,
    pub(super) gid: libc::gid_t,
    pub(super) device: libc::dev_t,
    pub(super) filler: super::bindings::fuse_fill_dir_t,
    pub(super) has_info: i32,
    pub(super) direct_io: i32,
    pub(super) keep_cache: i32,
}
#[repr(u32)]
#[derive(Clone, Copy)]
pub(super) enum Operation {
    Access = 1,
    Getattr,
    Readlink,
    Statfs,
    Opendir,
    Readdir,
    Fsyncdir,
    Releasedir,
    Open,
    Create,
    Utimens,
    Chmod,
    Chown,
    Getxattr,
    Listxattr,
    Setxattr,
    Removexattr,
    Mknod,
    Read,
    Write,
    Truncate,
    Flush,
    Fsync,
    Release,
    Mkdir,
    Rmdir,
    Unlink,
    Rename,
    Link,
    Symlink,
}
impl Operation {
    fn from_raw(op: u32) -> Option<Self> {
        Some(match op {
            1 => Self::Access,
            2 => Self::Getattr,
            3 => Self::Readlink,
            4 => Self::Statfs,
            5 => Self::Opendir,
            6 => Self::Readdir,
            7 => Self::Fsyncdir,
            8 => Self::Releasedir,
            9 => Self::Open,
            10 => Self::Create,
            11 => Self::Utimens,
            12 => Self::Chmod,
            13 => Self::Chown,
            14 => Self::Getxattr,
            15 => Self::Listxattr,
            16 => Self::Setxattr,
            17 => Self::Removexattr,
            18 => Self::Mknod,
            19 => Self::Read,
            20 => Self::Write,
            21 => Self::Truncate,
            22 => Self::Flush,
            23 => Self::Fsync,
            24 => Self::Release,
            25 => Self::Mkdir,
            26 => Self::Rmdir,
            27 => Self::Unlink,
            28 => Self::Rename,
            29 => Self::Link,
            30 => Self::Symlink,
            _ => return None,
        })
    }
}
struct Directory {
    directory: *mut libc::DIR,
    enumeration_started: bool,
}
// libfuse may dispatch a directory handle on different threads. Its mutex
// serializes every DIR operation; release is invoked only after in-flight I/O.
unsafe impl Send for Directory {}
impl Drop for Directory {
    fn drop(&mut self) {
        if !self.directory.is_null() {
            unsafe {
                libc::closedir(self.directory);
            }
        }
    }
}
struct DirectoryHandle {
    inner: Mutex<Directory>,
}

/// Dispatch a libfuse callback through the internal Rust argument record.
///
/// # Safety
/// Non-null `state` must point to a live Rust-created mount state throughout the
/// call. Non-null `call` must be an exclusively borrowed, initialized `Call`
/// marshalled by the ABI adapter. Its operation-specific strings must be readable and
/// NUL-terminated; buffer pointers must have the callback's required size,
/// alignment and read/write access. Directory handles must come from this
/// mount's opendir callback, and release must not race another handle user.
/// The filler function and its buffer must remain valid during readdir. The
/// caller must not free state or referenced storage while this call is active.
pub(super) unsafe fn pilot_fuse_call(state: *mut State, operation: u32, call: *mut Call) -> i32 {
    if state.is_null() || call.is_null() {
        return -libc::EACCES;
    }
    let state = &*state;
    let operation = Operation::from_raw(operation);
    let invoke = || match operation {
        Some(op) => dispatch(state, op, &mut *call),
        None => Err(-libc::ENOSYS),
    };
    if matches!(
        operation,
        Some(Operation::Release | Operation::Releasedir | Operation::Flush)
    ) {
        catch_callback(state, invoke)
    } else {
        boundary(state, invoke)
    }
}
unsafe fn dispatch(state: &State, op: Operation, c: &mut Call) -> Result<i32, i32> {
    use Operation::{
        Access as CheckAccess, Chmod, Chown, Create, Flush, Fsync, Fsyncdir, Getattr, Getxattr,
        Link, Listxattr, Mkdir, Mknod, Open, Opendir, Read, Readdir, Readlink, Release, Releasedir,
        Removexattr, Rename, Rmdir, Setxattr, Statfs, Symlink, Truncate, Unlink, Utimens, Write,
    };
    // Several handle-only callbacks deliberately accept a null pathname.
    match op {
        Flush => return Ok(0),
        Release => return cvt(libc::close(c.fh as i32)),
        Fsync => {
            return cvt(if c.flags != 0 {
                libc::fdatasync(c.fh as i32)
            } else {
                libc::fsync(c.fh as i32)
            })
        }
        Fsyncdir => {
            let handle = (c.fh as usize as *const DirectoryHandle)
                .as_ref()
                .ok_or(-libc::EBADF)?;
            let directory = handle.inner.lock().map_err(|_| -libc::EBADF)?;
            if directory.directory.is_null() {
                return Err(-libc::EBADF);
            }
            let fd = cvt(libc::dirfd(directory.directory))?;
            return cvt(if c.flags != 0 {
                libc::fdatasync(fd)
            } else {
                libc::fsync(fd)
            });
        }
        Releasedir => {
            if c.fh == 0 {
                return Err(-libc::EBADF);
            }
            let handle = Box::from_raw(c.fh as usize as *mut DirectoryHandle);
            // Recover poison only to consume and close the owned DIR. This
            // grants no further enumeration or filesystem authority.
            let mut directory = handle
                .inner
                .into_inner()
                .unwrap_or_else(|poison| poison.into_inner());
            let ptr = std::mem::replace(&mut directory.directory, std::ptr::null_mut());
            return if ptr.is_null() {
                Ok(0)
            } else {
                cvt(libc::closedir(ptr))
            };
        }
        Getattr if c.has_info != 0 => {
            if c.fh > i32::MAX as u64 {
                return Err(-libc::EBADF);
            }
            return cvt(libc::fstat(c.fh as i32, c.buffer.cast()));
        }
        Rename if c.flags != 0 => return Err(-libc::EOPNOTSUPP),
        Setxattr if c.flags & !(libc::XATTR_CREATE | libc::XATTR_REPLACE) != 0 => {
            return Err(-libc::EINVAL)
        }
        Readlink if c.size == 0 => return Err(-libc::EINVAL),
        Symlink if c.second.is_null() || *c.second == b'/' as c_char => return Err(-libc::EPERM),
        _ => {}
    }
    if c.path.is_null() {
        return Err(-libc::EPERM);
    }
    let path = CStr::from_ptr(c.path);
    match op {
        CheckAccess => {
            let p = state.existing(path)?;
            cvt(libc::access(p.as_ptr(), c.flags))
        }
        Getattr => {
            let p = state.node(path)?;
            cvt(libc::lstat(p.as_ptr(), c.buffer.cast()))
        }
        Readlink => {
            let p = state.node(path)?;
            let length = libc::readlink(p.as_ptr(), c.buffer.cast(), c.size - 1);
            if length < 0 {
                return Err(-errno());
            }
            *c.buffer.cast::<u8>().add(length as usize) = 0;
            Ok(0)
        }
        Statfs => {
            let p = state.existing(path)?;
            cvt(libc::statvfs(p.as_ptr(), c.buffer.cast()))
        }
        Opendir => {
            let p = state.existing(path)?;
            let directory = libc::opendir(p.as_ptr());
            if directory.is_null() {
                return Err(-errno());
            }
            let handle = Box::new(DirectoryHandle {
                inner: Mutex::new(Directory {
                    directory,
                    enumeration_started: false,
                }),
            });
            c.fh = Box::into_raw(handle) as usize as u64;
            Ok(0)
        }
        Readdir => read_directory(state, path, c),
        Open | Create => {
            let readonly = c.flags & libc::O_ACCMODE == libc::O_RDONLY;
            if matches!(op, Open) {
                state.authorize_path(
                    path,
                    if readonly {
                        Access::Read
                    } else {
                        Access::Write
                    },
                    Some(OPEN_EVENTS),
                )?;
                if readonly && c.flags & libc::O_TRUNC != 0 {
                    state.authorize_path(path, Access::Write, None)?;
                }
            } else {
                state.authorize_path(path, Access::Write, None)?;
                if readonly {
                    state.authorize_path(path, Access::Read, None)?;
                }
            }
            let p = if matches!(op, Open) {
                state.existing(path)?
            } else {
                state.destination(path)?
            };
            let fd = if matches!(op, Open) {
                libc::open(p.as_ptr(), c.flags)
            } else {
                libc::open(p.as_ptr(), c.flags | libc::O_CREAT | libc::O_EXCL, c.mode)
            };
            c.fh = cvt(fd)? as u64;
            c.direct_io = (!readonly) as i32;
            c.keep_cache = 0;
            Ok(0)
        }
        Utimens => {
            state.authorize_path(path, Access::Write, None)?;
            let p = state.node(path)?;
            cvt(libc::utimensat(
                libc::AT_FDCWD,
                p.as_ptr(),
                c.buffer.cast(),
                libc::AT_SYMLINK_NOFOLLOW,
            ))
        }
        Chmod => {
            state.authorize_path(path, Access::Write, None)?;
            let p = state.existing(path)?;
            cvt(libc::chmod(p.as_ptr(), c.mode))
        }
        Chown => {
            state.authorize_path(path, Access::Write, None)?;
            let p = state.node(path)?;
            cvt(libc::lchown(p.as_ptr(), c.uid, c.gid))
        }
        Getxattr | Listxattr | Setxattr | Removexattr => {
            state.authorize_path(
                path,
                if matches!(op, Getxattr | Listxattr) {
                    Access::Read
                } else {
                    Access::Write
                },
                None,
            )?;
            let p = state.existing(path)?;
            match op {
                Getxattr => count_result(libc::getxattr(p.as_ptr(), c.second, c.buffer, c.size)),
                Listxattr => count_result(libc::listxattr(p.as_ptr(), c.buffer.cast(), c.size)),
                Setxattr => cvt(libc::setxattr(
                    p.as_ptr(),
                    c.second,
                    c.buffer,
                    c.size,
                    c.flags,
                )),
                _ => cvt(libc::removexattr(p.as_ptr(), c.second)),
            }
        }
        Mknod | Mkdir => {
            state.authorize_path(path, Access::Write, None)?;
            let p = state.destination(path)?;
            cvt(if matches!(op, Mknod) {
                libc::mknod(p.as_ptr(), c.mode, c.device)
            } else {
                libc::mkdir(p.as_ptr(), c.mode)
            })
        }
        Read | Write => {
            state.authorize(
                path,
                if matches!(op, Read) {
                    Access::Read
                } else {
                    Access::Write
                },
                if matches!(op, Read) {
                    Some(READ_EVENTS)
                } else {
                    None
                },
                Some(c.fh as i32),
                false,
            )?;
            count_result(if matches!(op, Read) {
                libc::pread(c.fh as i32, c.buffer, c.size, c.offset)
            } else {
                libc::pwrite(c.fh as i32, c.buffer, c.size, c.offset)
            })
        }
        Truncate => {
            if c.has_info != 0 {
                state.authorize(path, Access::Write, None, Some(c.fh as i32), false)?;
                cvt(libc::ftruncate(c.fh as i32, c.offset))
            } else {
                state.authorize_path(path, Access::Write, None)?;
                let p = state.existing(path)?;
                cvt(libc::truncate(p.as_ptr(), c.offset))
            }
        }
        Rmdir | Unlink => {
            state.authorize_path(path, Access::Write, None)?;
            let p = state.mutable_node(path)?;
            cvt(if matches!(op, Rmdir) {
                libc::rmdir(p.as_ptr())
            } else {
                libc::unlink(p.as_ptr())
            })
        }
        Rename | Link => {
            let destination = CStr::from_ptr(c.second);
            if matches!(op, Link) {
                state.authorize_path(path, Access::Read, None)?;
            }
            state.authorize_path(path, Access::Write, None)?;
            state.authorize_path(destination, Access::Write, None)?;
            let source = if matches!(op, Link) {
                state.node(path)?
            } else {
                state.mutable_node(path)?
            };
            let destination = state.destination(destination)?;
            cvt(if matches!(op, Link) {
                libc::link(source.as_ptr(), destination.as_ptr())
            } else {
                libc::rename(source.as_ptr(), destination.as_ptr())
            })
        }
        Symlink => {
            let target = CStr::from_ptr(c.second);
            state.authorize_path(path, Access::Write, None)?;
            let destination = state.destination(path)?;
            let b = destination.to_bytes();
            let slash = b.iter().rposition(|v| *v == b'/').unwrap();
            let mut combined = b[..slash + 1].to_vec();
            combined.extend(target.to_bytes());
            if combined.len() >= PATH_MAX {
                return Err(-libc::ENAMETOOLONG);
            }
            let normalized = normalize(&combined)?;
            if same_or_child(normalized.to_bytes(), state.hidden_path.to_bytes()) {
                return Err(-libc::ENOENT);
            }
            cvt(libc::symlink(target.as_ptr(), destination.as_ptr()))
        }
        Flush | Fsync | Release | Fsyncdir | Releasedir => unreachable!(),
    }
}
unsafe fn read_directory(state: &State, path: &CStr, c: &Call) -> Result<i32, i32> {
    let handle = (c.fh as usize as *const DirectoryHandle)
        .as_ref()
        .ok_or(-libc::EBADF)?;
    let mut handle = handle.inner.lock().map_err(|_| -libc::EBADF)?;
    let fd = state
        .authorize(path, Access::Read, Some(READDIR_EVENTS), None, true)?
        .ok_or(-libc::EACCES)?;
    let retained = if handle.directory.is_null() {
        -1
    } else {
        libc::dirfd(handle.directory)
    };
    let mut retained_status = std::mem::zeroed();
    let mut authorized_status = std::mem::zeroed();
    if retained < 0 {
        return Err(-libc::EBADF);
    }
    cvt(libc::fstat(retained, &mut retained_status))?;
    cvt(libc::fstat(fd.0, &mut authorized_status))?;
    let same = same_inode(&retained_status, &authorized_status);
    if !handle.enumeration_started || (c.offset == 0 && !same) {
        let replacement = libc::fdopendir(fd.0);
        if replacement.is_null() {
            return Err(-errno());
        }
        std::mem::forget(fd);
        if libc::closedir(handle.directory) != 0 {
            let error = -errno();
            handle.directory = std::ptr::null_mut();
            libc::closedir(replacement);
            return Err(error);
        }
        handle.directory = replacement;
        handle.enumeration_started = true;
    } else {
        drop(fd);
        if !same {
            return Err(-libc::EACCES);
        }
    }
    let directory = handle.directory;
    if c.offset == 0 {
        libc::rewinddir(directory);
    } else {
        libc::seekdir(directory, c.offset);
    }
    loop {
        set_errno(0);
        let entry = libc::readdir(directory);
        if entry.is_null() {
            return if errno() != 0 { Err(-errno()) } else { Ok(0) };
        }
        let name = CStr::from_ptr((*entry).d_name.as_ptr());
        let mut child = path.to_bytes().to_vec();
        if child != b"/" {
            child.push(b'/');
        }
        child.extend(name.to_bytes());
        if child.len() >= PATH_MAX {
            return Err(-libc::ENAMETOOLONG);
        }
        if same_or_child(&child, state.hidden_path.to_bytes()) {
            continue;
        }
        let offset = libc::telldir(directory);
        if c.filler.ok_or(-libc::EINVAL)?(c.buffer, name.as_ptr(), std::ptr::null(), offset, 0) != 0
        {
            return Ok(0);
        }
    }
}

#[cfg(test)]
#[path = "callbacks_tests.rs"]
mod tests;
