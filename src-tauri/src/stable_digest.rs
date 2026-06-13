use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;

pub const ABSENT: &str = "absent";

pub fn bytes(input: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(input);
    format!("sha256:{:x}", hash.finalize())
}

pub fn file(path: &Path) -> Result<String, String> {
    crate::path_safety::reject_symlink(path, "digest file")?;
    let mut file = fs::File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 32768];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

pub fn valid(value: &str) -> bool {
    value == ABSENT
        || value
            .strip_prefix("sha256:")
            .is_some_and(|hex| hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(label: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-digest-{label}-{n}"))
    }

    fn restore_mtime(path: &Path, mtime: SystemTime) {
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap_or_else(|e| panic!("open {}: {e}", path.display()))
            .set_modified(mtime)
            .unwrap_or_else(|e| panic!("set mtime {}: {e}", path.display()));
    }

    fn overwrite_same_length(path: &Path, content: &[u8]) -> SystemTime {
        let meta =
            fs::metadata(path).unwrap_or_else(|e| panic!("metadata {}: {e}", path.display()));
        let mtime = meta.modified().unwrap();
        assert_eq!(
            meta.len(),
            content.len() as u64,
            "replacement content must match original length"
        );
        fs::write(path, content).unwrap();
        restore_mtime(path, mtime);
        let after = fs::metadata(path).unwrap();
        assert_eq!(after.len(), content.len() as u64);
        assert_eq!(after.modified().unwrap(), mtime);
        mtime
    }

    #[test]
    fn sha256_contract_is_stable() {
        assert_eq!(
            bytes(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(bytes(b"abc"), bytes(b"abd"));
    }

    #[test]
    fn file_digest_reflects_same_length_same_mtime_content_change() {
        let path = temp("same-len-mtime");
        fs::write(&path, b"0123456789").unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        let first = file(&path).unwrap();
        overwrite_same_length(&path, b"abcdefghij");
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
        let second = file(&path).unwrap();
        assert_ne!(
            first, second,
            "digest must reflect current bytes when length and mtime are unchanged"
        );
    }

    #[test]
    fn file_digest_does_not_reuse_digest_after_same_path_replacement() {
        let path = temp("replace-same-path");
        fs::write(&path, b"0123456789").unwrap();
        let first = file(&path).unwrap();
        overwrite_same_length(&path, b"abcdefghij");
        let second = file(&path).unwrap();
        assert_ne!(
            first, second,
            "replacing file content at the same path must produce a new digest"
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_digest_does_not_reuse_digest_after_atomic_replacement() {
        let path = temp("atomic-replace");
        fs::write(&path, b"0123456789").unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        let first = file(&path).unwrap();
        let tmp = path.with_extension("tmp-replace");
        fs::write(&tmp, b"abcdefghij").unwrap();
        fs::rename(&tmp, &path).unwrap();
        restore_mtime(&path, mtime);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
        let second = file(&path).unwrap();
        assert_ne!(
            first, second,
            "atomic replacement at the same path must produce a new digest"
        );
        let _ = fs::remove_file(&path);
    }
}
