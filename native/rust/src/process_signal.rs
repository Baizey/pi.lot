//! Preserve the caller's SIGPIPE behavior across Rust runtime initialization.
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};

// Rust changes SIGPIPE to SIG_IGN before main. C's exec/protocol-check helpers
// did not, and ignored dispositions survive exec. Capture it before Rust starts.
// At an exec boundary the inherited handler can only be SIG_DFL or SIG_IGN.
static INHERITED_SIGPIPE: AtomicUsize = AtomicUsize::new(libc::SIG_DFL);
static CLOSED_STDIO: AtomicU8 = AtomicU8::new(0);
#[used]
#[link_section = ".init_array"]
static SAVE_SIGPIPE: extern "C" fn() = save_sigpipe;

extern "C" fn save_sigpipe() {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    if unsafe { libc::sigaction(libc::SIGPIPE, std::ptr::null(), &mut action) } == 0 {
        INHERITED_SIGPIPE.store(action.sa_sigaction, Ordering::Relaxed);
    }
    let mut closed = 0;
    for fd in 0..=2 {
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0
            && unsafe { *libc::__errno_location() } == libc::EBADF
        {
            closed |= 1 << fd;
        }
    }
    CLOSED_STDIO.store(closed, Ordering::Relaxed);
}

// Rust reopens initially closed standard descriptors to /dev/null. The native
// C helpers did not: descriptor validation and exec inheritance must still see
// EBADF/closed descriptors. Invoke before any helper opens new resources.
pub(crate) fn restore_closed_stdio() {
    let closed = CLOSED_STDIO.load(Ordering::Relaxed);
    for fd in 0..=2 {
        if closed & (1 << fd) != 0 {
            unsafe {
                libc::close(fd);
            }
        }
    }
}

pub(crate) fn restore_sigpipe() {
    unsafe {
        libc::signal(libc::SIGPIPE, INHERITED_SIGPIPE.load(Ordering::Relaxed));
    }
}
