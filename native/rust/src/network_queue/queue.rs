//! The only NFQUEUE boundary: borrowed packet bytes are parsed by safe Rust.
use super::{parse_packet, read_verdict, write_record, Packet, PROTOCOL_PREFIX};
use libc::{c_char, c_int, c_uint, c_void};
use std::ffi::CStr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

// Handles are opaque and remain owned by QueueSession, never by the callback.
type Handle = c_void;
type Queue = c_void;
type Data = c_void;
#[repr(C, packed)]
struct PacketHeader {
    packet_id: u32,
    hardware_protocol: u16,
    hook: u8,
}
type Callback = unsafe extern "C" fn(*mut Queue, *mut c_void, *mut Data, *mut c_void) -> c_int;

extern "C" {
    fn nfq_open() -> *mut Handle;
    fn nfq_close(handle: *mut Handle) -> c_int;
    fn nfq_bind_pf(handle: *mut Handle, family: u16) -> c_int;
    fn nfq_create_queue(
        handle: *mut Handle,
        number: u16,
        callback: Callback,
        context: *mut c_void,
    ) -> *mut Queue;
    fn nfq_destroy_queue(queue: *mut Queue) -> c_int;
    fn nfq_set_mode(queue: *mut Queue, mode: u8, range: c_uint) -> c_int;
    fn nfq_set_queue_maxlen(queue: *mut Queue, length: c_uint) -> c_int;
    fn nfq_set_queue_flags(queue: *mut Queue, mask: c_uint, flags: c_uint) -> c_int;
    fn nfq_fd(handle: *mut Handle) -> c_int;
    fn nfq_handle_packet(handle: *mut Handle, buffer: *mut c_char, length: c_int) -> c_int;
    fn nfq_get_msg_packet_hdr(data: *mut Data) -> *mut PacketHeader;
    fn nfq_get_payload(data: *mut Data, payload: *mut *mut u8) -> c_int;
    fn nfq_set_verdict(
        queue: *mut Queue,
        id: u32,
        verdict: u32,
        length: u32,
        payload: *const u8,
    ) -> c_int;
    fn nfq_set_verdict2(
        queue: *mut Queue,
        id: u32,
        verdict: u32,
        mark: u32,
        length: u32,
        payload: *const u8,
    ) -> c_int;
    static mut stdout: *mut libc::FILE;
}

#[derive(Default)]
struct Context {
    sequence: u64,
    failed: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum ProtocolError {
    SequenceExhausted,
    EventWrite,
    VerdictRead,
}
impl ProtocolError {
    fn message(&self) -> &'static str {
        match self {
            Self::SequenceExhausted => "event sequence exhausted",
            Self::EventWrite => "failed to send policy event",
            Self::VerdictRead => "invalid or closed verdict stream",
        }
    }
}
impl Context {
    fn request_verdict(
        &mut self,
        packet: &Packet,
        send: impl FnOnce(&str) -> std::io::Result<()>,
        receive: impl FnOnce(u64, bool) -> Option<u32>,
    ) -> Result<u32, ProtocolError> {
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or(ProtocolError::SequenceExhausted)?;
        self.sequence = sequence;
        send(&packet.event(sequence)).map_err(|_| ProtocolError::EventWrite)?;
        receive(sequence, packet.dns.is_some()).ok_or(ProtocolError::VerdictRead)
    }
}

struct QueueSession {
    handle: *mut Handle,
    queue: *mut Queue,
}
impl Drop for QueueSession {
    fn drop(&mut self) {
        // Queue callbacks run synchronously inside nfq_handle_packet. No callback
        // can retain the context or packet beyond that call.
        unsafe {
            if !self.queue.is_null() {
                nfq_destroy_queue(self.queue);
            }
            nfq_close(self.handle);
        }
    }
}

pub(super) fn run() -> i32 {
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        if libc::setvbuf(stdout, ptr::null_mut(), libc::_IOLBF, 0) != 0 {
            report_errno("configure protocol output");
            return 1;
        }
    }
    let handle = unsafe { nfq_open() };
    if handle.is_null() {
        report("nfq_open failed");
        return 1;
    }
    // Declare the context first so the session is always destroyed before it.
    let mut context = Box::<Context>::default();
    let mut session = QueueSession {
        handle,
        queue: ptr::null_mut(),
    };
    if unsafe {
        nfq_bind_pf(handle, libc::AF_INET as u16) < 0
            || nfq_bind_pf(handle, libc::AF_INET6 as u16) < 0
    } {
        report("failed to bind IPv4 and IPv6 network queue families");
        return 1;
    }
    // Box keeps the callback context stable across calls into the C library.
    session.queue =
        unsafe { nfq_create_queue(handle, 0, callback, (&mut *context as *mut Context).cast()) };
    if session.queue.is_null() {
        report("nfq_create_queue failed");
        return 1;
    }
    let queue = session.queue;
    if unsafe {
        nfq_set_mode(queue, 2, 0xffff) < 0
            || nfq_set_queue_maxlen(queue, 128) < 0
            || nfq_set_queue_flags(queue, 1, 0) < 0
    } {
        report("failed to configure fail-closed packet queue");
        drop(session);
        return 1;
    }
    if unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong) < 0
            || libc::prctl(
                libc::PR_SET_NO_NEW_PRIVS,
                1 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            ) < 0
    } {
        report_errno("harden queue helper process");
        drop(session);
        return 1;
    }
    if let Err(error) = write_record(format!("{PROTOCOL_PREFIX}\tREADY\n").as_bytes()) {
        report_io("send readiness record", &error);
        drop(session);
        return 1;
    }
    let fd = unsafe { nfq_fd(handle) };
    // Netlink messages must be suitably aligned, as in the original C buffer.
    let mut buffer = vec![0u64; (128 * 1024) / 8];
    while !context.failed {
        let received = unsafe { libc::recv(fd, buffer.as_mut_ptr().cast(), 128 * 1024, 0) };
        if received < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            report_errno("receive queued packet");
            context.failed = true;
            break;
        }
        if received == 0 {
            report("netlink queue closed unexpectedly");
            context.failed = true;
            break;
        }
        if unsafe { nfq_handle_packet(handle, buffer.as_mut_ptr().cast(), received as c_int) } < 0 {
            report("failed to process queued packet");
            context.failed = true;
            break;
        }
    }
    drop(session);
    i32::from(context.failed)
}

unsafe extern "C" fn callback(
    queue: *mut Queue,
    _: *mut c_void,
    data: *mut Data,
    opaque: *mut c_void,
) -> c_int {
    // Catch every Rust panic at the ABI boundary, then drop the current packet
    // and stop receiving. A panic must never unwind into libnetfilter_queue.
    match catch_unwind(AssertUnwindSafe(|| {
        process_packet(queue, data, &mut *opaque.cast::<Context>())
    })) {
        Ok(result) => result,
        Err(_) => {
            let context = &mut *opaque.cast::<Context>();
            context.failed = true;
            report("packet callback panicked");
            if let Some(id) = packet_id(data) {
                if drop_packet(queue, id) < 0 {
                    report("failed to drop packet after protocol error");
                }
            }
            -1
        }
    }
}

unsafe fn process_packet(queue: *mut Queue, data: *mut Data, context: &mut Context) -> c_int {
    let Some(id) = packet_id(data) else {
        context.failed = true;
        report("queued packet has no packet header");
        return -1;
    };
    let mut payload = ptr::null_mut();
    let length = nfq_get_payload(data, &mut payload);
    if length < 1 || payload.is_null() {
        return drop_packet(queue, id);
    }
    // libnetfilter_queue owns this contiguous payload until the callback returns.
    let bytes = std::slice::from_raw_parts(payload, length as usize);
    let Some(packet) = parse_packet(bytes) else {
        return drop_packet(queue, id);
    };
    let mark = match context.request_verdict(
        &packet,
        |event| write_record(event.as_bytes()),
        |sequence, dns| read_verdict(&mut std::io::stdin().lock(), sequence, dns),
    ) {
        Ok(mark) => mark,
        Err(error) => return protocol_failure(context, queue, id, error.message()),
    };
    if nfq_set_verdict2(queue, id, 4, mark, 0, ptr::null()) < 0 {
        context.failed = true;
        report("failed to return packet verdict");
        return -1;
    }
    0
}

unsafe fn packet_id(data: *mut Data) -> Option<u32> {
    let header = nfq_get_msg_packet_hdr(data);
    if header.is_null() {
        None
    } else {
        Some(u32::from_be(
            ptr::addr_of!((*header).packet_id).read_unaligned(),
        ))
    }
}

unsafe fn drop_packet(queue: *mut Queue, id: u32) -> c_int {
    nfq_set_verdict(queue, id, 0, 0, ptr::null())
}

unsafe fn protocol_failure(
    context: &mut Context,
    queue: *mut Queue,
    id: u32,
    message: &str,
) -> c_int {
    report(message);
    if drop_packet(queue, id) < 0 {
        report("failed to drop packet after protocol error");
    }
    context.failed = true;
    -1
}

fn report(message: &str) {
    // Avoid panicking even when stderr is closed, including during panic cleanup.
    use std::io::Write;
    let _ = writeln!(std::io::stderr().lock(), "pi-network-queue: {message}");
}
fn report_errno(message: &str) {
    report_io(message, &std::io::Error::last_os_error());
}
fn report_io(message: &str, error: &std::io::Error) {
    let description = error
        .raw_os_error()
        .map(|errno| unsafe {
            CStr::from_ptr(libc::strerror(errno))
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_else(|| error.to_string());
    report(&format!("{message}: {description}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_queue::{
        DnsQuery, Family, Transport, ALLOW_PACKET_MARK, DNS_DENY_PACKET_MARK,
    };
    use std::cell::RefCell;

    fn packet() -> Packet {
        Packet {
            family: Family::Ipv4,
            transport: Transport::Tcp,
            source_address: "192.0.2.1".into(),
            destination_address: "198.51.100.2".into(),
            source_port: 1234,
            destination_port: 443,
            dns: None,
        }
    }

    #[test]
    fn sequence_and_send_before_receive() {
        let mut context = Context::default();
        let calls = RefCell::new(Vec::new());
        for expected_sequence in 1..=3 {
            let result = context.request_verdict(&packet(), |event| {
                assert_eq!(event, format!("PI_NETWORK_QUEUE\t3\tEVENT\t{expected_sequence}\tIPV4\ttcp\t192.0.2.1\t1234\t198.51.100.2\t443\n"));
                calls.borrow_mut().push("send");
                Ok(())
            }, |sequence, dns| {
                assert_eq!(sequence, expected_sequence);
                assert!(!dns);
                assert_eq!(calls.borrow().last(), Some(&"send"));
                calls.borrow_mut().push("receive");
                Some(ALLOW_PACKET_MARK)
            });
            assert_eq!(result, Ok(ALLOW_PACKET_MARK));
            assert_eq!(context.sequence, expected_sequence);
        }
        assert_eq!(
            *calls.borrow(),
            ["send", "receive", "send", "receive", "send", "receive"]
        );
    }

    #[test]
    fn last_sequence_is_emitted_then_exhaustion_produces_no_io() {
        let mut context = Context {
            sequence: u64::MAX - 1,
            failed: false,
        };
        assert_eq!(
            context.request_verdict(
                &packet(),
                |event| {
                    assert!(event.contains("\t18446744073709551615\t"));
                    Ok(())
                },
                |sequence, _| {
                    assert_eq!(sequence, u64::MAX);
                    Some(ALLOW_PACKET_MARK)
                }
            ),
            Ok(ALLOW_PACKET_MARK)
        );
        assert_eq!(
            context.request_verdict(
                &packet(),
                |_| panic!("exhaustion must not emit"),
                |_, _| panic!("exhaustion must not read")
            ),
            Err(ProtocolError::SequenceExhausted)
        );
        assert_eq!(context.sequence, u64::MAX);
    }

    #[test]
    fn output_failure_never_reads_a_verdict_and_preserves_increment() {
        let mut context = Context::default();
        assert_eq!(
            context.request_verdict(
                &packet(),
                |_| Err(std::io::Error::from_raw_os_error(libc::EPIPE)),
                |_, _| panic!("failed output must not read")
            ),
            Err(ProtocolError::EventWrite)
        );
        assert_eq!(context.sequence, 1);
        assert_eq!(
            ProtocolError::EventWrite.message(),
            "failed to send policy event"
        );
    }

    #[test]
    fn verdict_failure_and_dns_mark_selection() {
        let mut context = Context::default();
        assert_eq!(
            context.request_verdict(&packet(), |_| Ok(()), |_, _| None),
            Err(ProtocolError::VerdictRead)
        );
        assert_eq!(context.sequence, 1);
        let mut query = packet();
        query.transport = Transport::Udp;
        query.destination_port = 53;
        query.dns = Some(DnsQuery {
            name: "example.com".into(),
            query_type: 28,
        });
        let record = b"PI_NETWORK_QUEUE\t3\tVERDICT\t2\tDENY\n";
        assert_eq!(
            context.request_verdict(
                &query,
                |event| {
                    assert!(event.ends_with("\tDNS\texample.com\t28\n"));
                    Ok(())
                },
                |sequence, dns| super::super::parse_verdict(sequence, dns, record)
            ),
            Ok(DNS_DENY_PACKET_MARK)
        );
        assert_eq!(context.sequence, 2);
    }
}
