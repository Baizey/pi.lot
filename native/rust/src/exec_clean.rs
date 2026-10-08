//! Descriptor cleanup followed by execvp. Arguments and the inherited environment stay byte-exact.
use std::ffi::CString;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;

pub fn main() -> i32 {
    crate::process_signal::restore_closed_stdio();
    // Also preserve SIGPIPE on diagnostic writes before a successful exec.
    crate::process_signal::restore_sigpipe();
    let arguments: Vec<CString> = std::env::args_os()
        .map(|argument| CString::new(argument.as_bytes()).expect("argv cannot contain NUL"))
        .collect();
    if arguments.len() < 3 {
        let _ = writeln!(
            io::stderr().lock(),
            "usage: pi-exec-clean-native MAX_PRESERVED_FD COMMAND [ARG...]"
        );
        return 64;
    }
    let value = &arguments[1];
    let mut end = std::ptr::null_mut();
    // strtoul intentionally retains the C helper's signs, whitespace, and overflow rules.
    let parsed = unsafe {
        *libc::__errno_location() = 0;
        libc::strtoul(value.as_ptr(), &mut end, 10)
    };
    if errno() != 0
        || end == value.as_ptr().cast_mut()
        || unsafe { *end } != 0
        || parsed >= libc::c_uint::MAX as libc::c_ulong
    {
        let mut stderr = io::stderr().lock();
        let _ = stderr.write_all(b"invalid maximum preserved descriptor: ");
        let _ = stderr.write_all(value.as_bytes());
        let _ = stderr.write_all(b"\n");
        return 64;
    }
    if let Err(()) = close_descriptors_after(parsed as libc::c_uint) {
        return 126;
    }
    let mut command: Vec<*const libc::c_char> =
        arguments[2..].iter().map(|arg| arg.as_ptr()).collect();
    command.push(std::ptr::null());
    unsafe {
        libc::execvp(arguments[2].as_ptr(), command.as_ptr());
    }
    report_error(b"execvp\0");
    127
}

fn close_descriptors_after(maximum_preserved: libc::c_uint) -> Result<(), ()> {
    let first = maximum_preserved + 1;
    if unsafe { libc::syscall(libc::SYS_close_range, first, libc::c_uint::MAX, 0u32) } == 0 {
        return Ok(());
    }
    if errno() != libc::ENOSYS && errno() != libc::EINVAL {
        report_error(b"close_range\0");
        return Err(());
    }
    // RLIMIT_NOFILE (and _SC_OPEN_MAX) may have been lowered below descriptors
    // already open. Enumerate actual descriptors instead of trusting that limit.
    // Finish and drop the directory before closing the snapshot, so its owned
    // descriptor is never closed out from underneath the iterator.
    let directory = match std::fs::read_dir("/proc/self/fd") {
        Ok(directory) => directory,
        Err(error) => {
            report_io_error(b"opendir /proc/self/fd\0", &error);
            return Err(());
        }
    };
    let mut descriptors = Vec::new();
    for entry in directory {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report_io_error(b"readdir /proc/self/fd\0", &error);
                return Err(());
            }
        };
        // procfs descriptor entry names are decimal integers; read_dir omits '.' and '..'.
        if let Some(fd) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<libc::c_int>().ok())
        {
            if fd as libc::c_uint >= first {
                descriptors.push(fd);
            }
        }
    }
    for descriptor in descriptors {
        // The snapshot also includes the now-closed enumeration descriptor. EBADF
        // for that entry is harmless, as in the original best-effort close loop.
        unsafe {
            libc::close(descriptor);
        }
    }
    Ok(())
}

fn errno() -> libc::c_int {
    unsafe { *libc::__errno_location() }
}

fn report_io_error(label: &[u8], error: &io::Error) {
    unsafe {
        *libc::__errno_location() = error.raw_os_error().unwrap_or(libc::EIO);
    }
    report_error(label);
}

fn report_error(label: &[u8]) {
    unsafe {
        libc::perror(label.as_ptr().cast());
    }
}
