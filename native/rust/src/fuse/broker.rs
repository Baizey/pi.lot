use super::*;
use std::os::unix::ffi::OsStrExt;

extern "C" {
    static mut stdin: *mut libc::FILE;
    static mut stdout: *mut libc::FILE;
    static mut stderr: *mut libc::FILE;
}
fn output(stream: *mut libc::FILE, bytes: &[u8]) {
    unsafe {
        libc::fwrite(bytes.as_ptr().cast(), 1, bytes.len(), stream);
    }
}
fn diagnostic(bytes: &[u8]) {
    unsafe {
        output(stderr, bytes);
    }
}
fn report(bytes: &[u8]) {
    unsafe {
        output(stdout, bytes);
        libc::fflush(stdout);
    }
}

pub(super) fn main() -> i32 {
    crate::process_signal::restore_closed_stdio();
    // Usage and startup diagnostics precede the modes that explicitly ignore
    // SIGPIPE. Preserve the inherited disposition for those writes too.
    crate::process_signal::restore_sigpipe();
    unsafe {
        let parent = libc::getppid();
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != parent {
            perror("configure native FUSE parent-death signal");
            return 1;
        }
    }
    let arguments: Vec<CString> = std::env::args_os().map(|s| cstring(s.as_bytes())).collect();
    if arguments
        .get(1)
        .is_some_and(|a| a.to_bytes() == b"--check-policy-protocol")
    {
        return check_protocol(&arguments);
    }
    if arguments.len() == 2 && arguments[1].to_bytes() == b"--broker" {
        return Broker::default().run(&arguments[0]);
    }
    if arguments.len() != 8 {
        diagnostic(b"usage: pi-fuse-native MOUNTPOINT HIDDEN_PATH SNAPSHOT_PATH STATS_PATH READY_FD REQUEST_FD RESPONSE_FD\n       pi-fuse-native --broker\n");
        return 64;
    }
    unsafe {
        run_filesystem(
            &arguments[0],
            &arguments[1],
            &arguments[2],
            &arguments[3],
            &arguments[4],
            libc::atoi(arguments[5].as_ptr()),
            libc::atoi(arguments[6].as_ptr()),
            libc::atoi(arguments[7].as_ptr()),
            false,
        )
    }
}
fn check_protocol(args: &[CString]) -> i32 {
    if args.len() != 6 {
        diagnostic(
            b"usage: pi-fuse-native --check-policy-protocol SNAPSHOT REQUEST_FD RESPONSE_FD PATH\n",
        );
        return 64;
    }
    let request = unsafe { libc::atoi(args[3].as_ptr()) };
    let response = unsafe { libc::atoi(args[4].as_ptr()) };
    if nonblocking(request).is_err() || (response != request && nonblocking(response).is_err()) {
        perror("configure native policy protocol descriptors");
        return 64;
    }
    if args[2].to_bytes().len() >= PATH_MAX {
        return 64;
    }
    let state = State::new(args[2].clone(), cstring(b""), request, response);
    if state.load().is_err() {
        perror("load native FUSE policy base snapshot");
        return 64;
    }
    let mut policy = state.policy.lock().unwrap();
    let mut lookup = policy.evaluate(args[5].to_bytes(), Access::Read);
    if lookup.is_none() {
        let base = policy.base.revision;
        let once = policy.once.revision;
        policy.next_request = policy.next_request.wrapping_add(1);
        let id = policy.next_request;
        lookup = match policy
            .event(&state, 1, id, Access::Read, args[5].to_bytes())
            .and_then(|()| policy.resolution(&state, id, base, once))
        {
            Ok(Decision::Allow) => policy.evaluate(args[5].to_bytes(), Access::Read),
            _ => Some(Decision::Deny),
        };
    }
    let allowed = lookup == Some(Decision::Allow);
    report(
        format!(
            "{{\"baseRevision\":{},\"onceRevision\":{},\"decision\":\"{}\"}}\n",
            policy.base.revision,
            policy.once.revision,
            if allowed { "allow" } else { "deny" }
        )
        .as_bytes(),
    );
    if allowed {
        0
    } else {
        2
    }
}
#[allow(clippy::too_many_arguments)]
fn run_filesystem(
    program: &CStr,
    mountpoint: &CStr,
    hidden: &CStr,
    snapshot: &CStr,
    stats: &CStr,
    ready: i32,
    request: i32,
    response: i32,
    framed: bool,
) -> i32 {
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    if nonblocking(request).is_err() || (response != request && nonblocking(response).is_err()) {
        perror("configure native policy control descriptors");
        return 64;
    }
    let hidden = match realpath(hidden) {
        Ok(hidden) => hidden,
        Err(_) => {
            perror("resolve hidden path");
            return 64;
        }
    };
    if snapshot.to_bytes().len() >= PATH_MAX {
        diagnostic(b"policy snapshot path is too long\n");
        return 64;
    }
    let mut state = Box::new(State::new(snapshot.to_owned(), hidden, request, response));
    state.framed_ready = framed;
    *state.ready_fd.get_mut().unwrap() = ready;
    if state.load().is_err() {
        perror("load native FUSE policy base snapshot");
        return 64;
    }
    {
        let mut policy = state.policy.lock().unwrap();
        if policy.initial_once(&state).is_err() || policy.refresh(&state).is_err() {
            perror("synchronize native FUSE policy snapshots");
            return 64;
        }
    }
    if stats.to_bytes().len() >= PATH_MAX {
        diagnostic(b"statistics path is too long\n");
        return 64;
    }
    state.stats_path = stats.to_owned();
    let args=[program.to_owned(),cstring(b"-f"),cstring(b"-o"),cstring(b"fsname=pilot-fuse-native,subtype=pilot-fuse-native,auto_unmount,entry_timeout=0.001,attr_timeout=0.001,ac_attr_timeout=0.001"),mountpoint.to_owned()];
    let mut pointers: Vec<*mut libc::c_char> = args.iter().map(|a| a.as_ptr() as *mut _).collect();
    pointers.push(std::ptr::null_mut());
    unsafe { abi::pilot_fuse_main(5, pointers.as_mut_ptr(), (&mut *state as *mut State).cast()) }
}
fn connect_controller(socket_path: &CStr, token: &CStr) -> Result<Fd, i32> {
    unsafe {
        let mut address: libc::sockaddr_un = std::mem::zeroed();
        if socket_path.to_bytes().len() >= address.sun_path.len() {
            set_errno(libc::ENAMETOOLONG);
            return Err(-1);
        }
        let descriptor = Fd(cvt(libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
        ))?);
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        std::ptr::copy_nonoverlapping(
            socket_path.as_ptr(),
            address.sun_path.as_mut_ptr(),
            socket_path.to_bytes_with_nul().len(),
        );
        if libc::connect(
            descriptor.0,
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        ) != 0
        {
            return Err(-1);
        }
        if token.to_bytes().is_empty()
            || token.to_bytes().len() > 128
            || write_exact(descriptor.0, token.to_bytes()).is_err()
            || write_exact(descriptor.0, b"\n").is_err()
        {
            drop(descriptor);
            set_errno(libc::EPROTO);
            return Err(-1);
        }
        let mut acknowledgement = [0];
        if read_exact(descriptor.0, &mut acknowledgement).is_err() || acknowledgement[0] != 1 {
            drop(descriptor);
            set_errno(libc::EPROTO);
            return Err(-1);
        }
        Ok(descriptor)
    }
}
struct Worker {
    token: Vec<u8>,
    pid: libc::pid_t,
}
#[derive(Default)]
struct Broker {
    workers: Vec<Worker>,
    cleanup_attempted: bool,
}
impl Broker {
    fn run(&mut self, program: &CStr) -> i32 {
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        let mut line = std::ptr::null_mut();
        let mut capacity = 0;
        unsafe {
            while libc::getline(&mut line, &mut capacity, stdin) >= 0 {
                // C getline accepts NUL bytes, but all subsequent original
                // command parsing uses C-string length and ignores the suffix.
                let bytes = CStr::from_ptr(line).to_bytes();
                if bytes == b"SHUTDOWN\n" || bytes == b"SHUTDOWN\r\n" {
                    break;
                }
                if bytes.starts_with(b"STOP\t") {
                    let tail = &bytes[5..];
                    let end = tail
                        .iter()
                        .position(|b| *b == b'\r' || *b == b'\n')
                        .unwrap_or(tail.len());
                    let token = &tail[..end];
                    if token.is_empty()
                        || token.len() > 128
                        || token.contains(&b'\t')
                        || self.stop(token, true).is_err()
                    {
                        perror("stop native FUSE broker mount");
                    }
                    continue;
                }
                if bytes.len() > PATH_MAX * 5 || self.spawn(bytes, program).is_err() {
                    perror("start native FUSE broker mount");
                }
            }
            let result = if libc::ferror(stdin) != 0 { 1 } else { 0 };
            self.stop_all();
            libc::free(line.cast());
            result
        }
    }
    fn stop(&mut self, token: &[u8], report_stopped: bool) -> Result<(), i32> {
        if let Some(index) = self.workers.iter().position(|w| w.token == token) {
            let pid = self.workers[index].pid;
            let mut stopped = wait_worker(pid, 0)?;
            unsafe {
                if !stopped {
                    if libc::kill(pid, libc::SIGTERM) != 0 && errno() != libc::ESRCH {
                        return Err(-1);
                    }
                    stopped = wait_worker(pid, 500)?;
                }
                if !stopped {
                    if libc::kill(pid, libc::SIGKILL) != 0 && errno() != libc::ESRCH {
                        return Err(-1);
                    }
                    loop {
                        let result = libc::waitpid(pid, std::ptr::null_mut(), 0);
                        if result < 0 && errno() == libc::EINTR {
                            continue;
                        }
                        if result < 0 && errno() != libc::ECHILD {
                            return Err(-1);
                        }
                        break;
                    }
                }
            }
            self.workers.remove(index);
        }
        if report_stopped {
            let mut b = b"STOPPED\t".to_vec();
            b.extend(token);
            b.push(b'\n');
            report(&b);
        }
        Ok(())
    }
    fn stop_all(&mut self) {
        // The original broker stops cleanup at the first failure. Do not let
        // Drop silently retry it after the explicit normal-exit cleanup.
        self.cleanup_attempted = true;
        while let Some(worker) = self.workers.first() {
            let token = worker.token.clone();
            if self.stop(&token, false).is_err() {
                perror("stop native FUSE broker mount");
                break;
            }
        }
    }
    fn spawn(&mut self, line: &[u8], program: &CStr) -> Result<(), i32> {
        let fields: Vec<&[u8]> = line
            .split(|b| matches!(*b, b'\t' | b'\r' | b'\n'))
            .filter(|s| !s.is_empty())
            .take(8)
            .collect();
        if fields.len() != 7 || fields[0] != b"START" {
            set_errno(libc::EPROTO);
            return Err(-1);
        }
        if fields[1..]
            .iter()
            .any(|s| s.is_empty() || s.len() >= PATH_MAX)
            || fields[1].len() > 128
            || self.workers.iter().any(|w| w.token == fields[1])
        {
            set_errno(libc::EINVAL);
            return Err(-1);
        }
        let token = fields[1].to_vec();
        // All broker ownership is single-threaded. No Rust or libfuse thread is
        // running at fork; mounts create their libfuse runtime only in children.
        unsafe {
            let parent = libc::getpid();
            let child = libc::fork();
            if child < 0 {
                return Err(-1);
            }
            if child > 0 {
                self.workers.insert(0, Worker { token, pid: child });
                let mut b = b"STARTED\t".to_vec();
                b.extend(fields[1]);
                b.extend(format!("\t{}\n", child).as_bytes());
                report(&b);
                return Ok(());
            }
            libc::signal(libc::SIGCHLD, libc::SIG_DFL);
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != parent
            {
                libc::_exit(1);
            }
            libc::close(libc::STDIN_FILENO);
            libc::close(libc::STDOUT_FILENO);
            let control = match connect_controller(&cstring(fields[6]), &cstring(fields[1])) {
                Ok(fd) => fd,
                Err(_) => {
                    perror("connect native FUSE policy controller");
                    libc::_exit(1);
                }
            };
            let result = run_filesystem(
                program,
                &cstring(fields[2]),
                &cstring(fields[3]),
                &cstring(fields[4]),
                &cstring(fields[5]),
                -1,
                control.0,
                control.0,
                true,
            );
            drop(control);
            libc::_exit(result);
        }
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        if !self.cleanup_attempted {
            self.stop_all();
        }
    }
}
fn wait_worker(pid: libc::pid_t, timeout: i64) -> Result<bool, i32> {
    let pause = libc::timespec {
        tv_sec: 0,
        tv_nsec: 10_000_000,
    };
    let mut waited = 0;
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == pid || (result < 0 && errno() == libc::ECHILD) {
            return Ok(true);
        }
        if result < 0 && errno() != libc::EINTR {
            return Err(-1);
        }
        if waited >= timeout {
            return Ok(false);
        }
        unsafe {
            libc::nanosleep(&pause, std::ptr::null_mut());
        }
        waited += 10;
    }
}
