//! System-header-derived high-level libfuse ABI. No policy or backing-I/O logic
//! belongs here: callbacks marshal into the existing Rust dispatcher.
use super::bindings as ffi;
use super::callbacks::{pilot_fuse_call, Call, Operation};
use super::{catch_callback, pilot_fuse_ready, pilot_fuse_statistics, State};
use libc::{c_char, c_int, c_void, dev_t, gid_t, mode_t, off_t, uid_t};
use std::mem::size_of;
use std::panic::{catch_unwind, AssertUnwindSafe};

unsafe fn filesystem_state() -> *mut State {
    ffi::fuse_get_context()
        .as_ref()
        .map_or(std::ptr::null_mut(), |context| context.private_data.cast())
}

unsafe fn invoke(operation: Operation, mut call: Call, info: *mut ffi::fuse_file_info) -> c_int {
    let state = filesystem_state();
    let Some(borrowed) = state.as_ref() else {
        return -libc::EACCES;
    };
    // Contain the file-info round trip as well as dispatch. In particular,
    // cleanup must still reach the dispatcher after the mount's poison latch is set.
    catch_callback(borrowed, || {
        if let Some(info) = info.as_ref() {
            call.has_info = 1;
            call.fh = info.fh;
            call.direct_io = info.direct_io() as c_int;
            call.keep_cache = info.keep_cache() as c_int;
        }
        let result = pilot_fuse_call(state, operation as u32, &mut call);
        if let Some(info) = info.as_mut() {
            info.fh = call.fh;
            info.set_direct_io(u32::from(call.direct_io != 0));
            info.set_keep_cache(u32::from(call.keep_cache != 0));
        }
        Ok(result)
    })
}

/// The production INIT callback, also exercised by independent C-header probes.
///
/// # Safety
/// Both arguments must be live, exclusively writable libfuse-owned structures.
/// The current libfuse context must contain a live Rust-created mount state.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_init(
    connection: *mut ffi::fuse_conn_info,
    configuration: *mut ffi::fuse_config,
) -> *mut c_void {
    let state = filesystem_state();
    let Some(borrowed) = state.as_ref() else {
        return std::ptr::null_mut();
    };
    catch_callback(borrowed, || {
        for capability in [
            ffi::FUSE_CAP_DIRECT_IO_ALLOW_MMAP,
            ffi::FUSE_CAP_WRITEBACK_CACHE,
            ffi::FUSE_CAP_PASSTHROUGH,
            ffi::FUSE_CAP_ASYNC_DIO,
            ffi::FUSE_CAP_ATOMIC_O_TRUNC,
            ffi::FUSE_CAP_NO_OPEN_SUPPORT,
            ffi::FUSE_CAP_NO_OPENDIR_SUPPORT,
        ] {
            // Use the public helper: changing want fields alone would bypass
            // libfuse's enclosing-session capability bookkeeping.
            ffi::fuse_unset_feature_flag(connection, capability as u64);
        }
        let configuration = &mut *configuration;
        configuration.parallel_direct_writes = 0;
        configuration.nullpath_ok = 0;
        configuration.direct_io = 0;
        configuration.kernel_cache = 0;
        configuration.auto_cache = 0;
        let _ = pilot_fuse_ready(state);
        Ok(0)
    });
    state.cast()
}

unsafe extern "C" fn destroy(state: *mut c_void) {
    pilot_fuse_statistics(state.cast());
}

unsafe extern "C" fn access(path: *const c_char, mode: c_int) -> c_int {
    invoke(
        Operation::Access,
        Call {
            path,
            flags: mode,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn getattr(
    path: *const c_char,
    attributes: *mut libc::stat,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Getattr,
        Call {
            path,
            buffer: attributes.cast(),
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn readlink(path: *const c_char, buffer: *mut c_char, size: usize) -> c_int {
    invoke(
        Operation::Readlink,
        Call {
            path,
            buffer: buffer.cast(),
            size,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn statfs(path: *const c_char, statistics: *mut libc::statvfs) -> c_int {
    invoke(
        Operation::Statfs,
        Call {
            path,
            buffer: statistics.cast(),
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn opendir(path: *const c_char, info: *mut ffi::fuse_file_info) -> c_int {
    invoke(
        Operation::Opendir,
        Call {
            path,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn readdir(
    path: *const c_char,
    buffer: *mut c_void,
    filler: ffi::fuse_fill_dir_t,
    offset: off_t,
    info: *mut ffi::fuse_file_info,
    flags: ffi::fuse_readdir_flags,
) -> c_int {
    invoke(
        Operation::Readdir,
        Call {
            path,
            buffer,
            filler,
            offset,
            flags: flags as c_int,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn fsyncdir(
    path: *const c_char,
    data_only: c_int,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Fsyncdir,
        Call {
            path,
            flags: data_only,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn releasedir(path: *const c_char, info: *mut ffi::fuse_file_info) -> c_int {
    invoke(
        Operation::Releasedir,
        Call {
            path,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn open(path: *const c_char, info: *mut ffi::fuse_file_info) -> c_int {
    let Some(flags) = info.as_ref().map(|info| info.flags) else {
        return -libc::EINVAL;
    };
    invoke(
        Operation::Open,
        Call {
            path,
            flags,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn create(
    path: *const c_char,
    mode: mode_t,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    let Some(flags) = info.as_ref().map(|info| info.flags) else {
        return -libc::EINVAL;
    };
    invoke(
        Operation::Create,
        Call {
            path,
            mode,
            flags,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn utimens(
    path: *const c_char,
    times: *const libc::timespec,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Utimens,
        Call {
            path,
            buffer: times.cast_mut().cast(),
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn chmod(
    path: *const c_char,
    mode: mode_t,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Chmod,
        Call {
            path,
            mode,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn chown(
    path: *const c_char,
    uid: uid_t,
    gid: gid_t,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Chown,
        Call {
            path,
            uid,
            gid,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn getxattr(
    path: *const c_char,
    name: *const c_char,
    value: *mut c_char,
    size: usize,
) -> c_int {
    invoke(
        Operation::Getxattr,
        Call {
            path,
            second: name,
            buffer: value.cast(),
            size,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn listxattr(path: *const c_char, list: *mut c_char, size: usize) -> c_int {
    invoke(
        Operation::Listxattr,
        Call {
            path,
            buffer: list.cast(),
            size,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn setxattr(
    path: *const c_char,
    name: *const c_char,
    value: *const c_char,
    size: usize,
    flags: c_int,
) -> c_int {
    invoke(
        Operation::Setxattr,
        Call {
            path,
            second: name,
            buffer: value.cast_mut().cast(),
            size,
            flags,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn removexattr(path: *const c_char, name: *const c_char) -> c_int {
    invoke(
        Operation::Removexattr,
        Call {
            path,
            second: name,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn mknod(path: *const c_char, mode: mode_t, device: dev_t) -> c_int {
    invoke(
        Operation::Mknod,
        Call {
            path,
            mode,
            device,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn read(
    path: *const c_char,
    buffer: *mut c_char,
    size: usize,
    offset: off_t,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Read,
        Call {
            path,
            buffer: buffer.cast(),
            size,
            offset,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn write(
    path: *const c_char,
    buffer: *const c_char,
    size: usize,
    offset: off_t,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Write,
        Call {
            path,
            buffer: buffer.cast_mut().cast(),
            size,
            offset,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn truncate(
    path: *const c_char,
    size: off_t,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Truncate,
        Call {
            path,
            offset: size,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn flush(path: *const c_char, info: *mut ffi::fuse_file_info) -> c_int {
    invoke(
        Operation::Flush,
        Call {
            path,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn fsync(
    path: *const c_char,
    data_only: c_int,
    info: *mut ffi::fuse_file_info,
) -> c_int {
    invoke(
        Operation::Fsync,
        Call {
            path,
            flags: data_only,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn release(path: *const c_char, info: *mut ffi::fuse_file_info) -> c_int {
    invoke(
        Operation::Release,
        Call {
            path,
            ..Call::default()
        },
        info,
    )
}
unsafe extern "C" fn mkdir(path: *const c_char, mode: mode_t) -> c_int {
    invoke(
        Operation::Mkdir,
        Call {
            path,
            mode,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn rmdir(path: *const c_char) -> c_int {
    invoke(
        Operation::Rmdir,
        Call {
            path,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn unlink(path: *const c_char) -> c_int {
    invoke(
        Operation::Unlink,
        Call {
            path,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn rename(
    source: *const c_char,
    destination: *const c_char,
    flags: u32,
) -> c_int {
    invoke(
        Operation::Rename,
        Call {
            path: source,
            second: destination,
            flags: flags as c_int,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn link(source: *const c_char, destination: *const c_char) -> c_int {
    invoke(
        Operation::Link,
        Call {
            path: source,
            second: destination,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}
unsafe extern "C" fn symlink(target: *const c_char, path: *const c_char) -> c_int {
    invoke(
        Operation::Symlink,
        Call {
            path,
            second: target,
            ..Call::default()
        },
        std::ptr::null_mut(),
    )
}

fn operations() -> ffi::fuse_operations {
    // Every field is a C scalar or nullable function pointer; this is the same
    // zero-initialized high-level operation table as the previous C adapter.
    unsafe {
        ffi::fuse_operations {
            init: Some(pilot_fuse_init),
            destroy: Some(destroy),
            access: Some(access),
            getattr: Some(getattr),
            readlink: Some(readlink),
            statfs: Some(statfs),
            opendir: Some(opendir),
            readdir: Some(readdir),
            fsyncdir: Some(fsyncdir),
            releasedir: Some(releasedir),
            open: Some(open),
            create: Some(create),
            utimens: Some(utimens),
            chmod: Some(chmod),
            chown: Some(chown),
            getxattr: Some(getxattr),
            listxattr: Some(listxattr),
            setxattr: Some(setxattr),
            removexattr: Some(removexattr),
            mknod: Some(mknod),
            read: Some(read),
            write: Some(write),
            truncate: Some(truncate),
            flush: Some(flush),
            fsync: Some(fsync),
            release: Some(release),
            mkdir: Some(mkdir),
            rmdir: Some(rmdir),
            unlink: Some(unlink),
            rename: Some(rename),
            link: Some(link),
            symlink: Some(symlink),
            ..std::mem::zeroed()
        }
    }
}

/// Copy the production callback table into an independent C-header ABI probe.
///
/// # Safety
/// For the exact expected `size`, `output` must be aligned, exclusively writable
/// storage for a system-header `fuse_operations` structure from this SDK.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_operations(
    output: *mut ffi::fuse_operations,
    size: usize,
) -> c_int {
    if output.is_null() || size != size_of::<ffi::fuse_operations>() {
        return -libc::EINVAL;
    }
    catch_unwind(AssertUnwindSafe(|| {
        output.write(operations());
        0
    }))
    .unwrap_or(-libc::EACCES)
}

/// Run system libfuse with the production callback table and this SDK's version.
///
/// # Safety
/// `argc` must be at least one. `argv` must point to a writable array of
/// `argc + 1` pointers, with readable NUL-terminated strings in the first
/// `argc` entries and a null final entry. Keep these valid until return.
/// Non-null `state` must remain a live Rust-created mount state until return.
/// Null is valid only for invocations that exit before mounting or running
/// filesystem callbacks, such as help/version or rejected options.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_main(
    argc: c_int,
    argv: *mut *mut c_char,
    state: *mut c_void,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        let operations = operations();
        // Header-defined reserved fields remain zero without assuming their names
        // or count. This reproduces the installed fuse_main macro's version data.
        let mut version = ffi::libfuse_version {
            major: ffi::FUSE_MAJOR_VERSION as _,
            minor: ffi::FUSE_MINOR_VERSION as _,
            hotfix: ffi::FUSE_HOTFIX_VERSION as _,
            ..Default::default()
        };
        ffi::fuse_main_real_versioned(
            argc,
            argv,
            &operations,
            size_of::<ffi::fuse_operations>(),
            &mut version,
            state,
        )
    }))
    .unwrap_or(1)
}
