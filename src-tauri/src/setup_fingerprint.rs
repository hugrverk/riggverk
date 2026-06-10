//! Preview fingerprint digests for setup artifacts.
//!
//! Source and installed managed digests are computed independently so preview
//! integrity detects divergence on either side.

use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::artifact_registry::{ArtifactId, ArtifactKind};
use crate::commands::cursor_profile::cursor_root;
use crate::commands::{
    extract_managed_codex_config, extract_managed_opencode_config, render_expected_opencode_config,
};
use crate::cursor_profile_paths::CursorProfilePaths;

pub const ABSENT_DIGEST: &str = "absent";

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(hash_bytes(&bytes))
}

fn hash_json_value(value: &serde_json::Value) -> Result<String, String> {
    let canonical = serde_json::to_string(value).map_err(|e| format!("serialize json: {e}"))?;
    Ok(hash_bytes(canonical.as_bytes()))
}

fn hash_toml_value(value: &toml::Value) -> String {
    hash_bytes(value.to_string().as_bytes())
}

fn artifact_kind(artifact: &ArtifactId) -> ArtifactKind {
    match artifact {
        ArtifactId::OpenCodeConfig | ArtifactId::CodexConfig => ArtifactKind::ConfigFile,
        ArtifactId::OpenCodeTui => ArtifactKind::TuiConfig,
        ArtifactId::OpenCodePlaywrightMcp => ArtifactKind::McpConfig,
        ArtifactId::OpenCodeRules | ArtifactId::CodexRules | ArtifactId::ClaudeRules => {
            ArtifactKind::RulesFile
        }
        ArtifactId::OpenCodeAgent(_)
        | ArtifactId::CodexAgent(_)
        | ArtifactId::ClaudeAgent(_)
        | ArtifactId::CursorAgent(_) => ArtifactKind::AgentFile,
        ArtifactId::OpenCodeSkill(_)
        | ArtifactId::CodexSkill(_)
        | ArtifactId::ClaudeSkill(_)
        | ArtifactId::CursorSkill(_) => ArtifactKind::SkillDir,
        ArtifactId::CursorMcp => ArtifactKind::McpConfig,
    }
}

fn require_source_path(artifact: &ArtifactId, workspace_root: &Path) -> Result<PathBuf, String> {
    artifact
        .resolve_source(workspace_root)
        .ok_or_else(|| format!("no canonical source for artifact {:?}", artifact))
}

fn opencode_playwright_mcp_dest(home: &Path) -> PathBuf {
    crate::commands::cursor_profile::default_playwright_mcp_config_path(home)
}

fn resolve_playwright_paths(home: &Path) -> Result<(PathBuf, PathBuf), String> {
    let browsers = crate::commands::cursor_profile::resolve_playwright_browsers_path(home)
        .ok_or_else(|| "cannot resolve PLAYWRIGHT_BROWSERS_PATH".to_string())?;
    let config = crate::commands::cursor_profile::default_playwright_mcp_config_path(home);
    Ok((config, browsers))
}

fn cursor_playwright_projection_from_template(
    workspace_root: &Path,
    home: &Path,
) -> Result<serde_json::Value, String> {
    let template_path = cursor_root(workspace_root).join("mcp/playwright.mcp.json");
    let template_content =
        fs::read_to_string(&template_path).map_err(|e| format!("read cursor mcp template: {e}"))?;
    let template_parsed: serde_json::Value = serde_json::from_str(&template_content)
        .map_err(|e| format!("parse cursor mcp template: {e}"))?;
    let (config_path, browsers_path) = resolve_playwright_paths(home)?;
    template_parsed
        .get("mcpServers")
        .and_then(|v| v.get("playwright"))
        .cloned()
        .map(|value| {
            crate::commands::cursor_profile::transform_playwright_template_value(
                &value,
                &config_path.to_string_lossy(),
                &browsers_path.to_string_lossy(),
            )
        })
        .ok_or_else(|| "cursor mcp template missing playwright entry".into())
}

fn cursor_playwright_projection_from_installed(
    paths: &CursorProfilePaths,
) -> Result<Option<serde_json::Value>, String> {
    if !paths.mcp_config.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&paths.mcp_config)
        .map_err(|e| format!("read cursor mcp config: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse cursor mcp config: {e}"))?;
    Ok(parsed
        .get("mcpServers")
        .and_then(|v| v.get("playwright"))
        .cloned())
}

/// Hash canonical source content for an artifact. Missing source is an error.
pub fn artifact_source_digest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    match artifact_kind(artifact) {
        ArtifactKind::RulesFile | ArtifactKind::AgentFile => {
            let source = require_source_path(artifact, workspace_root)?;
            hash_file(&source)
        }
        ArtifactKind::SkillDir => {
            let source = require_source_path(artifact, workspace_root)?;
            hash_file(&source.join("SKILL.md"))
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::OpenCodeConfig => {
            let source = require_source_path(artifact, workspace_root)?;
            let template_str =
                fs::read_to_string(&source).map_err(|e| format!("read opencode source: {e}"))?;
            let template_json: serde_json::Value = serde_json::from_str(&template_str)
                .map_err(|e| format!("parse opencode source json: {e}"))?;
            let rendered = render_expected_opencode_config(&template_json, home)
                .ok_or_else(|| "cannot render expected opencode config".to_string())?;
            hash_json_value(&extract_managed_opencode_config(&rendered))
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::CodexConfig => {
            let source = require_source_path(artifact, workspace_root)?;
            let source_str =
                fs::read_to_string(&source).map_err(|e| format!("read codex source: {e}"))?;
            let source_toml: toml::Value = source_str
                .parse()
                .map_err(|e| format!("parse codex source toml: {e}"))?;
            Ok(hash_toml_value(&extract_managed_codex_config(&source_toml)))
        }
        ArtifactKind::TuiConfig => {
            let source = require_source_path(artifact, workspace_root)?;
            hash_file(&source)
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::OpenCodePlaywrightMcp => {
            let source = require_source_path(artifact, workspace_root)?;
            hash_file(&source)
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::CursorMcp => {
            let projection = cursor_playwright_projection_from_template(workspace_root, home)?;
            hash_json_value(&projection)
        }
        _ => Err(format!(
            "unsupported artifact for source digest: {:?}",
            artifact
        )),
    }
}

/// Hash installed managed content. Missing installed artifact returns [`ABSENT_DIGEST`].
pub fn artifact_installed_managed_digest(
    artifact: &ArtifactId,
    _workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let dest = artifact.resolve_dest(home)?;
    match artifact_kind(artifact) {
        ArtifactKind::RulesFile | ArtifactKind::AgentFile => {
            if dest.is_file() {
                hash_file(&dest)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::SkillDir => {
            let dest_md = dest.join("SKILL.md");
            if dest_md.is_file() {
                hash_file(&dest_md)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::OpenCodeConfig => {
            if !dest.is_file() {
                return Ok(ABSENT_DIGEST.into());
            }
            let installed_str = fs::read_to_string(&dest)
                .map_err(|e| format!("read installed opencode config: {e}"))?;
            let installed_json: serde_json::Value = serde_json::from_str(&installed_str)
                .map_err(|e| format!("parse installed opencode json: {e}"))?;
            hash_json_value(&extract_managed_opencode_config(&installed_json))
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::CodexConfig => {
            if !dest.is_file() {
                return Ok(ABSENT_DIGEST.into());
            }
            let installed_str = fs::read_to_string(&dest)
                .map_err(|e| format!("read installed codex config: {e}"))?;
            let installed_toml: toml::Value = installed_str
                .parse()
                .map_err(|e| format!("parse installed codex toml: {e}"))?;
            Ok(hash_toml_value(&extract_managed_codex_config(
                &installed_toml,
            )))
        }
        ArtifactKind::TuiConfig => {
            if dest.is_file() {
                hash_file(&dest)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::OpenCodePlaywrightMcp => {
            let dest = opencode_playwright_mcp_dest(home);
            if dest.is_file() {
                hash_file(&dest)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::CursorMcp => {
            let paths = crate::cursor_profile_paths::resolve_cursor_profile_paths()
                .map_err(|e| format!("resolve cursor profile: {e}"))?;
            match cursor_playwright_projection_from_installed(&paths)? {
                Some(projection) => hash_json_value(&projection),
                None => Ok(ABSENT_DIGEST.into()),
            }
        }
        _ => Err(format!(
            "unsupported artifact for installed digest: {:?}",
            artifact
        )),
    }
}

fn hash_directory_tree(dir: &Path, label: &str) -> Result<String, String> {
    if !dir.is_dir() {
        return Ok(ABSENT_DIGEST.into());
    }
    let mut hasher = DefaultHasher::new();
    let mut entries: BTreeMap<String, PathBuf> = BTreeMap::new();
    collect_directory_entries(dir, dir, label, &mut entries)?;
    for (rel, path) in entries {
        rel.hash(&mut hasher);
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("inspect {label} {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("refusing symlink in {label}: {}", path.display()));
        }
        if meta.is_dir() {
            "dir".hash(&mut hasher);
        } else if meta.is_file() {
            "file".hash(&mut hasher);
            hash_file(&path)?.hash(&mut hasher);
        } else {
            return Err(format!("unreadable entry in {label}: {}", path.display()));
        }
    }
    Ok(format!("{:016x}", hasher.finish()))
}

fn collect_directory_entries(
    root: &Path,
    current: &Path,
    label: &str,
    out: &mut BTreeMap<String, PathBuf>,
) -> Result<(), String> {
    for entry in
        fs::read_dir(current).map_err(|e| format!("read {label} {}: {e}", current.display()))?
    {
        let entry = entry.map_err(|e| format!("read {label} entry: {e}"))?;
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            return Err(format!(
                "refusing symlink in {label}: {}",
                entry.path().display()
            ));
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|_| format!("path escapes {label} root"))?
            .to_string_lossy()
            .into_owned();
        let is_dir = path.is_dir();
        out.insert(rel, path.clone());
        if is_dir {
            collect_directory_entries(root, &path, label, out)?;
        }
    }
    Ok(())
}

/// Hash installed full-file or full-directory content for rollback safety.
pub fn artifact_installed_full_digest(
    artifact: &ArtifactId,
    _workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let dest = artifact.resolve_dest(home)?;
    match artifact_kind(artifact) {
        ArtifactKind::SkillDir => hash_directory_tree(&dest, "skill directory"),
        ArtifactKind::ConfigFile
        | ArtifactKind::TuiConfig
        | ArtifactKind::RulesFile
        | ArtifactKind::AgentFile
        | ArtifactKind::McpConfig => {
            if dest.is_file() {
                hash_file(&dest)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup_lifecycle::SetupSurfaceId;
    use crate::setup_transaction;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(label: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-fp-{label}-{n}"))
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn fp_for_rules(ws: &Path, home: &Path) -> String {
        setup_transaction::compute_plan_fingerprint(
            ws,
            &[SetupSurfaceId::OpenCodeRules],
            &setup_transaction::plan_artifacts_for_surfaces(
                &[SetupSurfaceId::OpenCodeRules],
                ws,
                home,
            )
            .unwrap(),
            home,
        )
        .unwrap()
    }

    #[test]
    fn source_and_installed_digests_differ_for_diverged_rule() {
        let home = temp("rule-div-home");
        let ws = temp("rule-div-ws");
        write(&ws.join("templates/sync/opencode-rules.md"), "source-a");
        write(&home.join(".config/opencode/AGENTS.md"), "installed-b");
        let artifact = ArtifactId::OpenCodeRules;
        let src = artifact_source_digest(&artifact, &ws, &home).unwrap();
        let inst = artifact_installed_managed_digest(&artifact, &ws, &home).unwrap();
        assert_ne!(src, inst);
    }

    #[test]
    fn fingerprint_changes_when_source_rule_changes() {
        let home = temp("rule-src-home");
        let ws = temp("rule-src-ws");
        write(&ws.join("templates/sync/opencode-rules.md"), "v1");
        write(&home.join(".config/opencode/AGENTS.md"), "v1");
        let fp1 = fp_for_rules(&ws, &home);
        write(&ws.join("templates/sync/opencode-rules.md"), "v2");
        let fp2 = fp_for_rules(&ws, &home);
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn fingerprint_changes_when_installed_rule_changes() {
        let home = temp("rule-inst-home");
        let ws = temp("rule-inst-ws");
        write(&ws.join("templates/sync/opencode-rules.md"), "same");
        write(&home.join(".config/opencode/AGENTS.md"), "same");
        let fp1 = fp_for_rules(&ws, &home);
        write(&home.join(".config/opencode/AGENTS.md"), "changed");
        let fp2 = fp_for_rules(&ws, &home);
        assert_ne!(fp1, fp2);
    }

    fn write_opencode_config_fixture(ws: &Path, home: &Path, opencode_json: &str) {
        write(&ws.join("templates/opencode.json"), opencode_json);
        write(&ws.join("templates/tui.json"), r#"{"theme":"system"}"#);
        write(
            &ws.join("templates/playwright-mcp.config.json"),
            r#"{"browserName":"chromium"}"#,
        );
        let _ = home;
    }

    #[test]
    fn fingerprint_unchanged_by_unrelated_opencode_user_key() {
        let home = temp("oc-user-home");
        let ws = temp("oc-user-ws");
        write_opencode_config_fixture(
            &ws,
            &home,
            r#"{"$schema":"x","model":"m","share":"manual"}"#,
        );
        write(
            &home.join(".config/opencode/opencode.json"),
            r#"{"$schema":"x","model":"m","share":"manual","userOwned":"keep"}"#,
        );
        let surfaces = vec![SetupSurfaceId::OpenCodeConfig];
        let fp1 = setup_transaction::compute_plan_fingerprint(
            &ws,
            &surfaces,
            &setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws, &home).unwrap(),
            &home,
        )
        .unwrap();
        write(
            &home.join(".config/opencode/opencode.json"),
            r#"{"$schema":"x","model":"m","share":"manual","userOwned":"changed"}"#,
        );
        let fp2 = setup_transaction::compute_plan_fingerprint(
            &ws,
            &surfaces,
            &setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws, &home).unwrap(),
            &home,
        )
        .unwrap();
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn fingerprint_changes_when_opencode_managed_key_changes() {
        let home = temp("oc-managed-home");
        let ws = temp("oc-managed-ws");
        write_opencode_config_fixture(&ws, &home, r#"{"$schema":"x","model":"a"}"#);
        write(
            &home.join(".config/opencode/opencode.json"),
            r#"{"$schema":"x","model":"a"}"#,
        );
        let surfaces = vec![SetupSurfaceId::OpenCodeConfig];
        let fp1 = setup_transaction::compute_plan_fingerprint(
            &ws,
            &surfaces,
            &setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws, &home).unwrap(),
            &home,
        )
        .unwrap();
        write(
            &home.join(".config/opencode/opencode.json"),
            r#"{"$schema":"x","model":"b"}"#,
        );
        let fp2 = setup_transaction::compute_plan_fingerprint(
            &ws,
            &surfaces,
            &setup_transaction::plan_artifacts_for_surfaces(&surfaces, &ws, &home).unwrap(),
            &home,
        )
        .unwrap();
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn installed_digest_absent_when_missing() {
        let home = temp("absent-home");
        let ws = temp("absent-ws");
        write(&ws.join("templates/sync/codex-rules.md"), "rules");
        let digest =
            artifact_installed_managed_digest(&ArtifactId::CodexRules, &ws, &home).unwrap();
        assert_eq!(digest, ABSENT_DIGEST);
    }

    #[test]
    fn source_digest_errors_when_source_missing() {
        let home = temp("no-src-home");
        let ws = temp("no-src-ws");
        let err = artifact_source_digest(&ArtifactId::CodexRules, &ws, &home).unwrap_err();
        assert!(err.contains("source") || err.contains("read"));
    }
}
