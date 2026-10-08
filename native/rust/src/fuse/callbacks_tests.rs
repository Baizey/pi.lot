use super::*;

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
            assert_eq!(
                pilot_fuse_call(&mut state, op as u32, &mut call),
                -libc::EACCES
            );
        }
        assert_eq!(libc::fstat(file_fd, &mut attributes), 0);
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Release as u32, &mut call),
            0
        );
        assert_eq!(libc::fstat(file_fd, &mut attributes), -1);
        assert_eq!(errno(), libc::EBADF);
        call.fh = handle as usize as u64;
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Releasedir as u32, &mut call),
            0
        );
        assert_eq!(libc::fstat(retained_directory_fd, &mut attributes), -1);
        assert_eq!(errno(), libc::EBADF);
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Flush as u32, &mut call),
            0
        );
        assert!(state.panicked.load(Ordering::Relaxed));
        assert_eq!(
            pilot_fuse_call(&mut state, Operation::Open as u32, &mut call),
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
