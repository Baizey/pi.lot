//! Single-threaded transparent TCP ingress with one bounded-buffer relay process per flow.
use std::ffi::{CStr, CString};
use std::io::{self, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicI32, Ordering};

const PREFIX: &str = "PI_TCP_GATEWAY\t1";
const BUFFER_SIZE: usize = 64 * 1024;
const MAX_ACTIVE_RELAYS: i32 = 128;
static ACTIVE_RELAYS: AtomicI32 = AtomicI32::new(0);

extern "C" {
    fn inet_pton(
        family: libc::c_int,
        text: *const libc::c_char,
        address: *mut libc::c_void,
    ) -> libc::c_int;
}

pub fn main() -> i32 {
    crate::process_signal::restore_closed_stdio();
    crate::process_signal::restore_sigpipe();
    let arguments: Vec<CString> = std::env::args_os()
        .map(|argument| CString::new(argument.as_bytes()).expect("argv cannot contain NUL"))
        .collect();
    if arguments.len() != 3 {
        diagnostic("usage: pi-tcp-gateway BROKER_IPV4 BROKER_PORT");
        return 1;
    }
    let mut broker_address: libc::in_addr = unsafe { zeroed() };
    let valid_address = unsafe {
        inet_pton(
            libc::AF_INET,
            arguments[1].as_ptr(),
            (&mut broker_address as *mut libc::in_addr).cast(),
        )
    } == 1;
    let broker_port = if valid_address {
        parse_port(&arguments[2])
    } else {
        None
    };
    let Some(broker_port) = broker_port else {
        diagnostic("pi-tcp-gateway: invalid broker endpoint");
        return 1;
    };
    if install_signal_handlers().is_err() {
        report_error("install signal handlers");
        return 1;
    }
    let (ipv4, ingress_port) = match create_listener(libc::AF_INET, 0) {
        Ok(listener) => listener,
        Err(()) => {
            report_error("create IPv4 transparent listener");
            return 1;
        }
    };
    let (ipv6, _) = match create_listener(libc::AF_INET6, ingress_port) {
        Ok(listener) => listener,
        Err(()) => {
            report_error("create IPv6 transparent listener");
            return 1;
        }
    };
    if drop_process_privileges().is_err() {
        report_error("drop gateway privileges");
        return 1;
    }
    let readiness = format!("{PREFIX}\tREADY\t{ingress_port}\n");
    // Write and flush before accepting, as the launcher uses this as its readiness barrier.
    let mut stdout = io::stdout().lock();
    if let Err(error) = stdout
        .write_all(readiness.as_bytes())
        .and_then(|()| stdout.flush())
    {
        if let Some(code) = error.raw_os_error() {
            set_errno(code);
        }
        report_error("send readiness record");
        return 1;
    }
    drop(stdout);
    serve_listeners(
        &[ipv4.as_raw_fd(), ipv6.as_raw_fd()],
        &broker_address,
        broker_port,
    )
}

fn serve_listeners(listeners: &[RawFd], broker_address: &libc::in_addr, broker_port: u16) -> i32 {
    loop {
        let mut descriptors: Vec<_> = listeners
            .iter()
            .map(|&fd| poll_descriptor(fd, libc::POLLIN))
            .collect();
        if unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                -1,
            )
        } < 0
        {
            if errno() == libc::EINTR {
                continue;
            }
            report_error("poll listeners");
            return 1;
        }
        for descriptor in descriptors {
            if descriptor.revents & libc::POLLIN != 0 {
                accept_client(descriptor.fd, listeners, broker_address, broker_port);
            }
            if descriptor.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                diagnostic("pi-tcp-gateway: transparent listener failed");
                return 1;
            }
        }
    }
}

/// Uses libc's conversion rather than a Rust integer parser: leading whitespace and '+'
/// (and strtoul's unsigned negation) are part of the existing native CLI contract.
pub fn parse_port(value: &CStr) -> Option<u16> {
    if value.to_bytes().is_empty() {
        return None;
    }
    let mut end = std::ptr::null_mut();
    set_errno(0);
    let parsed = unsafe { libc::strtoul(value.as_ptr(), &mut end, 10) };
    if errno() != 0
        || end.is_null()
        || unsafe { *end } != 0
        || parsed == 0
        || parsed > u16::MAX as libc::c_ulong
    {
        None
    } else {
        Some(parsed as u16)
    }
}

/// Relays borrowed connected socket descriptors. They remain open, with O_NONBLOCK set,
/// on return; callers own closing them. The production child and probe use this same path.
pub fn relay_streams(client: RawFd, broker: RawFd) -> io::Result<()> {
    set_nonblocking(client)?;
    set_nonblocking(broker)?;
    let mut client_to_broker = RelayBuffer::new();
    let mut broker_to_client = RelayBuffer::new();
    let mut client_ended = false;
    let mut broker_ended = false;
    let mut client_write_closed = false;
    let mut broker_write_closed = false;
    loop {
        if client_ended && client_to_broker.length == 0 && !broker_write_closed {
            shutdown_write(broker)?;
            broker_write_closed = true;
        }
        if broker_ended && broker_to_client.length == 0 && !client_write_closed {
            shutdown_write(client)?;
            client_write_closed = true;
        }
        if client_ended
            && broker_ended
            && client_to_broker.length == 0
            && broker_to_client.length == 0
        {
            return Ok(());
        }
        let mut descriptors = [poll_descriptor(client, 0), poll_descriptor(broker, 0)];
        if !client_ended && client_to_broker.length < BUFFER_SIZE {
            descriptors[0].events |= libc::POLLIN;
        }
        if broker_to_client.length > 0 {
            descriptors[0].events |= libc::POLLOUT;
        }
        if !broker_ended && broker_to_client.length < BUFFER_SIZE {
            descriptors[1].events |= libc::POLLIN;
        }
        if client_to_broker.length > 0 {
            descriptors[1].events |= libc::POLLOUT;
        }
        if unsafe { libc::poll(descriptors.as_mut_ptr(), 2, -1) } < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return Err(io::Error::last_os_error());
        }
        if descriptors[0].revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            client_to_broker.receive(client, &mut client_ended)?;
        }
        if descriptors[1].revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            broker_to_client.receive(broker, &mut broker_ended)?;
        }
        if descriptors[0].revents & libc::POLLOUT != 0 {
            broker_to_client.send(client)?;
        }
        if descriptors[1].revents & libc::POLLOUT != 0 {
            client_to_broker.send(broker)?;
        }
        if descriptors
            .iter()
            .any(|descriptor| descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0)
        {
            return Err(io::Error::other("relay socket reported POLLERR/POLLNVAL"));
        }
    }
}

struct RelayBuffer {
    bytes: Box<[u8; BUFFER_SIZE]>,
    offset: usize,
    length: usize,
}

impl RelayBuffer {
    fn new() -> Self {
        Self {
            bytes: Box::new([0; BUFFER_SIZE]),
            offset: 0,
            length: 0,
        }
    }

    fn receive(&mut self, descriptor: RawFd, ended: &mut bool) -> io::Result<()> {
        if self.length == 0 {
            self.offset = 0;
        } else if self.offset > 0 {
            self.bytes
                .copy_within(self.offset..self.offset + self.length, 0);
            self.offset = 0;
        }
        let available = BUFFER_SIZE - self.length;
        if available == 0 || *ended {
            return Ok(());
        }
        let received = unsafe {
            libc::recv(
                descriptor,
                self.bytes[self.length..].as_mut_ptr().cast(),
                available,
                0,
            )
        };
        if received > 0 {
            self.length += received as usize;
        } else if received == 0 {
            *ended = true;
        } else if !retryable() {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn send(&mut self, descriptor: RawFd) -> io::Result<()> {
        if self.length == 0 {
            return Ok(());
        }
        let sent = unsafe {
            libc::send(
                descriptor,
                self.bytes[self.offset..].as_ptr().cast(),
                self.length,
                libc::MSG_NOSIGNAL,
            )
        };
        if sent > 0 {
            self.offset += sent as usize;
            self.length -= sent as usize;
            if self.length == 0 {
                self.offset = 0;
            }
            Ok(())
        } else if sent < 0 && retryable() {
            Ok(())
        } else if sent == 0 {
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "relay send returned zero",
            ))
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

fn handle_client(
    client: RawFd,
    broker_address: &libc::in_addr,
    broker_port: u16,
) -> Result<(), ()> {
    let mut source: libc::sockaddr_storage = unsafe { zeroed() };
    let mut destination: libc::sockaddr_storage = unsafe { zeroed() };
    let mut source_length = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    let mut destination_length = source_length;
    if unsafe {
        libc::getpeername(
            client,
            (&mut source as *mut libc::sockaddr_storage).cast(),
            &mut source_length,
        )
    } < 0
        || unsafe {
            libc::getsockname(
                client,
                (&mut destination as *mut libc::sockaddr_storage).cast(),
                &mut destination_length,
            )
        } < 0
        || source.ss_family != destination.ss_family
        || (source.ss_family as i32 != libc::AF_INET && source.ss_family as i32 != libc::AF_INET6)
    {
        return Err(());
    }
    let (source_host, source_service) = endpoint_text(&source, source_length)?;
    let (destination_host, destination_service) = endpoint_text(&destination, destination_length)?;
    let broker = connect_broker(broker_address, broker_port)?;
    let family = if source.ss_family as i32 == libc::AF_INET {
        "IPV4"
    } else {
        "IPV6"
    };
    let header = format!("{PREFIX}\tFLOW\t{family}\t{source_host}\t{source_service}\t{destination_host}\t{destination_service}\n");
    if header.len() >= 1024 {
        return Err(());
    }
    write_all(broker.as_raw_fd(), header.as_bytes())?;
    relay_streams(client, broker.as_raw_fd()).map_err(|_| ())
}

fn accept_client(
    listener: RawFd,
    listeners: &[RawFd],
    broker_address: &libc::in_addr,
    broker_port: u16,
) {
    let client = unsafe { libc::accept(listener, std::ptr::null_mut(), std::ptr::null_mut()) };
    if client < 0 {
        if !retryable() {
            report_error("accept flow");
        }
        return;
    }
    let client = unsafe { OwnedFd::from_raw_fd(client) };
    if set_close_on_exec(client.as_raw_fd()).is_err()
        || ACTIVE_RELAYS.load(Ordering::Relaxed) >= MAX_ACTIVE_RELAYS
    {
        return;
    }
    let mut blocked: libc::sigset_t = unsafe { zeroed() };
    let mut previous: libc::sigset_t = unsafe { zeroed() };
    unsafe {
        libc::sigemptyset(&mut blocked);
        libc::sigaddset(&mut blocked, libc::SIGCHLD);
    }
    if unsafe { libc::sigprocmask(libc::SIG_BLOCK, &blocked, &mut previous) } < 0 {
        return;
    }
    // The gateway never starts threads. SIGCHLD is blocked across fork/accounting so a
    // fast-exiting relay cannot be reaped before its count has been incremented.
    let gateway_pid = unsafe { libc::getpid() };
    let child = unsafe { libc::fork() };
    if child == 0 {
        unsafe {
            libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
            libc::signal(libc::SIGCHLD, libc::SIG_DFL);
            // A dead gateway can be replaced by a subreaper, not only PID 1,
            // during the window before parent-death signal registration.
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0
                || libc::getppid() != gateway_pid
            {
                libc::_exit(1);
            }
            for listener in listeners {
                libc::close(*listener);
            }
        }
        let result = handle_client(client.as_raw_fd(), broker_address, broker_port);
        drop(client);
        unsafe {
            libc::_exit(if result.is_ok() { 0 } else { 1 });
        }
    }
    if child > 0 {
        ACTIVE_RELAYS.fetch_add(1, Ordering::Relaxed);
    } else {
        report_error("fork relay");
    }
    unsafe {
        libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
    }
}

extern "C" fn reap_children(_: libc::c_int) {
    let saved = errno();
    while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {
        if ACTIVE_RELAYS.load(Ordering::Relaxed) > 0 {
            ACTIVE_RELAYS.fetch_sub(1, Ordering::Relaxed);
        }
    }
    set_errno(saved);
}

fn install_signal_handlers() -> Result<(), ()> {
    let mut action: libc::sigaction = unsafe { zeroed() };
    action.sa_sigaction = reap_children as *const () as usize;
    action.sa_flags = libc::SA_RESTART | libc::SA_NOCLDSTOP;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    if unsafe { libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) } < 0 {
        return Err(());
    }
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    Ok(())
}

fn create_listener(family: i32, port: u16) -> Result<(OwnedFd, u16), ()> {
    let descriptor = socket(family)?;
    set_close_on_exec(descriptor.as_raw_fd())?;
    socket_option(descriptor.as_raw_fd(), libc::SOL_SOCKET, libc::SO_REUSEADDR)?;
    let bound_port;
    if family == libc::AF_INET {
        socket_option(
            descriptor.as_raw_fd(),
            libc::SOL_IP,
            19, /* IP_TRANSPARENT */
        )?;
        let mut address: libc::sockaddr_in = unsafe { zeroed() };
        address.sin_family = libc::AF_INET as libc::sa_family_t;
        address.sin_port = port.to_be();
        let mut length = size_of::<libc::sockaddr_in>() as libc::socklen_t;
        if unsafe {
            libc::bind(
                descriptor.as_raw_fd(),
                (&address as *const libc::sockaddr_in).cast(),
                length,
            )
        } < 0
        {
            return Err(());
        }
        if unsafe {
            libc::getsockname(
                descriptor.as_raw_fd(),
                (&mut address as *mut libc::sockaddr_in).cast(),
                &mut length,
            )
        } < 0
        {
            return Err(());
        }
        bound_port = u16::from_be(address.sin_port);
    } else {
        socket_option(descriptor.as_raw_fd(), libc::SOL_IPV6, libc::IPV6_V6ONLY)?;
        socket_option(
            descriptor.as_raw_fd(),
            libc::SOL_IPV6,
            75, /* IPV6_TRANSPARENT */
        )?;
        let mut address: libc::sockaddr_in6 = unsafe { zeroed() };
        address.sin6_family = libc::AF_INET6 as libc::sa_family_t;
        address.sin6_port = port.to_be();
        if unsafe {
            libc::bind(
                descriptor.as_raw_fd(),
                (&address as *const libc::sockaddr_in6).cast(),
                size_of::<libc::sockaddr_in6>() as libc::socklen_t,
            )
        } < 0
        {
            return Err(());
        }
        bound_port = port;
    }
    if unsafe { libc::listen(descriptor.as_raw_fd(), 128) } < 0 {
        return Err(());
    }
    Ok((descriptor, bound_port))
}

fn connect_broker(address: &libc::in_addr, port: u16) -> Result<OwnedFd, ()> {
    let descriptor = socket(libc::AF_INET)?;
    set_close_on_exec(descriptor.as_raw_fd())?;
    let mut destination: libc::sockaddr_in = unsafe { zeroed() };
    destination.sin_family = libc::AF_INET as libc::sa_family_t;
    destination.sin_port = port.to_be();
    destination.sin_addr = *address;
    if unsafe {
        libc::connect(
            descriptor.as_raw_fd(),
            (&destination as *const libc::sockaddr_in).cast(),
            size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
    } < 0
    {
        return Err(());
    }
    Ok(descriptor)
}

fn endpoint_text(
    address: &libc::sockaddr_storage,
    length: libc::socklen_t,
) -> Result<(String, String), ()> {
    let mut host = [0 as libc::c_char; 1025];
    let mut service = [0 as libc::c_char; 32];
    if unsafe {
        libc::getnameinfo(
            (address as *const libc::sockaddr_storage).cast(),
            length,
            host.as_mut_ptr(),
            host.len() as libc::socklen_t,
            service.as_mut_ptr(),
            service.len() as libc::socklen_t,
            libc::NI_NUMERICHOST | libc::NI_NUMERICSERV,
        )
    } != 0
    {
        return Err(());
    }
    // Numeric addresses/services are ASCII, including the numeric IPv6 scope suffix.
    let host = unsafe { CStr::from_ptr(host.as_ptr()) }
        .to_str()
        .map_err(|_| ())?
        .to_owned();
    let service = unsafe { CStr::from_ptr(service.as_ptr()) }
        .to_str()
        .map_err(|_| ())?
        .to_owned();
    Ok((host, service))
}

fn write_all(descriptor: RawFd, mut bytes: &[u8]) -> Result<(), ()> {
    while !bytes.is_empty() {
        let written = unsafe {
            libc::send(
                descriptor,
                bytes.as_ptr().cast(),
                bytes.len(),
                libc::MSG_NOSIGNAL,
            )
        };
        if written > 0 {
            bytes = &bytes[written as usize..];
        } else if written < 0 && errno() == libc::EINTR {
            continue;
        } else {
            return Err(());
        }
    }
    Ok(())
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn drop_process_privileges() -> Result<(), ()> {
    let header = CapabilityHeader {
        version: 0x2008_0522,
        pid: 0,
    };
    let capabilities = [CapabilityData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) } < 0
        || unsafe {
            libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL,
                0,
                0,
                0,
            )
        } < 0
        || unsafe { libc::syscall(libc::SYS_capset, &header, capabilities.as_ptr()) } < 0
        || unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0
    {
        return Err(());
    }
    Ok(())
}

fn socket(family: i32) -> Result<OwnedFd, ()> {
    let fd = unsafe { libc::socket(family, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        Err(())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn socket_option(descriptor: RawFd, level: i32, option: i32) -> Result<(), ()> {
    let enabled: libc::c_int = 1;
    if unsafe {
        libc::setsockopt(
            descriptor,
            level,
            option,
            (&enabled as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    } < 0
    {
        Err(())
    } else {
        Ok(())
    }
}

fn set_close_on_exec(descriptor: RawFd) -> Result<(), ()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        Err(())
    } else {
        Ok(())
    }
}

fn set_nonblocking(descriptor: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn shutdown_write(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::shutdown(descriptor, libc::SHUT_WR) } < 0 && errno() != libc::ENOTCONN {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn poll_descriptor(fd: RawFd, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

fn retryable() -> bool {
    matches!(errno(), libc::EINTR | libc::EAGAIN) // EWOULDBLOCK == EAGAIN on Linux.
}

fn errno() -> libc::c_int {
    unsafe { *libc::__errno_location() }
}
fn set_errno(value: libc::c_int) {
    unsafe {
        *libc::__errno_location() = value;
    }
}

fn diagnostic(message: &str) {
    let _ = writeln!(io::stderr().lock(), "{message}");
}

fn report_error(message: &str) {
    let saved = errno();
    let description = unsafe { CStr::from_ptr(libc::strerror(saved)) };
    let mut stderr = io::stderr().lock();
    let _ = write!(stderr, "pi-tcp-gateway: {message}: ");
    let _ = stderr.write_all(description.to_bytes());
    let _ = stderr.write_all(b"\n");
}

/// Mount-free probe entry point; never changes the production relay implementation.
pub fn probe_main() -> i32 {
    let arguments: Vec<_> = std::env::args_os().collect();
    match arguments.get(1).map(|argument| argument.as_bytes()) {
        Some(b"parse") => {
            for argument in &arguments[2..] {
                let value = CString::new(argument.as_bytes()).expect("argv cannot contain NUL");
                match parse_port(&value) {
                    Some(port) => println!("{port}"),
                    None => println!("invalid"),
                }
            }
            0
        }
        Some(b"relay") if arguments.len() == 2 => {
            if relay_streams(3, 4).is_ok() {
                0
            } else {
                1
            }
        }
        Some(b"privileges") if arguments.len() == 2 => {
            if drop_process_privileges().is_err() {
                return 1;
            }
            let header = CapabilityHeader {
                version: 0x2008_0522,
                pid: 0,
            };
            let mut capabilities = [CapabilityData {
                effective: 0,
                permitted: 0,
                inheritable: 0,
            }; 2];
            if unsafe { libc::syscall(libc::SYS_capget, &header, capabilities.as_mut_ptr()) } < 0 {
                return 1;
            }
            println!(
                "dumpable={} no_new_privs={}",
                unsafe { libc::prctl(libc::PR_GET_DUMPABLE) },
                unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) }
            );
            for capability in capabilities {
                println!(
                    "{}:{}:{}",
                    capability.effective, capability.permitted, capability.inheritable
                );
            }
            0
        }
        Some(b"serve") if arguments.len() == 3 => {
            let value = CString::new(arguments[2].as_bytes()).expect("argv cannot contain NUL");
            let Some(port) = parse_port(&value) else {
                return 64;
            };
            probe_serve(port).unwrap_or(1)
        }
        _ => {
            eprintln!("usage: pi-tcp-gateway-probe parse [PORT...] | relay");
            64
        }
    }
}

fn probe_serve(broker_port: u16) -> Result<i32, ()> {
    // Only listener setup differs from production. This loopback socket needs no
    // IP_TRANSPARENT privilege; endpoint framing, fork/accounting, signals, privilege
    // dropping, pdeathsig, and relaying all use the production code above.
    let listener = socket(libc::AF_INET)?;
    set_close_on_exec(listener.as_raw_fd())?;
    let mut address: libc::sockaddr_in = unsafe { zeroed() };
    address.sin_family = libc::AF_INET as libc::sa_family_t;
    address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
    let mut length = size_of::<libc::sockaddr_in>() as libc::socklen_t;
    if unsafe {
        libc::bind(
            listener.as_raw_fd(),
            (&address as *const libc::sockaddr_in).cast(),
            length,
        )
    } < 0
    {
        return Err(());
    }
    if unsafe {
        libc::getsockname(
            listener.as_raw_fd(),
            (&mut address as *mut libc::sockaddr_in).cast(),
            &mut length,
        )
    } < 0
    {
        return Err(());
    }
    if unsafe { libc::listen(listener.as_raw_fd(), 128) } < 0 {
        return Err(());
    }
    install_signal_handlers()?;
    drop_process_privileges()?;
    println!("{PREFIX}\tREADY\t{}", u16::from_be(address.sin_port));
    io::stdout().flush().map_err(|_| ())?;
    Ok(serve_listeners(
        &[listener.as_raw_fd()],
        &address.sin_addr,
        broker_port,
    ))
}
