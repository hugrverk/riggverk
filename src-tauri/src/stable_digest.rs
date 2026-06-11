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

    #[test]
    fn sha256_contract_is_stable() {
        assert_eq!(
            bytes(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(bytes(b"abc"), bytes(b"abd"));
    }
}
