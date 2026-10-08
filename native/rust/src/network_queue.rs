//! Fail-closed NFQUEUE helper. Packet and protocol parsing do not require a queue.
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr};

pub const PROTOCOL_PREFIX: &str = "PI_NETWORK_QUEUE\t3";
pub const ALLOW_PACKET_MARK: u32 = 0x5049_0001;
pub const DENY_PACKET_MARK: u32 = 0x5049_0002;
pub const DNS_ALLOW_PACKET_MARK: u32 = 0x5049_0004;
pub const DNS_DENY_PACKET_MARK: u32 = 0x5049_0005;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Ipv4,
    Ipv6,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Tcp,
    Udp,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsQuery {
    pub name: String,
    pub query_type: u16,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub family: Family,
    pub transport: Transport,
    pub source_address: String,
    pub destination_address: String,
    pub source_port: u16,
    pub destination_port: u16,
    pub dns: Option<DnsQuery>,
}

impl Packet {
    pub fn event(&self, sequence: u64) -> String {
        let family = match self.family {
            Family::Ipv4 => "IPV4",
            Family::Ipv6 => "IPV6",
        };
        let transport = match self.transport {
            Transport::Tcp => "tcp",
            Transport::Udp => "udp",
        };
        let mut event = format!(
            "{PROTOCOL_PREFIX}\tEVENT\t{sequence}\t{family}\t{transport}\t{}\t{}\t{}\t{}",
            self.source_address, self.source_port, self.destination_address, self.destination_port
        );
        if let Some(dns) = &self.dns {
            event.push_str(&format!("\tDNS\t{}\t{}", dns.name, dns.query_type));
        }
        event.push('\n');
        event
    }
}

/// A rejected packet produces no policy event and does not advance the sequence.
pub fn parse_packet(packet: &[u8]) -> Option<Packet> {
    let version = packet.first()? >> 4;
    let (family, protocol, source_address, destination_address, header) = match version {
        4 => {
            let ip = packet.get(..20)?;
            let header_length = usize::from(ip[0] & 15) * 4;
            let total_length = usize::from(be16(&ip[2..4]));
            if header_length < 20
                || header_length > packet.len()
                || total_length < header_length
                || total_length > packet.len()
                || be16(&ip[6..8]) & 0x3fff != 0
            {
                return None;
            }
            (
                Family::Ipv4,
                ip[9],
                Ipv4Addr::new(ip[12], ip[13], ip[14], ip[15]).to_string(),
                Ipv4Addr::new(ip[16], ip[17], ip[18], ip[19]).to_string(),
                &packet[header_length..total_length],
            )
        }
        6 => {
            let ip = packet.get(..40)?;
            let payload_length = usize::from(be16(&ip[4..6]));
            if payload_length == 0 {
                return None;
            }
            let payload = packet.get(40..40 + payload_length)?;
            (
                Family::Ipv6,
                ip[6],
                ipv6_address(&ip[8..24]),
                ipv6_address(&ip[24..40]),
                payload,
            )
        }
        _ => return None,
    };
    let transport = match protocol {
        6 => {
            let tcp = header.get(..20)?;
            let header_length = usize::from(tcp[12] >> 4) * 4;
            if header_length < 20 || header_length > header.len() || tcp[13] & 0x17 != 2 {
                return None;
            }
            Transport::Tcp
        }
        17 => {
            let udp = header.get(..8)?;
            let length = usize::from(be16(&udp[4..6]));
            if length < 8 || length > header.len() {
                return None;
            }
            Transport::Udp
        }
        _ => return None,
    };
    let source_port = be16(&header[..2]);
    let destination_port = be16(&header[2..4]);
    if source_port == 0 || destination_port == 0 {
        return None;
    }
    let dns = if transport == Transport::Udp && destination_port == 53 {
        let length = usize::from(be16(&header[4..6]));
        Some(parse_dns_query(&header[8..length])?)
    } else {
        None
    };
    Some(Packet {
        family,
        transport,
        source_address,
        destination_address,
        source_port,
        destination_port,
        dns,
    })
}

pub fn parse_dns_query(dns: &[u8]) -> Option<DnsQuery> {
    if dns.len() < 17 || be16(&dns[2..4]) & 0xf800 != 0 || be16(&dns[4..6]) != 1 {
        return None;
    }
    let mut input_offset = 12;
    let mut name = String::new();
    loop {
        let length = usize::from(*dns.get(input_offset)?);
        input_offset += 1;
        if length == 0 {
            break;
        }
        if length > 63 {
            return None;
        }
        let label = dns.get(input_offset..input_offset + length)?;
        if !name.is_empty() {
            name.push('.');
        }
        if name.len() + length >= 256 {
            return None;
        }
        for (index, &character) in label.iter().enumerate() {
            if !(character.is_ascii_alphanumeric() || character == b'-' || character == b'_')
                || ((index == 0 || index + 1 == length) && character == b'-')
            {
                return None;
            }
            name.push(char::from(character.to_ascii_lowercase()));
        }
        input_offset += length;
    }
    let question = dns.get(input_offset..input_offset + 4)?;
    let query_type = be16(&question[..2]);
    if name.is_empty() || be16(&question[2..4]) != 1 || query_type == 0 {
        return None;
    }
    Some(DnsQuery { name, query_type })
}

/// Match fgets(256) and the original exact, case-sensitive verdict protocol.
/// Bytes after the first newline belong to the next record, not this one.
pub fn parse_verdict(sequence: u64, dns: bool, bytes: &[u8]) -> Option<u32> {
    let limit = bytes.len().min(255);
    let newline = bytes[..limit].iter().position(|&byte| byte == b'\n')?;
    let mut line = &bytes[..newline];
    if line.last() == Some(&b'\r') {
        line = &line[..line.len() - 1];
    }
    let prefix = format!("{PROTOCOL_PREFIX}\tVERDICT\t{sequence}\t");
    let decision = line.strip_prefix(prefix.as_bytes())?;
    match (decision, dns) {
        (b"ALLOW", false) => Some(ALLOW_PACKET_MARK),
        (b"DENY", false) => Some(DENY_PACKET_MARK),
        (b"ALLOW", true) => Some(DNS_ALLOW_PACKET_MARK),
        (b"DENY", true) => Some(DNS_DENY_PACKET_MARK),
        _ => None,
    }
}

fn be16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn ipv6_address(bytes: &[u8]) -> String {
    let address = Ipv6Addr::from(<[u8; 16]>::try_from(bytes).expect("IPv6 address width"));
    // inet_ntop also prints IPv4-compatible (not just mapped) addresses dotted.
    if bytes[..12].iter().all(|&byte| byte == 0) && (bytes[12] != 0 || bytes[13] != 0) {
        return format!(
            "::{}",
            Ipv4Addr::new(bytes[12], bytes[13], bytes[14], bytes[15])
        );
    }
    address.to_string()
}

#[path = "network_queue/queue.rs"]
mod queue;
pub fn main() -> i32 {
    crate::process_signal::restore_closed_stdio();
    queue::run()
}

/// Read only the bytes fgets would consume, including its 255-byte bound.
fn read_verdict(reader: &mut impl Read, sequence: u64, dns: bool) -> Option<u32> {
    let mut record = Vec::with_capacity(255);
    for _ in 0..255 {
        let mut byte = [0];
        if reader.read(&mut byte).ok()? != 1 {
            return None;
        }
        record.push(byte[0]);
        if byte[0] == b'\n' {
            return parse_verdict(sequence, dns, &record);
        }
    }
    None
}

fn write_record(record: &[u8]) -> io::Result<()> {
    let mut output = io::stdout().lock();
    output.write_all(record)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn udp(payload: &[u8], destination: u16) -> Vec<u8> {
        let mut packet = vec![0; 28];
        packet[0] = 0x45;
        packet[9] = 17;
        packet[12..16].copy_from_slice(&[192, 0, 2, 1]);
        packet[16..20].copy_from_slice(&[198, 51, 100, 2]);
        packet[20..22].copy_from_slice(&1234u16.to_be_bytes());
        packet[22..24].copy_from_slice(&destination.to_be_bytes());
        packet[24..26].copy_from_slice(&((8 + payload.len()) as u16).to_be_bytes());
        packet.extend_from_slice(payload);
        let length = packet.len() as u16;
        packet[2..4].copy_from_slice(&length.to_be_bytes());
        packet
    }

    #[test]
    fn packet_and_event_contract() {
        let packet = udp(&[], 443);
        assert_eq!(
            parse_packet(&packet).unwrap().event(7),
            "PI_NETWORK_QUEUE\t3\tEVENT\t7\tIPV4\tudp\t192.0.2.1\t1234\t198.51.100.2\t443\n"
        );
        for length in 0..packet.len() {
            assert!(parse_packet(&packet[..length]).is_none());
        }
        for fragment in [1u16, 0x2000, 0x3fff] {
            let mut invalid = packet.clone();
            invalid[6..8].copy_from_slice(&fragment.to_be_bytes());
            assert!(parse_packet(&invalid).is_none());
        }
        let mut padded = packet.clone();
        padded.extend_from_slice(&[0; 20]);
        assert_eq!(parse_packet(&padded), parse_packet(&packet));
    }

    #[test]
    fn dns_contract() {
        let mut dns = vec![0; 12];
        dns[5] = 1;
        dns.extend_from_slice(b"\x03WWW\x07Example\x03COM\0\0\x1c\0\x01");
        let parsed = parse_packet(&udp(&dns, 53)).unwrap();
        assert_eq!(
            parsed.dns,
            Some(DnsQuery {
                name: "www.example.com".into(),
                query_type: 28
            })
        );
        for length in 0..dns.len() {
            assert!(parse_dns_query(&dns[..length]).is_none());
        }
        for bad in [b'-', b'.', b'/', 0, 128] {
            let mut invalid = dns.clone();
            invalid[13] = bad;
            assert!(parse_dns_query(&invalid).is_none());
        }
        dns[12] = 0xc0;
        assert!(parse_dns_query(&dns).is_none());
    }

    #[test]
    fn exact_verdicts_and_stream_consumption() {
        let allow = b"PI_NETWORK_QUEUE\t3\tVERDICT\t42\tALLOW\n";
        assert_eq!(parse_verdict(42, false, allow), Some(ALLOW_PACKET_MARK));
        assert_eq!(parse_verdict(42, true, allow), Some(DNS_ALLOW_PACKET_MARK));
        for bytes in [
            b"PI_NETWORK_QUEUE\t3\tVERDICT\t042\tALLOW\n".as_slice(),
            b"PI_NETWORK_QUEUE\t3\tVERDICT\t42\tallow\n",
            b"PI_NETWORK_QUEUE\t3\tVERDICT\t42\tALLOW \n",
            b"PI_NETWORK_QUEUE\t3\tVERDICT\t42\tALLOW\0\n",
            &allow[..allow.len() - 1],
        ] {
            assert_eq!(parse_verdict(42, false, bytes), None);
        }
        let mut stream = io::Cursor::new(
            [
                allow.as_slice(),
                b"PI_NETWORK_QUEUE\t3\tVERDICT\t43\tDENY\r\n",
            ]
            .concat(),
        );
        assert_eq!(
            read_verdict(&mut stream, 42, false),
            Some(ALLOW_PACKET_MARK)
        );
        assert_eq!(
            read_verdict(&mut stream, 43, true),
            Some(DNS_DENY_PACKET_MARK)
        );
        assert_eq!(read_verdict(&mut stream, 44, false), None);
    }

    #[test]
    fn inet_ntop_compatible_ipv6_text() {
        assert_eq!(ipv6_address(&Ipv6Addr::LOCALHOST.octets()), "::1");
        assert_eq!(
            ipv6_address(&"::192.0.2.1".parse::<Ipv6Addr>().unwrap().octets()),
            "::192.0.2.1"
        );
        assert_eq!(
            ipv6_address(&"::ffff:192.0.2.1".parse::<Ipv6Addr>().unwrap().octets()),
            "::ffff:192.0.2.1"
        );
    }
}
