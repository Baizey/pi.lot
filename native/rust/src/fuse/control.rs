use super::*;

pub(super) fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
pub(super) fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}
pub(super) fn nonblocking(fd: i32) -> Result<(), i32> {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) != 0 {
            Err(-1)
        } else {
            Ok(())
        }
    }
}
fn milliseconds() -> Result<i64, i32> {
    unsafe {
        let mut now = std::mem::zeroed();
        if libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) != 0 {
            Err(-1)
        } else {
            Ok(now.tv_sec * 1000 + now.tv_nsec / 1_000_000)
        }
    }
}
fn remaining(deadline: i64) -> Result<i32, i32> {
    let now = milliseconds()?;
    if now >= deadline {
        set_errno(libc::ETIMEDOUT);
        Err(-1)
    } else {
        Ok((deadline - now).min(i32::MAX as i64) as i32)
    }
}
fn wait(fd: i32, events: i16, timeout: i32) -> Result<(), i32> {
    let now = milliseconds()?;
    let deadline = if timeout < 0 {
        -1
    } else {
        now + timeout as i64
    };
    let mut pending = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    loop {
        let timeout = if deadline < 0 {
            -1
        } else {
            remaining(deadline)?
        };
        let result = unsafe { libc::poll(&mut pending, 1, timeout) };
        if result < 0 && errno() == libc::EINTR {
            continue;
        }
        if result == 0 {
            set_errno(libc::ETIMEDOUT);
        }
        if result <= 0 {
            return Err(-1);
        }
        if pending.revents & events != 0 {
            return Ok(());
        }
        set_errno(libc::EPIPE);
        return Err(-1);
    }
}
fn read_control(
    fd: i32,
    buffer: &mut [u8],
    initial_timeout: i32,
    deadline: &mut i64,
) -> Result<(), i32> {
    let mut offset = 0;
    while offset < buffer.len() {
        let timeout = if *deadline >= 0 {
            remaining(*deadline)?
        } else {
            initial_timeout
        };
        wait(fd, libc::POLLIN, timeout)?;
        let result = unsafe {
            libc::read(
                fd,
                buffer[offset..].as_mut_ptr().cast(),
                buffer.len() - offset,
            )
        };
        if result < 0 && [libc::EINTR, libc::EAGAIN, libc::EWOULDBLOCK].contains(&errno()) {
            continue;
        }
        if result <= 0 {
            return Err(-1);
        }
        offset += result as usize;
        if *deadline < 0 {
            *deadline = milliseconds()? + 5000;
        }
    }
    Ok(())
}
pub(super) fn write_control(fd: i32, bytes: &[u8]) -> Result<(), i32> {
    let deadline = milliseconds()? + 5000;
    let mut offset = 0;
    while offset < bytes.len() {
        wait(fd, libc::POLLOUT, remaining(deadline)?)?;
        let result =
            unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
        if result < 0 && [libc::EINTR, libc::EAGAIN, libc::EWOULDBLOCK].contains(&errno()) {
            continue;
        }
        if result <= 0 {
            return Err(-1);
        }
        offset += result as usize;
    }
    Ok(())
}
pub(super) fn write_exact(fd: i32, bytes: &[u8]) -> Result<(), i32> {
    let mut offset = 0;
    while offset < bytes.len() {
        let n = unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
        if n < 0 && errno() == libc::EINTR {
            continue;
        }
        if n <= 0 {
            return Err(-1);
        }
        offset += n as usize;
    }
    Ok(())
}
pub(super) fn read_exact(fd: i32, bytes: &mut [u8]) -> Result<(), i32> {
    let mut offset = 0;
    while offset < bytes.len() {
        let n = unsafe {
            libc::read(
                fd,
                bytes[offset..].as_mut_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if n < 0 && errno() == libc::EINTR {
            continue;
        }
        if n <= 0 {
            return Err(-1);
        }
        offset += n as usize;
    }
    Ok(())
}
fn read_message(fd: i32) -> Result<(u32, Vec<u8>), i32> {
    let mut header = [0; 8];
    let mut deadline = -1;
    read_control(fd, &mut header, -1, &mut deadline)?;
    let size = u32_at(&header, 4) as usize;
    if size > MAX_SNAPSHOT_BYTES {
        return Err(-1);
    }
    let mut payload = vec![0; size];
    read_control(fd, &mut payload, 5000, &mut deadline)?;
    Ok((u32_at(&header, 0), payload))
}

#[derive(Default)]
pub(super) struct Policy {
    pub base: Snapshot,
    pub once: Snapshot,
    pub status: Option<libc::stat>,
    pub next_request: u64,
    pub failed: bool,
}
impl Policy {
    pub fn refresh(&mut self, state: &State) -> Result<(), i32> {
        state.count(BASE_CHECKS);
        let mut status = unsafe { std::mem::zeroed() };
        if unsafe { libc::stat(state.snapshot_path.as_ptr(), &mut status) } != 0 {
            return Err(-1);
        }
        if self
            .status
            .as_ref()
            .is_some_and(|old| same_snapshot(old, &status))
        {
            return Ok(());
        }
        let (replacement, loaded) = Snapshot::load(&state.snapshot_path)?;
        if replacement.revision < self.base.revision
            || (replacement.revision == self.base.revision && replacement != self.base)
        {
            set_errno(libc::EPROTO);
            return Err(-1);
        }
        if replacement.revision > self.base.revision {
            state.count(BASE_RELOADS);
            self.base = replacement;
        }
        self.status = Some(loaded);
        Ok(())
    }
    fn apply_once(&mut self, state: &State, payload: &[u8]) -> Result<(), i32> {
        let replacement = Snapshot::parse(payload)?;
        if replacement.revision < self.once.revision
            || (replacement.revision == self.once.revision && replacement != self.once)
        {
            set_errno(libc::EPROTO);
            return Err(-1);
        }
        if replacement.revision > self.once.revision {
            state.count(ONCE_UPDATES);
            self.once = replacement;
        }
        Ok(())
    }
    pub fn initial_once(&mut self, state: &State) -> Result<(), i32> {
        let (kind, payload) = read_message(state.response_fd)?;
        if kind != 1 {
            return Err(-1);
        }
        self.apply_once(state, &payload)
    }
    pub fn drain(&mut self, state: &State) -> Result<(), i32> {
        loop {
            let mut p = libc::pollfd {
                fd: state.response_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            let result = loop {
                let r = unsafe { libc::poll(&mut p, 1, 0) };
                if r >= 0 || errno() != libc::EINTR {
                    break r;
                }
            };
            if result < 0 {
                return Err(-1);
            }
            if result == 0 {
                return Ok(());
            }
            if p.revents & libc::POLLIN == 0 {
                return Err(-1);
            }
            self.initial_once(state)?;
        }
    }
    pub fn evaluate(&self, path: &[u8], access: Access) -> Option<Decision> {
        self.base
            .evaluate(path, access)
            .or_else(|| self.once.evaluate(path, access))
    }
    pub fn event(
        &self,
        state: &State,
        kind: u32,
        id: u64,
        access: Access,
        path: &[u8],
    ) -> Result<(), i32> {
        if path.is_empty() || path.len() >= PATH_MAX {
            return Err(-1);
        }
        let mut b = Vec::with_capacity(40 + path.len());
        b.extend(kind.to_le_bytes());
        b.extend((32 + path.len() as u32).to_le_bytes());
        b.extend(id.to_le_bytes());
        b.extend(self.base.revision.to_le_bytes());
        b.extend(self.once.revision.to_le_bytes());
        b.extend([access as u8, 0, 0, 0]);
        b.extend((path.len() as u32).to_le_bytes());
        b.extend(path);
        write_control(state.request_fd, &b)
    }
    pub fn resolution(
        &mut self,
        state: &State,
        id: u64,
        base: u64,
        once: u64,
    ) -> Result<Decision, i32> {
        loop {
            let (kind, payload) = read_message(state.response_fd)?;
            if kind == 1 {
                self.apply_once(state, &payload)?;
                continue;
            }
            if kind != 2 || payload.len() != 25 {
                return Err(-1);
            }
            let request = u64_at(&payload, 0);
            let resolved_base = u64_at(&payload, 8);
            let resolved_once = u64_at(&payload, 16);
            // Refresh precedes all response-field validation, as in the original protocol.
            self.refresh(state)?;
            if request != id
                || resolved_base < base
                || resolved_base > self.base.revision
                || resolved_once < once
                || resolved_once > self.once.revision
            {
                return Err(-1);
            }
            return match payload[24] {
                1 => Ok(Decision::Allow),
                2 => Ok(Decision::Deny),
                _ => Err(-1),
            };
        }
    }
}
fn same_snapshot(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev
        && a.st_ino == b.st_ino
        && a.st_size == b.st_size
        && a.st_mtime == b.st_mtime
        && a.st_mtime_nsec == b.st_mtime_nsec
        && a.st_ctime == b.st_ctime
        && a.st_ctime_nsec == b.st_ctime_nsec
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_size_is_bounded() {
        unsafe {
            let mut fds = [0; 2];
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            let input = Fd(fds[0]);
            let output = Fd(fds[1]);
            let mut b = 1u32.to_le_bytes().to_vec();
            b.extend((MAX_SNAPSHOT_BYTES as u32 + 1).to_le_bytes());
            write_exact(output.0, &b).unwrap();
            assert!(read_message(input.0).is_err());
        }
    }
    fn snapshot(revision: u64, decision: u8) -> Vec<u8> {
        let mut bytes = b"PILOTNP2".to_vec();
        bytes.extend(revision.to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        bytes.extend([0, 0, 0, 0, 1, decision, 0, 0, 1, 0, 0, 0, b'/']);
        bytes
    }
    #[test]
    fn once_revisions_accept_identical_duplicates_and_reject_conflicts_and_rollback() {
        let state = State::new(cstring(b""), cstring(b"/hidden"), -1, -1);
        let mut policy = Policy::default();
        assert!(policy.apply_once(&state, &snapshot(0, 1)).is_err());
        assert_eq!(errno(), libc::EPROTO);
        assert_eq!(policy.evaluate(b"/target", Access::Read), None);
        policy.apply_once(&state, &snapshot(2, 2)).unwrap();
        policy.apply_once(&state, &snapshot(2, 2)).unwrap();
        let mut reserved_duplicate = snapshot(2, 2);
        reserved_duplicate[26..28].copy_from_slice(&[255, 255]);
        policy.apply_once(&state, &reserved_duplicate).unwrap();
        assert!(policy.apply_once(&state, &snapshot(2, 1)).is_err());
        assert_eq!(errno(), libc::EPROTO);
        assert_eq!(
            policy.evaluate(b"/target", Access::Read),
            Some(Decision::Deny)
        );
        assert!(policy.apply_once(&state, &snapshot(1, 1)).is_err());
        assert_eq!(errno(), libc::EPROTO);
        assert_eq!(policy.once.revision, 2);
        assert_eq!(state.counters[ONCE_UPDATES].load(Ordering::Relaxed), 1);
    }
    #[test]
    fn base_revisions_accept_identical_duplicates_and_reject_conflicts() {
        struct SnapshotFile {
            descriptor: Fd,
            path: CString,
        }
        impl SnapshotFile {
            fn replace_contents(&self, bytes: &[u8]) {
                unsafe {
                    assert_eq!(
                        libc::ftruncate(self.descriptor.0, bytes.len() as libc::off_t),
                        0
                    );
                    assert_eq!(
                        libc::pwrite(self.descriptor.0, bytes.as_ptr().cast(), bytes.len(), 0),
                        bytes.len() as isize
                    );
                }
            }
        }
        impl Drop for SnapshotFile {
            fn drop(&mut self) {
                unsafe {
                    libc::unlink(self.path.as_ptr());
                }
            }
        }
        let mut name = b"/tmp/pilot-fuse-snapshot-XXXXXX\0".to_vec();
        let fd = unsafe { libc::mkstemp(name.as_mut_ptr().cast()) };
        assert!(fd >= 0);
        let file = SnapshotFile {
            descriptor: Fd(fd),
            path: CString::from_vec_with_nul(name).unwrap(),
        };
        file.replace_contents(&snapshot(7, 1));
        let state = State::new(file.path.clone(), cstring(b"/hidden"), -1, -1);
        state.load().unwrap();
        let mut policy = state.policy.lock().unwrap();
        let mut reserved_duplicate = snapshot(7, 1);
        reserved_duplicate[26..28].copy_from_slice(&[42, 255]);
        file.replace_contents(&reserved_duplicate);
        // Force the reload branch independently of filesystem timestamp precision.
        policy.status = None;
        policy.refresh(&state).unwrap();
        assert!(policy.status.is_some());
        assert_eq!(state.counters[BASE_RELOADS].load(Ordering::Relaxed), 0);
        file.replace_contents(&snapshot(7, 2));
        policy.status = None;
        assert!(policy.refresh(&state).is_err());
        assert_eq!(errno(), libc::EPROTO);
        assert!(policy.status.is_none());
        assert_eq!(
            policy.evaluate(b"/target", Access::Read),
            Some(Decision::Allow)
        );
        assert_eq!(state.counters[BASE_RELOADS].load(Ordering::Relaxed), 0);
    }
    #[test]
    fn events_preserve_full_width_revisions_and_path_bytes() {
        unsafe {
            let mut fds = [0; 2];
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            let input = Fd(fds[0]);
            let output = Fd(fds[1]);
            let state = State::new(cstring(b""), cstring(b"/hidden"), output.0, -1);
            let mut policy = Policy::default();
            policy.base.revision = u64::MAX;
            policy.once.revision = 1u64 << 40;
            policy
                .event(&state, 1, 1u64 << 50, Access::Write, b"/\xff\\")
                .unwrap();
            let (kind, payload) = read_message(input.0).unwrap();
            assert_eq!(kind, 1);
            assert_eq!(payload.len(), 35);
            assert_eq!(u64_at(&payload, 0), 1u64 << 50);
            assert_eq!(u64_at(&payload, 8), u64::MAX);
            assert_eq!(u64_at(&payload, 16), 1u64 << 40);
            assert_eq!(&payload[24..28], &[2, 0, 0, 0]);
            assert_eq!(u32_at(&payload, 28), 3);
            assert_eq!(&payload[32..], b"/\xff\\");
        }
    }
    #[test]
    fn empty_payload_frame() {
        unsafe {
            let mut fds = [0; 2];
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            let input = Fd(fds[0]);
            let output = Fd(fds[1]);
            write_exact(output.0, &[2, 0, 0, 0, 0, 0, 0, 0]).unwrap();
            assert_eq!(read_message(input.0).unwrap(), (2, Vec::new()));
        }
    }
}
