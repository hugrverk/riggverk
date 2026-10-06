//! Per-file "I manage this rules file myself" choices.
//!
//! A rules file the user edited by hand is a conflict the app refuses to
//! resolve on its own. The user can leave it as is: the choice is recorded
//! here, and the file then reports base updates without raising a conflict.
//! Nothing in this file lets the app write to a rules file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::ArtifactId;
use crate::managed_state::artifact_identity;

pub const RULES_PREFERENCES_REL: &str = ".agent-workspace/rules-preferences.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 16 * 1024;

#[derive(Debug, Default, Serialize, Deserialize)]
struct RulesPreferences {
    #[serde(default)]
    schema_version: u32,
    /// Artifact identities of the rules files the user manages.
    #[serde(default)]
    user_managed: Vec<String>,
}

fn preferences_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(RULES_PREFERENCES_REL)
}

/// An unreadable, oversized, or unsupported file counts as "no choices": the
/// file then keeps reporting its conflict, which is the safe default.
fn read_preferences(workspace_root: &Path) -> RulesPreferences {
    let path = preferences_path(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "rules preferences")
        .is_err()
        || crate::path_safety::reject_symlink(&path, "rules preferences").is_err()
    {
        return RulesPreferences::default();
    }
    let Ok(meta) = fs::metadata(&path) else {
        return RulesPreferences::default();
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return RulesPreferences::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RulesPreferences>(&raw).ok())
        .filter(|preferences| preferences.schema_version == SCHEMA_VERSION)
        .unwrap_or_default()
}

/// Whether the user chose to manage this rules file themselves.
pub fn is_user_managed(workspace_root: &Path, artifact: &ArtifactId) -> bool {
    if !artifact.is_rules_block() {
        return false;
    }
    let identity = artifact_identity(artifact);
    read_preferences(workspace_root)
        .user_managed
        .contains(&identity)
}

/// Record or clear the choice. Writes only the preferences file.
pub fn set_user_managed(
    workspace_root: &Path,
    artifact: &ArtifactId,
    user_managed: bool,
) -> Result<(), String> {
    if !artifact.is_rules_block() {
        return Err("only rules files can be user managed".to_string());
    }
    let identity = artifact_identity(artifact);
    let mut preferences = read_preferences(workspace_root);
    let present = preferences.user_managed.contains(&identity);
    if present == user_managed {
        return Ok(());
    }
    if user_managed {
        preferences.user_managed.push(identity);
    } else {
        preferences.user_managed.retain(|entry| entry != &identity);
    }
    preferences.user_managed.sort();
    preferences.schema_version = SCHEMA_VERSION;
    let raw = serde_json::to_vec_pretty(&preferences)
        .map_err(|e| format!("serialize rules preferences: {e}"))?;
    crate::safe_filesystem::write_regular_file_atomic(
        &preferences_path(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|e| format!("write rules preferences: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-rules-prefs-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn choices_round_trip_per_artifact() {
        let ws = temp("roundtrip");
        assert!(!is_user_managed(&ws, &ArtifactId::ClaudeRules));
        set_user_managed(&ws, &ArtifactId::ClaudeRules, true).unwrap();
        assert!(is_user_managed(&ws, &ArtifactId::ClaudeRules));
        assert!(!is_user_managed(&ws, &ArtifactId::CodexRules));
        set_user_managed(&ws, &ArtifactId::CodexRules, true).unwrap();
        set_user_managed(&ws, &ArtifactId::ClaudeRules, false).unwrap();
        assert!(!is_user_managed(&ws, &ArtifactId::ClaudeRules));
        assert!(is_user_managed(&ws, &ArtifactId::CodexRules));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn only_rules_files_can_be_user_managed() {
        let ws = temp("kinds");
        assert!(set_user_managed(&ws, &ArtifactId::CodexConfig, true).is_err());
        assert!(!is_user_managed(&ws, &ArtifactId::CodexConfig));
        assert!(!preferences_path(&ws).exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unreadable_or_foreign_files_mean_no_choices() {
        let ws = temp("garbage");
        let path = preferences_path(&ws);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "not json").unwrap();
        assert!(!is_user_managed(&ws, &ArtifactId::ClaudeRules));
        let identity = artifact_identity(&ArtifactId::ClaudeRules);
        fs::write(
            &path,
            format!("{{\"schema_version\": 99, \"user_managed\": [{identity:?}]}}"),
        )
        .unwrap();
        assert!(!is_user_managed(&ws, &ArtifactId::ClaudeRules));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn setting_the_same_choice_twice_writes_nothing_new() {
        let ws = temp("idempotent");
        set_user_managed(&ws, &ArtifactId::OpenCodeRules, false).unwrap();
        assert!(!preferences_path(&ws).exists());
        set_user_managed(&ws, &ArtifactId::OpenCodeRules, true).unwrap();
        let first = fs::read(preferences_path(&ws)).unwrap();
        set_user_managed(&ws, &ArtifactId::OpenCodeRules, true).unwrap();
        assert_eq!(fs::read(preferences_path(&ws)).unwrap(), first);
        let _ = fs::remove_dir_all(&ws);
    }
}
