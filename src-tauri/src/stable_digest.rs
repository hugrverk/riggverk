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

pub fn directory(path: &Path) -> Result<String, String> {
    crate::safe_filesystem::reject_nested_symlinks(path, "digest directory")?;
    let mut entries = Vec::new();
    collect(path, path, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    for (relative, entry, is_dir) in entries {
        hash.update(if is_dir { b"d" } else { b"f" });
        hash.update((relative.len() as u64).to_be_bytes());
        hash.update(relative.as_bytes());
        if !is_dir {
            let content = fs::read(&entry).map_err(|e| format!("read {}: {e}", entry.display()))?;
            hash.update((content.len() as u64).to_be_bytes());
            hash.update(content);
        }
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

fn collect(
    root: &Path,
    current: &Path,
    output: &mut Vec<(String, std::path::PathBuf, bool)>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|e| format!("read {}: {e}", current.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read directory entry: {e}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let kind = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if kind.is_symlink() {
            return Err(format!("refusing symlink: {}", entry.path().display()));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("relative digest path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        output.push((relative, entry.path(), kind.is_dir()));
        if kind.is_dir() {
            collect(root, &entry.path(), output)?;
        }
    }
    Ok(())
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("stable-digest-{label}-{nonce}"))
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
    fn directory_digest_is_independent_of_creation_order() {
        let first = temp("first");
        let second = temp("second");
        fs::create_dir_all(first.join("nested")).expect("first");
        fs::create_dir_all(second.join("nested")).expect("second");
        fs::write(first.join("a.txt"), "a").expect("a");
        fs::write(first.join("nested/b.txt"), "b").expect("b");
        fs::write(second.join("nested/b.txt"), "b").expect("b");
        fs::write(second.join("a.txt"), "a").expect("a");
        assert_eq!(directory(&first).unwrap(), directory(&second).unwrap());
        fs::write(second.join("a.txt"), "changed").expect("changed");
        assert_ne!(directory(&first).unwrap(), directory(&second).unwrap());
        let _ = fs::remove_dir_all(first);
        let _ = fs::remove_dir_all(second);
    }

    #[cfg(unix)]
    #[test]
    fn directory_digest_rejects_nested_symlinks() {
        let root = temp("symlink");
        fs::create_dir_all(&root).expect("root");
        std::os::unix::fs::symlink(root.join("missing"), root.join("link")).expect("symlink");
        assert!(directory(&root).unwrap_err().contains("symlink"));
        let _ = fs::remove_dir_all(root);
    }
}
