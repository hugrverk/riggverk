use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const ABSENT: &str = "absent";

struct CachedDigest {
    mtime: SystemTime,
    len: u64,
    digest: String,
}

/// Memoized file digests keyed by (mtime, len). Status and preview flows hash
/// the same ~hundred artifact files on every navigation; re-hashing unchanged
/// files dominates that cost. An entry is reused only when both the modified
/// time and the length still match, so any write invalidates it.
static FILE_DIGEST_CACHE: Mutex<Option<HashMap<PathBuf, CachedDigest>>> = Mutex::new(None);

pub fn bytes(input: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(input);
    format!("sha256:{:x}", hash.finalize())
}

pub fn file(path: &Path) -> Result<String, String> {
    crate::path_safety::reject_symlink(path, "digest file")?;
    let stat = fs::metadata(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let fingerprint = stat.modified().ok().map(|mtime| (mtime, stat.len()));

    if let Some((mtime, len)) = fingerprint {
        if let Ok(guard) = FILE_DIGEST_CACHE.lock() {
            if let Some(cached) = guard.as_ref().and_then(|cache| cache.get(path)) {
                if cached.mtime == mtime && cached.len == len {
                    return Ok(cached.digest.clone());
                }
            }
        }
    }

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
    let digest = format!("sha256:{:x}", hash.finalize());

    if let Some((mtime, len)) = fingerprint {
        if let Ok(mut guard) = FILE_DIGEST_CACHE.lock() {
            guard.get_or_insert_with(HashMap::new).insert(
                path.to_path_buf(),
                CachedDigest {
                    mtime,
                    len,
                    digest: digest.clone(),
                },
            );
        }
    }
    Ok(digest)
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

    #[test]
    fn sha256_contract_is_stable() {
        assert_eq!(
            bytes(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(bytes(b"abc"), bytes(b"abd"));
    }
}
