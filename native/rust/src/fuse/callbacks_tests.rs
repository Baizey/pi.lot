use super::*;
use std::os::unix::ffi::OsStrExt;

struct PolicyOpenFixture {
    state: State,
    directory: CString,
    file: CString,
    created: CString,
    requests: Option<Fd>,
    _request_writer: Fd,
    _response_reader: Fd,
    responses: Option<Fd>,
}

impl PolicyOpenFixture {
    fn new(write: Decision, mmap: Option<Decision>, read: Decision) -> Self {
        let mut name = b"/tmp/pilot-fuse-policy-open-XXXXXX\0".to_vec();
        assert!(!unsafe { libc::mkdtemp(name.as_mut_ptr().cast()) }.is_null());
        let directory = CString::from_vec_with_nul(name).unwrap();
        let child = |suffix: &[u8]| cstring(&[directory.to_bytes(), suffix].concat());
        let (file, created, snapshot) = (child(b"/file"), child(b"/created"), child(b"/snapshot"));
        let (requests, request_writer) = pipe();
        let (response_reader, responses) = pipe();
        let state = State::new(
            snapshot,
            cstring(b"/hidden"),
            request_writer.0,
            response_reader.0,
        );
        let fixture = Self {
            state,
            directory,
            file,
            created,
            requests: Some(requests),
            _request_writer: request_writer,
            _response_reader: response_reader,
            responses: Some(responses),
        };
        let mut bytes = b"PILOTNP2".to_vec();
        bytes.extend(1u64.to_le_bytes());
        bytes.extend((2 + u32::from(mmap.is_some())).to_le_bytes());
        for (access, decision) in [
            (Access::Write, Some(write)),
            (Access::Mmap, mmap),
            (Access::Read, Some(read)),
        ] {
            let Some(decision) = decision else { continue };
            bytes.extend(0u32.to_le_bytes());
            bytes.extend([access as u8, decision as u8, 0, 0]);
            let path = fixture.directory.to_bytes();
            bytes.extend((path.len() as u32).to_le_bytes());
            bytes.extend(path);
        }
        std::fs::write(
            std::ffi::OsStr::from_bytes(fixture.state.snapshot_path.to_bytes()),
            bytes,
        )
        .unwrap();
        std::fs::write(
            std::ffi::OsStr::from_bytes(fixture.file.to_bytes()),
            b"original",
        )
        .unwrap();
        fixture
    }

    fn call(&mut self, op: Operation, flags: i32) -> Result<i32, i32> {
        let mut call = Call {
            path: if matches!(op, Operation::Create) {
                &self.created
            } else {
                &self.file
            }
            .as_ptr(),
            flags,
            mode: 0o600,
            ..Call::default()
        };
        let result = unsafe { pilot_fuse_call(&mut self.state, op, &mut call) };
        if result < 0 {
            return Err(result);
        }
        assert_eq!(
            unsafe { pilot_fuse_call(&mut self.state, Operation::Release, &mut call) },
            0
        );
        Ok(call.direct_io)
    }

    fn write(&mut self, writepage: bool, after_open: impl FnOnce(&mut Self)) -> i32 {
        let mut bytes = *b"modified";
        let mut call = Call {
            path: self.file.as_ptr(),
            flags: libc::O_RDWR,
            ..Call::default()
        };
        assert_eq!(
            unsafe { pilot_fuse_call(&mut self.state, Operation::Open, &mut call) },
            0
        );
        after_open(self);
        call.writepage = writepage;
        call.buffer = bytes.as_mut_ptr().cast();
        call.size = bytes.len();
        let result = unsafe { pilot_fuse_call(&mut self.state, Operation::Write, &mut call) };
        assert_eq!(
            unsafe { pilot_fuse_call(&mut self.state, Operation::Release, &mut call) },
            0
        );
        result
    }

    fn contents(&self) -> Vec<u8> {
        std::fs::read(std::ffi::OsStr::from_bytes(self.file.to_bytes())).unwrap()
    }
}

impl Drop for PolicyOpenFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(std::ffi::OsStr::from_bytes(self.directory.to_bytes()));
    }
}

fn pipe() -> (Fd, Fd) {
    let mut fds = [-1; 2];
    assert_eq!(
        unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
        0
    );
    (Fd(fds[0]), Fd(fds[1]))
}

#[test]
fn ordinary_open_create_and_write_do_not_consult_mmap_policy() {
    use Decision::{Allow, Deny};
    for mmap in [Allow, Deny] {
        let mut fixture = PolicyOpenFixture::new(Allow, Some(mmap), Deny);
        assert_eq!(fixture.call(Operation::Open, libc::O_RDWR), Ok(1));
        assert_eq!(fixture.call(Operation::Create, libc::O_RDWR), Ok(1));
        assert_eq!(fixture.write(false, |_| {}), 8);
        assert_eq!(fixture.contents(), b"modified");
        let mut byte = 0u8;
        assert_eq!(
            unsafe {
                libc::read(
                    fixture.requests.as_ref().unwrap().0,
                    (&mut byte as *mut u8).cast(),
                    1,
                )
            },
            -1
        );
        assert_eq!(errno(), libc::EAGAIN);
    }
}

#[test]
fn mapped_writeback_requires_mmap_and_read_authority() {
    use Decision::{Allow, Deny};
    for (read, mmap, result, expected, denied_access) in [
        (Allow, Allow, 8, &b"modified"[..], None),
        (
            Allow,
            Deny,
            -libc::EACCES,
            &b"original"[..],
            Some(Access::Mmap),
        ),
        (
            Deny,
            Allow,
            -libc::EACCES,
            &b"original"[..],
            Some(Access::Read),
        ),
    ] {
        let mut fixture = PolicyOpenFixture::new(Allow, Some(mmap), read);
        assert_eq!(fixture.write(true, |_| {}), result);
        assert_eq!(fixture.contents(), expected);
        if let Some(access) = denied_access {
            let mut header = [0; 40];
            read_exact(fixture.requests.as_ref().unwrap().0, &mut header).unwrap();
            assert_eq!(u32_at(&header, 0), 2);
            assert_eq!(header[32], access as u8);
        }
    }
}

#[test]
fn denied_ordinary_write_authority_blocks_create_and_truncate() {
    use Decision::{Allow, Deny};
    let mut fixture = PolicyOpenFixture::new(Deny, Some(Allow), Allow);
    assert_eq!(
        fixture.call(Operation::Open, libc::O_RDWR | libc::O_TRUNC),
        Err(-libc::EACCES)
    );
    assert_eq!(fixture.contents(), b"original");
    assert_eq!(
        fixture.call(Operation::Create, libc::O_RDWR),
        Err(-libc::EACCES)
    );
    assert!(
        !std::path::Path::new(std::ffi::OsStr::from_bytes(fixture.created.to_bytes())).exists()
    );
}

#[test]
fn mapped_writeback_fails_closed_when_approval_channel_dies() {
    let mut fixture = PolicyOpenFixture::new(Decision::Allow, None, Decision::Allow);
    assert_eq!(
        fixture.write(true, |fixture| drop(fixture.responses.take())),
        -libc::EACCES
    );
    assert_eq!(fixture.contents(), b"original");
}

#[test]
fn default_call_has_null_pointers_zero_scalars_and_no_filler() {
    let call = Call::default();
    assert!(call.path.is_null());
    assert!(call.second.is_null());
    assert!(call.buffer.is_null());
    assert_eq!(call.size, 0);
    assert_eq!(call.offset, 0);
    assert_eq!(call.fh, 0);
    assert_eq!(call.flags, 0);
    assert_eq!(call.mode, 0);
    assert_eq!(call.uid, 0);
    assert_eq!(call.gid, 0);
    assert_eq!(call.device, 0);
    assert!(call.filler.is_none());
    assert_eq!(call.has_info, 0);
    assert_eq!(call.direct_io, 0);
    assert_eq!(call.keep_cache, 0);
    assert!(!call.writepage);
}

#[test]
fn null_dispatch_arguments_fail_closed() {
    unsafe {
        let mut call = Call::default();
        let mut state = State::new(cstring(b""), cstring(b"/hidden"), -1, -1);
        assert_eq!(
            pilot_fuse_call(std::ptr::null_mut(), Operation::Flush, &mut call),
            -libc::EACCES
        );
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Flush, std::ptr::null_mut()),
            -libc::EACCES
        );
        assert_eq!(pilot_fuse_call(&mut state, Operation::Flush, &mut call), 0);
        assert!(!state.panicked.load(Ordering::Relaxed));
    }
}

#[test]
fn panicked_mount_releases_file_and_poisoned_directory_handles() {
    unsafe {
        let file = Stdio(libc::tmpfile());
        assert!(!file.0.is_null());
        // High-numbered descriptors keep parallel unit-test opens from
        // reusing a just-closed fd before the EBADF assertion below.
        let file_fd = libc::fcntl(libc::fileno(file.0), libc::F_DUPFD_CLOEXEC, 256);
        assert!(file_fd >= 0);
        drop(file);
        let directory_fd = Fd(libc::open(
            c"/tmp".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        ));
        assert!(directory_fd.0 >= 0);
        let retained_directory_fd = libc::fcntl(directory_fd.0, libc::F_DUPFD_CLOEXEC, 256);
        assert!(retained_directory_fd >= 0);
        let directory = libc::fdopendir(retained_directory_fd);
        assert!(!directory.is_null());
        drop(directory_fd);
        let handle = Box::into_raw(Box::new(DirectoryHandle {
            inner: Mutex::new(Directory {
                directory,
                enumeration_started: false,
            }),
        }));
        let mut state = State::new(cstring(b""), cstring(b"/hidden"), -1, -1);
        assert_eq!(
            boundary(&state, || {
                let _locked = (*handle).inner.lock().unwrap();
                panic!("directory callback fault");
            }),
            -libc::EACCES
        );
        assert!((*handle).inner.is_poisoned());
        let mut call: Call = std::mem::zeroed();
        call.path = c"/tmp".as_ptr();
        call.fh = file_fd as u64;
        call.has_info = 1;
        let mut attributes: libc::stat = std::mem::zeroed();
        call.buffer = (&mut attributes as *mut libc::stat).cast();
        for op in [
            Operation::Read,
            Operation::Write,
            Operation::Getattr,
            Operation::Fsync,
        ] {
            assert_eq!(pilot_fuse_call(&mut state, op, &mut call), -libc::EACCES);
        }
        assert_eq!(libc::fstat(file_fd, &mut attributes), 0);
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Release, &mut call),
            0
        );
        assert_eq!(libc::fstat(file_fd, &mut attributes), -1);
        assert_eq!(errno(), libc::EBADF);
        call.fh = handle as usize as u64;
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Releasedir, &mut call),
            0
        );
        assert_eq!(libc::fstat(retained_directory_fd, &mut attributes), -1);
        assert_eq!(errno(), libc::EBADF);
        assert_eq!(pilot_fuse_call(&mut state, Operation::Flush, &mut call), 0);
        assert!(state.panicked.load(Ordering::Relaxed));
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Open, &mut call),
            -libc::EACCES
        );
    }
}

#[test]
fn panicked_mount_still_writes_final_statistics() {
    struct TemporaryStatistics(CString);
    impl Drop for TemporaryStatistics {
        fn drop(&mut self) {
            unsafe {
                libc::unlink(self.0.as_ptr());
            }
        }
    }
    let mut name = b"/tmp/pilot-fuse-panic-statistics-XXXXXX\0".to_vec();
    let file = Fd(unsafe { libc::mkstemp(name.as_mut_ptr().cast()) });
    assert!(file.0 >= 0);
    let output = TemporaryStatistics(CString::from_vec_with_nul(name).unwrap());
    let mut state = State::new(cstring(b""), cstring(b"/hidden"), -1, -1);
    state.stats_path = output.0.clone();
    assert_eq!(boundary(&state, || panic!("callback fault")), -libc::EACCES);
    state.count(POLICY_EVENTS);
    unsafe {
        pilot_fuse_statistics(&mut state);
    }
    let mut bytes = [0u8; 512];
    let length = unsafe { libc::pread(file.0, bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    assert!(length > 0);
    assert!(bytes[..length as usize].starts_with(b"{\"policyEvents\":1,"));
    assert!(state.panicked.load(Ordering::Relaxed));
    assert_eq!(boundary(&state, || Ok(0)), -libc::EACCES);
}
