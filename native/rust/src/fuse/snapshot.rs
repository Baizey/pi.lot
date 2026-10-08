use super::*;

pub(super) const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Access {
    Read = 1,
    Write = 2,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Allow = 1,
    Deny = 2,
}
#[derive(Debug, PartialEq, Eq)]
struct Rule {
    layer: u32,
    access: Access,
    decision: Decision,
    path: Vec<u8>,
}
// Equality is logical snapshot identity: reserved wire bytes are discarded,
// but rule order remains significant for equal-specificity matching ties.
#[derive(Default, Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub revision: u64,
    rules: Vec<Rule>,
    maximum_layer: u32,
}

impl Snapshot {
    pub fn parse(bytes: &[u8]) -> Result<Self, i32> {
        let invalid = || {
            set_errno(libc::EINVAL);
            -1
        };
        if bytes.len() < 20 || bytes.len() > MAX_SNAPSHOT_BYTES || &bytes[..8] != b"PILOTNP2" {
            return Err(invalid());
        }
        let count = u32_at(bytes, 16) as usize;
        if count > (bytes.len() - 20) / 12 {
            return Err(invalid());
        }
        let mut parsed = Self {
            revision: u64_at(bytes, 8),
            rules: Vec::with_capacity(count),
            maximum_layer: 0,
        };
        let mut offset = 20;
        for _ in 0..count {
            if bytes.len() - offset < 12 {
                return Err(invalid());
            }
            let layer = u32_at(bytes, offset);
            let access = match bytes[offset + 4] {
                1 => Access::Read,
                2 => Access::Write,
                _ => return Err(invalid()),
            };
            let decision = match bytes[offset + 5] {
                1 => Decision::Allow,
                2 => Decision::Deny,
                _ => return Err(invalid()),
            };
            let length = u32_at(bytes, offset + 8) as usize;
            offset += 12;
            if length == 0 || length >= PATH_MAX || bytes.len() - offset < length || layer >= 64 {
                return Err(invalid());
            }
            let path = &bytes[offset..offset + length];
            if path[0] != b'/' || path.contains(&0) {
                return Err(invalid());
            }
            parsed.rules.push(Rule {
                layer,
                access,
                decision,
                path: path.to_vec(),
            });
            parsed.maximum_layer = parsed.maximum_layer.max(layer);
            offset += length;
        }
        if offset != bytes.len() {
            return Err(invalid());
        }
        Ok(parsed)
    }
    pub fn evaluate(&self, path: &[u8], access: Access) -> Option<Decision> {
        for layer in 0..=self.maximum_layer {
            let mut best: Option<&Rule> = None;
            for rule in &self.rules {
                if rule.layer == layer
                    && rule.access == access
                    && same_or_child(path, &rule.path)
                    && best.is_none_or(|prior| rule.path.len() > prior.path.len())
                {
                    best = Some(rule);
                }
            }
            if let Some(rule) = best {
                return Some(rule.decision);
            }
        }
        None
    }
    // Use the same stdio sequence as the C implementation, including fstat before reading.
    pub fn load(path: &CStr) -> Result<(Self, libc::stat), i32> {
        unsafe {
            let input = libc::fopen(path.as_ptr(), c"rb".as_ptr());
            if input.is_null() {
                return Err(-1);
            }
            let file = Stdio(input);
            let mut status = std::mem::zeroed();
            if libc::fstat(libc::fileno(input), &mut status) != 0
                || libc::fseek(input, 0, libc::SEEK_END) != 0
            {
                return Err(-1);
            }
            let size = libc::ftell(input);
            if size < 0 || size as usize > MAX_SNAPSHOT_BYTES {
                set_errno(libc::EINVAL);
                return Err(-1);
            }
            if libc::fseek(input, 0, libc::SEEK_SET) != 0 {
                return Err(-1);
            }
            let mut bytes = vec![0; size as usize];
            if libc::fread(bytes.as_mut_ptr().cast(), 1, bytes.len(), input) != bytes.len() {
                return Err(-1);
            }
            std::mem::forget(file);
            if libc::fclose(input) != 0 {
                return Err(-1);
            }
            Ok((Self::parse(&bytes)?, status))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded(rules: &[(u32, u8, u8, &[u8])]) -> Vec<u8> {
        let mut b = b"PILOTNP2".to_vec();
        b.extend(7u64.to_le_bytes());
        b.extend((rules.len() as u32).to_le_bytes());
        for (layer, access, decision, path) in rules {
            b.extend(layer.to_le_bytes());
            b.extend([*access, *decision, 255, 255]);
            b.extend((path.len() as u32).to_le_bytes());
            b.extend(*path);
        }
        b
    }
    #[test]
    fn precedence_and_byte_paths() {
        let b = encoded(&[
            (1, 1, 2, b"/a/b"),
            (0, 1, 1, b"/a"),
            (0, 1, 2, b"/a/\xff"),
            (0, 1, 1, b"/a/\xff"),
        ]);
        let s = Snapshot::parse(&b).unwrap();
        assert_eq!(s.evaluate(b"/a/b", Access::Read), Some(Decision::Allow));
        assert_eq!(
            s.evaluate(b"/a/\xff/file", Access::Read),
            Some(Decision::Deny)
        );
        assert_eq!(s.evaluate(b"/ab", Access::Read), None);
        assert_eq!(s.evaluate(b"/a", Access::Write), None);
    }
    #[test]
    fn snapshot_identity_includes_all_authority_fields_and_order() {
        let original = encoded(&[(0, 1, 1, b"/a"), (0, 1, 2, b"/b")]);
        let expected = Snapshot::parse(&original).unwrap();
        let mut reserved = original.clone();
        reserved[26..28].copy_from_slice(&[0, 0]);
        assert_eq!(Snapshot::parse(&reserved).unwrap(), expected);
        for changed in [
            encoded(&[(1, 1, 1, b"/a"), (0, 1, 2, b"/b")]),
            encoded(&[(0, 2, 1, b"/a"), (0, 1, 2, b"/b")]),
            encoded(&[(0, 1, 2, b"/a"), (0, 1, 2, b"/b")]),
            encoded(&[(0, 1, 1, b"/c"), (0, 1, 2, b"/b")]),
            encoded(&[(0, 1, 2, b"/b"), (0, 1, 1, b"/a")]),
            encoded(&[(0, 1, 1, b"/a")]),
        ] {
            assert_ne!(Snapshot::parse(&changed).unwrap(), expected);
        }
        let mut changed_revision = original;
        changed_revision[8..16].copy_from_slice(&8u64.to_le_bytes());
        assert_ne!(Snapshot::parse(&changed_revision).unwrap(), expected);
    }
    #[test]
    fn malformed_snapshots() {
        let valid = encoded(&[(0, 1, 1, b"/")]);
        for end in 0..valid.len() {
            assert!(Snapshot::parse(&valid[..end]).is_err());
        }
        for rule in [
            (64, 1, 1, &b"/"[..]),
            (0, 3, 1, &b"/"[..]),
            (0, 1, 3, &b"/"[..]),
            (0, 1, 1, &b"relative"[..]),
            (0, 1, 1, &b"/\0"[..]),
        ] {
            assert!(Snapshot::parse(&encoded(&[rule])).is_err());
        }
        let mut trailing = valid;
        trailing.push(0);
        assert!(Snapshot::parse(&trailing).is_err());
    }
}
