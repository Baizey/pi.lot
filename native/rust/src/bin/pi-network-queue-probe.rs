//! Mount-free probe protocol: P <hex>, V <sequence> <dns:0|1> <hex>.
use pilot_native::network_queue::{parse_packet, parse_verdict};
use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            std::process::exit(64)
        };
        let fields: Vec<_> = line.split(' ').collect();
        match fields.as_slice() {
            ["P", hex] => {
                let Some(bytes) = decode_hex(hex) else {
                    std::process::exit(64)
                };
                match parse_packet(&bytes) {
                    Some(packet) => print!("{}", packet.event(1)),
                    None => println!("DROP"),
                }
            }
            ["V", sequence, dns, hex] => {
                let Ok(sequence) = sequence.parse::<u64>() else {
                    std::process::exit(64)
                };
                let dns = match *dns {
                    "0" => false,
                    "1" => true,
                    _ => std::process::exit(64),
                };
                let Some(bytes) = decode_hex(hex) else {
                    std::process::exit(64)
                };
                match parse_verdict(sequence, dns, &bytes) {
                    Some(mark) => println!("MARK {mark}"),
                    None => println!("INVALID"),
                }
            }
            _ => std::process::exit(64),
        }
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16)?;
            let low = char::from(pair[1]).to_digit(16)?;
            Some((high * 16 + low) as u8)
        })
        .collect()
}
