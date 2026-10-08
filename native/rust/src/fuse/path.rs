use super::*;

pub(super) fn same_or_child(candidate: &[u8], parent: &[u8]) -> bool {
    candidate.starts_with(parent)
        && (candidate.len() == parent.len()
            || parent.last() == Some(&b'/')
            || candidate.get(parent.len()) == Some(&b'/'))
}
pub(super) fn normalize(input: &[u8]) -> Result<CString, i32> {
    if input.first() != Some(&b'/') || input.len() >= PATH_MAX {
        return Err(-libc::EPERM);
    }
    let mut segments: Vec<&[u8]> = Vec::new();
    for segment in input.split(|c| *c == b'/') {
        match segment {
            b"" | b"." => {}
            b".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    let mut out = vec![b'/'];
    for segment in segments {
        if out.len() > 1 {
            out.push(b'/');
        }
        if out.len() + segment.len() >= PATH_MAX {
            return Err(-libc::ENAMETOOLONG);
        }
        out.extend(segment);
    }
    Ok(cstring(&out))
}
pub(super) fn realpath(path: &CStr) -> Result<CString, i32> {
    let mut buffer = [0 as libc::c_char; PATH_MAX];
    if unsafe { libc::realpath(path.as_ptr(), buffer.as_mut_ptr()) }.is_null() {
        return Err(-errno());
    }
    Ok(unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_owned())
}
impl State {
    fn visible(&self, path: &CStr) -> Result<(), i32> {
        let bytes = path.to_bytes();
        if bytes.first() != Some(&b'/') {
            return Err(-libc::EPERM);
        }
        if bytes.len() >= PATH_MAX {
            return Err(-libc::ENAMETOOLONG);
        }
        if bytes != b"/"
            && bytes[1..]
                .split(|c| *c == b'/')
                .any(|s| s.is_empty() || s == b"." || s == b"..")
        {
            return Err(-libc::EPERM);
        }
        self.not_hidden(path)
    }
    fn not_hidden(&self, path: &CStr) -> Result<(), i32> {
        if same_or_child(path.to_bytes(), self.hidden_path.to_bytes()) {
            Err(-libc::ENOENT)
        } else {
            Ok(())
        }
    }
    pub fn existing(&self, path: &CStr) -> Result<CString, i32> {
        self.visible(path)?;
        let resolved = realpath(path)?;
        self.not_hidden(&resolved)?;
        Ok(resolved)
    }
    pub fn destination(&self, path: &CStr) -> Result<CString, i32> {
        self.visible(path)?;
        if path.to_bytes() == b"/" {
            return Err(-libc::EPERM);
        }
        let resolved = self.parent_resolved(path)?;
        self.not_hidden(&resolved)?;
        Ok(resolved)
    }
    fn parent_resolved(&self, path: &CStr) -> Result<CString, i32> {
        let b = path.to_bytes();
        let slash = b.iter().rposition(|v| *v == b'/').ok_or(-libc::EPERM)?;
        let parent = realpath(&cstring(if slash == 0 { b"/" } else { &b[..slash] }))?;
        let mut resolved = parent.to_bytes().to_vec();
        if resolved != b"/" {
            resolved.push(b'/');
        }
        resolved.extend(&b[slash + 1..]);
        if resolved.len() >= PATH_MAX {
            return Err(-libc::ENAMETOOLONG);
        }
        Ok(cstring(&resolved))
    }
    pub fn node(&self, path: &CStr) -> Result<CString, i32> {
        self.visible(path)?;
        let resolved = if path.to_bytes() == b"/" {
            cstring(b"/")
        } else {
            self.parent_resolved(path)?
        };
        self.not_hidden(&resolved)?;
        let mut st = unsafe { std::mem::zeroed() };
        cvt(unsafe { libc::lstat(resolved.as_ptr(), &mut st) })?;
        Ok(resolved)
    }
    pub fn mutable_node(&self, path: &CStr) -> Result<CString, i32> {
        let resolved = self.node(path)?;
        if resolved.to_bytes() == b"/" {
            Err(-libc::EPERM)
        } else {
            Ok(resolved)
        }
    }
    pub fn policy_path(&self, path: &CStr) -> Result<CString, i32> {
        self.visible(path)?;
        if path.to_bytes() == b"/" {
            return Ok(cstring(b"/"));
        }
        match realpath(path) {
            Ok(resolved) => {
                self.not_hidden(&resolved)?;
                Ok(resolved)
            }
            Err(_) => self.destination(path),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_is_byte_oriented() {
        assert_eq!(
            normalize(b"//a/./b/../../../../c/\xff\\/")
                .unwrap()
                .to_bytes(),
            b"/c/\xff\\"
        );
        assert_eq!(normalize(b"/a/..").unwrap().to_bytes(), b"/");
        assert_eq!(normalize(b"relative").unwrap_err(), -libc::EPERM);
        assert_eq!(normalize(&vec![b'/'; PATH_MAX]).unwrap_err(), -libc::EPERM);
    }
    #[test]
    fn scopes_preserve_separator_and_backslash() {
        assert!(same_or_child(b"/any", b"/"));
        assert!(same_or_child(b"/a/x", b"/a/"));
        assert!(!same_or_child(b"/ab", b"/a"));
        assert!(!same_or_child(b"/a\\", b"/a"));
    }
}
