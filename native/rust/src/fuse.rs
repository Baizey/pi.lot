//! High-level libfuse filesystem. System-header-generated Rust bindings preserve
//! its ABI; snapshots, authorization, backing operations and broker ownership live here.
use std::ffi::{CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

mod abi;
mod bindings;
mod broker;
mod callbacks;
mod control;
mod path;
mod snapshot;
use control::*;
use path::*;
use snapshot::*;

const PATH_MAX: usize = 4096;
const POLICY_EVENTS: usize = 0;
const OPEN_EVENTS: usize = 1;
const READ_EVENTS: usize = 2;
const READDIR_EVENTS: usize = 3;
const BASE_CHECKS: usize = 4;
const BASE_RELOADS: usize = 5;
const ONCE_UPDATES: usize = 6;
const POLICY_MISSES: usize = 7;
fn errno() -> i32 {
    unsafe { *libc::__errno_location() }
}
fn set_errno(value: i32) {
    unsafe {
        *libc::__errno_location() = value;
    }
}
fn cstring(bytes: &[u8]) -> CString {
    CString::new(bytes).expect("validated C path")
}
fn cvt(result: i32) -> Result<i32, i32> {
    if result < 0 {
        Err(-errno())
    } else {
        Ok(result)
    }
}
fn count_result(result: isize) -> Result<i32, i32> {
    if result < 0 {
        Err(-errno())
    } else {
        Ok(result as i32)
    }
}
fn perror(message: &str) {
    unsafe {
        libc::perror(cstring(message.as_bytes()).as_ptr());
    }
}
struct Fd(i32);
impl Drop for Fd {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}
struct Stdio(*mut libc::FILE);
impl Drop for Stdio {
    fn drop(&mut self) {
        unsafe {
            libc::fclose(self.0);
        }
    }
}

pub struct State {
    hidden_path: CString,
    snapshot_path: CString,
    stats_path: CString,
    policy: Mutex<Policy>,
    request_fd: i32,
    response_fd: i32,
    framed_ready: bool,
    ready_fd: Mutex<i32>,
    counters: [AtomicU64; 8],
    panicked: std::sync::atomic::AtomicBool,
}
impl State {
    fn new(
        snapshot_path: CString,
        hidden_path: CString,
        request_fd: i32,
        response_fd: i32,
    ) -> Self {
        Self {
            hidden_path,
            snapshot_path,
            stats_path: cstring(b""),
            policy: Mutex::new(Policy::default()),
            request_fd,
            response_fd,
            framed_ready: false,
            ready_fd: Mutex::new(-1),
            counters: std::array::from_fn(|_| AtomicU64::new(0)),
            panicked: std::sync::atomic::AtomicBool::new(false),
        }
    }
    fn count(&self, index: usize) {
        self.counters[index].fetch_add(1, Ordering::Relaxed);
    }
    fn load(&self) -> Result<(), i32> {
        let (base, status) = Snapshot::load(&self.snapshot_path)?;
        let mut policy = self.policy.lock().map_err(|_| -1)?;
        policy.base = base;
        policy.status = Some(status);
        Ok(())
    }
    fn authorize(
        &self,
        path: &CStr,
        access: Access,
        counter: Option<usize>,
        retained: Option<i32>,
        directory: bool,
    ) -> Result<Option<Fd>, i32> {
        self.count(POLICY_EVENTS);
        if let Some(counter) = counter {
            self.count(counter);
        }
        let mut policy = self.policy.lock().map_err(|_| -libc::EACCES)?;
        if self.panicked.load(Ordering::Relaxed)
            || policy.failed
            || policy.refresh(self).is_err()
            || policy.drain(self).is_err()
        {
            policy.failed = true;
            return Err(-libc::EACCES);
        }
        let evaluated = self.policy_path(path)?;
        match policy.evaluate(evaluated.to_bytes(), access) {
            Some(Decision::Allow) => {}
            Some(Decision::Deny) => {
                if policy
                    .event(self, 2, 0, access, evaluated.to_bytes())
                    .is_err()
                {
                    policy.failed = true;
                }
                return Err(-libc::EACCES);
            }
            None => {
                self.count(POLICY_MISSES);
                let base = policy.base.revision;
                let once = policy.once.revision;
                policy.next_request = policy.next_request.wrapping_add(1);
                let id = policy.next_request;
                let response = policy
                    .event(self, 1, id, access, evaluated.to_bytes())
                    .and_then(|()| policy.resolution(self, id, base, once));
                let decision = match response {
                    Ok(decision) => decision,
                    Err(_) => {
                        policy.failed = true;
                        return Err(-libc::EACCES);
                    }
                };
                if self.policy_path(path).ok().as_ref() != Some(&evaluated) {
                    return Err(-libc::EACCES);
                }
                if decision != Decision::Allow
                    || policy.evaluate(evaluated.to_bytes(), access) != Some(Decision::Allow)
                {
                    return Err(-libc::EACCES);
                }
            }
        }
        unsafe {
            if let Some(fd) = retained {
                let mut retained = std::mem::zeroed();
                let mut authorized = std::mem::zeroed();
                if libc::fstat(fd, &mut retained) != 0
                    || libc::stat(evaluated.as_ptr(), &mut authorized) != 0
                    || !same_inode(&retained, &authorized)
                {
                    return Err(-libc::EACCES);
                }
            }
            if directory {
                let fd = Fd(cvt(libc::open(
                    evaluated.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                ))?);
                let link = cstring(format!("/proc/self/fd/{}", fd.0).as_bytes());
                let mut bytes = [0; PATH_MAX];
                let n = libc::readlink(link.as_ptr(), bytes.as_mut_ptr().cast(), PATH_MAX - 1);
                if n < 0 {
                    return Err(-errno());
                }
                if &bytes[..n as usize] != evaluated.to_bytes() {
                    return Err(-libc::EACCES);
                }
                return Ok(Some(fd));
            }
        }
        Ok(None)
    }
    fn authorize_path(
        &self,
        path: &CStr,
        access: Access,
        counter: Option<usize>,
    ) -> Result<(), i32> {
        self.authorize(path, access, counter, None, false)
            .map(|_| ())
    }
    fn ready(&self) -> Result<(), i32> {
        if self.framed_ready {
            let policy = self.policy.lock().map_err(|_| -libc::EACCES)?;
            let mut bytes = vec![4, 0, 0, 0, 16, 0, 0, 0];
            bytes.extend(policy.base.revision.to_le_bytes());
            bytes.extend(policy.once.revision.to_le_bytes());
            if write_control(self.request_fd, &bytes).is_err() {
                perror("write framed ready notification");
            }
        } else {
            let mut ready = self.ready_fd.lock().map_err(|_| -libc::EACCES)?;
            if *ready >= 0 {
                unsafe {
                    if libc::write(*ready, b"1".as_ptr().cast(), 1) < 0 {
                        perror("write ready notification");
                    }
                    libc::close(*ready);
                }
                *ready = -1;
            }
        }
        Ok(())
    }
    fn statistics(&self) {
        let c: Vec<u64> = self
            .counters
            .iter()
            .map(|c| c.load(Ordering::Relaxed))
            .collect();
        let text=format!("{{\"policyEvents\":{},\"open\":{},\"read\":{},\"readdir\":{},\"baseSnapshotChecks\":{},\"baseSnapshotReloads\":{},\"onceSnapshotUpdates\":{},\"policyMisses\":{}}}\n",c[0],c[1],c[2],c[3],c[4],c[5],c[6],c[7]);
        unsafe {
            let out = libc::fopen(self.stats_path.as_ptr(), c"w".as_ptr());
            if out.is_null() {
                perror("open native FUSE statistics");
                return;
            }
            libc::fwrite(text.as_ptr().cast(), 1, text.len(), out);
            if libc::fclose(out) != 0 {
                perror("close native FUSE statistics");
            }
        }
    }
}
fn same_inode(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
}

// Every exported callback catches unwind before returning through the C ABI.
// A panic poisons this mount permanently, not merely the current operation.
fn boundary(state: &State, f: impl FnOnce() -> Result<i32, i32>) -> i32 {
    if state.panicked.load(Ordering::Relaxed) {
        return -libc::EACCES;
    }
    catch_callback(state, f)
}

// Resource release and final statistics must remain possible after a panic.
// They still cannot unwind across C, and never clear the mount's poison latch.
fn catch_callback(state: &State, f: impl FnOnce() -> Result<i32, i32>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => error,
        Err(_) => {
            state.panicked.store(true, Ordering::Relaxed);
            -libc::EACCES
        }
    }
}
/// Send the mount's configured readiness notification.
///
/// # Safety
/// `state` must be null or point to a live Rust-created `State` that remains
/// allocated for this call. Its control/readiness descriptors must not have
/// been closed or reused by the caller. The notification can consume ready_fd.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_ready(state: *mut State) -> i32 {
    if state.is_null() {
        return -libc::EACCES;
    }
    let state = &*state;
    boundary(state, || state.ready().map(|_| 0))
}
/// Write the final mount statistics without taking ownership of its state.
///
/// # Safety
/// `state` must be null or point to a live Rust-created `State` that remains
/// allocated for the entire call. The caller must not concurrently free it.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_statistics(state: *mut State) {
    if !state.is_null() {
        let state = &*state;
        catch_callback(state, || {
            state.statistics();
            Ok(0)
        });
    }
}
/// Probe-only construction uses the production snapshot/control implementation.
/// A null snapshot creates an empty state for mount-free INIT negotiation.
///
/// # Safety
/// If `snapshot` is non-null, both `snapshot` and `hidden` must point to readable,
/// NUL-terminated strings valid throughout this call. The strings are copied.
/// `request` and `response` are borrowed control descriptors: the caller must
/// keep them open and not reuse their numbers until the returned state is freed.
/// For a null snapshot, `hidden` is ignored and descriptors may be invalid for
/// INIT-only probing. A non-null result transfers ownership to the caller, who
/// must eventually pass it exactly once to `pilot_fuse_probe_free` after every
/// callback using it has finished. A null result owns no resources.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_probe_new(
    snapshot: *const libc::c_char,
    hidden: *const libc::c_char,
    request: i32,
    response: i32,
) -> *mut State {
    catch_unwind(AssertUnwindSafe(|| {
        if snapshot.is_null() {
            return Box::into_raw(Box::new(State::new(
                cstring(b""),
                cstring(b""),
                request,
                response,
            )));
        }
        let snapshot = CStr::from_ptr(snapshot);
        let hidden = CStr::from_ptr(hidden);
        if snapshot.to_bytes().len() >= PATH_MAX || hidden.to_bytes().len() >= PATH_MAX {
            return std::ptr::null_mut();
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        let state = Box::new(State::new(
            snapshot.to_owned(),
            hidden.to_owned(),
            request,
            response,
        ));
        if nonblocking(request).is_err() || nonblocking(response).is_err() || state.load().is_err()
        {
            return std::ptr::null_mut();
        }
        if state.policy.lock().unwrap().initial_once(&state).is_err() {
            return std::ptr::null_mut();
        }
        Box::into_raw(state)
    }))
    .unwrap_or(std::ptr::null_mut())
}
/// Release a probe-owned state; borrowed control descriptors remain open.
///
/// # Safety
/// `state` must be null or an unfreed pointer returned by `pilot_fuse_probe_new`.
/// No callback may still be using it, and no references to it may be used after
/// this call. States owned by the production mount runner must not be passed.
#[no_mangle]
pub unsafe extern "C" fn pilot_fuse_probe_free(state: *mut State) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !state.is_null() {
            drop(Box::from_raw(state));
        }
    }));
}

pub fn main() -> i32 {
    catch_unwind(AssertUnwindSafe(broker::main)).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_panic_permanently_fails_closed() {
        let state = State::new(cstring(b""), cstring(b"/hidden"), -1, -1);
        assert_eq!(boundary(&state, || panic!("callback fault")), -libc::EACCES);
        let mut invoked = false;
        assert_eq!(
            boundary(&state, || {
                invoked = true;
                Ok(0)
            }),
            -libc::EACCES
        );
        assert!(!invoked);
    }
}
