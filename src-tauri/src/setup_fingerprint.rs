//! Preview fingerprint digests for setup artifacts.
//!
//! Source and installed managed digests are computed independently so preview
//! integrity detects divergence on either side.

use std::fs;
use std::path::{Path, PathBuf};

use crate::artifact_registry::{ArtifactId, ArtifactKind};
use crate::commands::cursor_profile::cursor_root;
use crate::commands::{
    extract_managed_codex_config, extract_managed_opencode_config, render_expected_opencode_config,
};
use crate::skill_sources::SourceRoot;
pub const ABSENT_DIGEST: &str = crate::stable_digest::ABSENT;

fn hash_bytes(bytes: &[u8]) -> String {
    crate::stable_digest::bytes(bytes)
}

fn hash_file(path: &Path) -> Result<String, String> {
    crate::stable_digest::file(path)
}

/// Hash a file path for workspace managed-state records.
pub fn hash_file_path(path: &Path) -> Result<String, String> {
    hash_file(path)
}

/// Hash JSON with object keys sorted at every level.
///
/// serde_json keeps insertion order (`preserve_order`), but digests stored in managed
/// state predate that and were computed over sorted keys. Sorting keeps those records
/// valid; semantic key order (OpenCode `permission`) is checked separately at plan time.
fn hash_json_value(value: &serde_json::Value) -> Result<String, String> {
    let canonical =
        serde_json::to_string(&sorted_json(value)).map_err(|e| format!("serialize json: {e}"))?;
    Ok(hash_bytes(canonical.as_bytes()))
}

fn sorted_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(key, child)| (key.clone(), sorted_json(child)))
                    .collect(),
            )
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(sorted_json).collect())
        }
        other => other.clone(),
    }
}

fn hash_toml_value(value: &toml::Value) -> String {
    hash_bytes(value.to_string().as_bytes())
}

fn artifact_kind(artifact: &ArtifactId) -> ArtifactKind {
    match artifact {
        ArtifactId::WorkspaceFile(_) => ArtifactKind::RulesFile,
        ArtifactId::CodexLegacySkill(_) | ArtifactId::SkillFile(_) => ArtifactKind::SkillFile,
        ArtifactId::OpenCodeConfig | ArtifactId::CodexConfig => ArtifactKind::ConfigFile,
        ArtifactId::OpenCodeTui => ArtifactKind::TuiConfig,
        ArtifactId::ClaudeSettings => ArtifactKind::ClaudeSettings,
        ArtifactId::OpenCodePlaywrightMcp => ArtifactKind::McpConfig,
        ArtifactId::OpenCodeRules
        | ArtifactId::CodexRules
        | ArtifactId::ClaudeRules
        | ArtifactId::HarnessRules(_) => ArtifactKind::RulesFile,
        ArtifactId::OpenCodeAgent(_)
        | ArtifactId::CodexAgent(_)
        | ArtifactId::ClaudeAgent(_)
        | ArtifactId::CursorAgent(_) => ArtifactKind::AgentFile,
        ArtifactId::OpenCodeSkill(_)
        | ArtifactId::CodexSkill(_)
        | ArtifactId::ClaudeSkill(_)
        | ArtifactId::CursorSkill(_) => ArtifactKind::SkillFile,
        ArtifactId::CursorMcp | ArtifactId::HarnessMcp(_) => ArtifactKind::McpConfig,
    }
}

fn require_source_path<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    sources: &R,
) -> Result<PathBuf, String> {
    artifact
        .resolve_source(sources)
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

/// The Playwright entry a light harness's MCP file is meant to hold.
fn harness_mcp_entry(
    artifact: &ArtifactId,
    bundled_root: &Path,
    home: &Path,
) -> Result<serde_json::Value, String> {
    let ArtifactId::HarnessMcp(harness) = artifact else {
        return Err(format!("not an MCP entry: {artifact:?}"));
    };
    let spec = harness
        .mcp()
        .ok_or_else(|| "the light harness descriptor is unavailable".to_string())?;
    crate::light_mcp::expected_entry(spec, bundled_root, home)
}

/// Digest of the managed entry of a light harness's MCP file: the entry's, [`ABSENT_DIGEST`] when
/// there is no file or no entry, and a fixed digest per refusal for a file the app does not edit
/// (nothing of its text goes in, and such a file is never written).
fn harness_mcp_digest_from_path(artifact: &ArtifactId, path: &Path) -> Result<String, String> {
    let ArtifactId::HarnessMcp(harness) = artifact else {
        return Err(format!("not an MCP entry: {artifact:?}"));
    };
    let spec = harness
        .mcp()
        .ok_or_else(|| "the light harness descriptor is unavailable".to_string())?;
    match crate::light_mcp::read(path, spec) {
        Ok(None) => Ok(ABSENT_DIGEST.into()),
        Ok(Some(document)) => match document.entry(spec) {
            Some(entry) => hash_json_value(entry),
            None => Ok(ABSENT_DIGEST.into()),
        },
        Err(refusal) => Ok(hash_bytes(
            format!("unusable-mcp-file:{refusal:?}").as_bytes(),
        )),
    }
}

/// Digest of the managed keys of a `tui.json`: [`ABSENT_DIGEST`] when there is no file, and a
/// fixed digest per refusal for a file the app does not edit (nothing of its text goes in, and
/// such a file is never written).
fn tui_digest_from_path(path: &Path) -> Result<String, String> {
    let keys = crate::opencode_tui::managed_keys()?;
    match crate::opencode_tui::read(path) {
        Ok(None) => Ok(ABSENT_DIGEST.into()),
        Ok(Some(config)) => hash_json_value(&serde_json::Value::Object(
            crate::opencode_tui::managed_projection(&config, keys),
        )),
        Err(refusal) => Ok(hash_bytes(
            format!("unusable-tui-file:{refusal:?}").as_bytes(),
        )),
    }
}

/// Digest of the managed values of a `settings.json`: [`ABSENT_DIGEST`] when there is no file,
/// and a fixed digest per refusal for a file the app does not edit (nothing of its text goes in,
/// and such a file is never written).
fn claude_settings_digest_from_path(path: &Path) -> Result<String, String> {
    match crate::claude_settings::read(path) {
        Ok(None) => Ok(ABSENT_DIGEST.into()),
        Ok(Some(config)) => hash_json_value(&serde_json::Value::Object(
            crate::claude_settings::managed_projection(&config),
        )),
        Err(refusal) => Ok(hash_bytes(
            format!("unusable-claude-settings-file:{refusal:?}").as_bytes(),
        )),
    }
}

/// Digest of the managed projection of a Codex config.
pub fn codex_managed_digest(config: &toml::Value) -> String {
    hash_toml_value(&extract_managed_codex_config(config))
}

/// The digest of what an apply makes of `artifact`: [`artifact_source_digest`], except for the
/// Codex config, where the keys the user keeps are substituted into the template first (see
/// [`crate::codex_config_keep`]). It must be used wherever the source side is compared with the
/// installed side, so plans, fingerprints and ownership records agree on what "current" means.
/// `bundled_root` holds the template; `runtime_root` is the workspace folder that records the
/// choice. The version of the bundle is not such a place: it stays the plain template's.
pub fn artifact_effective_source_digest<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    bundled_root: &R,
    runtime_root: &Path,
    home: &Path,
) -> Result<String, String> {
    if artifact != &ArtifactId::CodexConfig {
        return artifact_source_digest(artifact, bundled_root, home);
    }
    let source = require_source_path(artifact, bundled_root)?;
    let source_str = fs::read_to_string(&source).map_err(|e| format!("read codex source: {e}"))?;
    let template: toml::Value = source_str
        .parse()
        .map_err(|_| "the bundled Codex config is not valid TOML".to_string())?;
    // The choice applies to the installed file; one that is absent or unreadable keeps nothing.
    let installed = artifact
        .resolve_dest(home, runtime_root)
        .ok()
        .and_then(|dest| fs::read_to_string(dest).ok())
        .and_then(|raw| raw.parse::<toml::Value>().ok());
    let effective = match installed {
        Some(installed) => {
            crate::codex_config_keep::assess(Some(runtime_root), home, &installed, &template)
                .effective
        }
        None => template,
    };
    Ok(codex_managed_digest(&effective))
}

/// Hash canonical source content for an artifact. Missing source is an error.
pub fn artifact_source_digest<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    sources: &R,
    home: &Path,
) -> Result<String, String> {
    let workspace_root = sources.bundle();
    if artifact.is_rules_block() {
        let source = require_source_path(artifact, sources)?;
        crate::path_safety::reject_symlink(&source, "rules source")?;
        let bytes = fs::read(&source).map_err(|e| format!("read {}: {e}", source.display()))?;
        return crate::rules_block::source_digest(&bytes);
    }
    match artifact_kind(artifact) {
        ArtifactKind::RulesFile | ArtifactKind::AgentFile
            if matches!(artifact, ArtifactId::WorkspaceFile(_)) =>
        {
            let source = require_source_path(artifact, sources)?;
            hash_file(&source)
        }
        ArtifactKind::RulesFile | ArtifactKind::AgentFile => {
            let source = require_source_path(artifact, sources)?;
            hash_file(&source)
        }
        ArtifactKind::SkillFile => {
            let source = require_source_path(artifact, sources)?;
            hash_file(&source)
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::OpenCodeConfig => {
            let source = require_source_path(artifact, sources)?;
            let template_str =
                fs::read_to_string(&source).map_err(|e| format!("read opencode source: {e}"))?;
            let template_json: serde_json::Value = serde_json::from_str(&template_str)
                .map_err(|_| "the bundled OpenCode config is not valid JSON".to_string())?;
            let rendered = render_expected_opencode_config(&template_json, home)
                .ok_or_else(|| "cannot render expected opencode config".to_string())?;
            hash_json_value(&extract_managed_opencode_config(&rendered))
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::CodexConfig => {
            let source = require_source_path(artifact, sources)?;
            let source_str =
                fs::read_to_string(&source).map_err(|e| format!("read codex source: {e}"))?;
            let source_toml: toml::Value = source_str
                .parse()
                .map_err(|_| "the bundled Codex config is not valid TOML".to_string())?;
            Ok(codex_managed_digest(&source_toml))
        }
        ArtifactKind::TuiConfig => {
            let source = require_source_path(artifact, sources)?;
            let keys = crate::opencode_tui::managed_keys()?;
            let template = crate::opencode_tui::bundled(&source)?;
            hash_json_value(&serde_json::Value::Object(
                crate::opencode_tui::managed_projection(&template, keys),
            ))
        }
        // The managed values are constants of the app: there is no bundled file.
        ArtifactKind::ClaudeSettings => hash_json_value(&serde_json::Value::Object(
            crate::claude_settings::managed_values(),
        )),
        ArtifactKind::McpConfig if artifact == &ArtifactId::OpenCodePlaywrightMcp => {
            let source = require_source_path(artifact, sources)?;
            hash_file(&source)
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::CursorMcp => {
            let projection = cursor_playwright_projection_from_template(workspace_root, home)?;
            hash_json_value(&projection)
        }
        ArtifactKind::McpConfig if matches!(artifact, ArtifactId::HarnessMcp(_)) => {
            hash_json_value(&harness_mcp_entry(artifact, workspace_root, home)?)
        }
        _ => Err(format!(
            "unsupported artifact for source digest: {:?}",
            artifact
        )),
    }
}

/// Hash managed content from an on-disk artifact path (backup or installed).
pub fn artifact_installed_managed_digest_from_path(
    artifact: &ArtifactId,
    path: &Path,
) -> Result<String, String> {
    if artifact.is_rules_block() {
        // The block body when the file has one; a pre-block file or an
        // unparsable one digests as a whole so the plan still sees changes.
        if !path.is_file() {
            return Ok(ABSENT_DIGEST.into());
        }
        crate::path_safety::reject_symlink(path, "rules file")?;
        if fs::metadata(path)
            .is_ok_and(|meta| meta.len() > crate::rules_block::MAX_RULES_FILE_BYTES)
        {
            return hash_file(path);
        }
        let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        return Ok(crate::rules_block::installed_managed_digest(&bytes));
    }
    match artifact_kind(artifact) {
        ArtifactKind::RulesFile | ArtifactKind::AgentFile => {
            if path.is_file() {
                hash_file(path)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::TuiConfig => tui_digest_from_path(path),
        ArtifactKind::ClaudeSettings => claude_settings_digest_from_path(path),
        ArtifactKind::SkillFile => {
            if path.is_file() {
                hash_file(path)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::OpenCodeConfig => {
            if !path.is_file() {
                return Ok(ABSENT_DIGEST.into());
            }
            let installed_str =
                fs::read_to_string(path).map_err(|e| format!("read opencode config: {e}"))?;
            let installed_json: serde_json::Value = serde_json::from_str(&installed_str)
                .map_err(|_| "the OpenCode opencode.json is not valid JSON".to_string())?;
            hash_json_value(&extract_managed_opencode_config(&installed_json))
        }
        ArtifactKind::ConfigFile if artifact == &ArtifactId::CodexConfig => {
            if !path.is_file() {
                return Ok(ABSENT_DIGEST.into());
            }
            let installed_str =
                fs::read_to_string(path).map_err(|e| format!("read codex config: {e}"))?;
            let installed_toml: toml::Value = installed_str
                .parse()
                .map_err(|_| "the Codex config.toml is not valid TOML".to_string())?;
            Ok(hash_toml_value(&extract_managed_codex_config(
                &installed_toml,
            )))
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::OpenCodePlaywrightMcp => {
            if path.is_file() {
                hash_file(path)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::CursorMcp => {
            if !path.is_file() {
                return Ok(ABSENT_DIGEST.into());
            }
            let content =
                fs::read_to_string(path).map_err(|e| format!("read cursor mcp config: {e}"))?;
            let parsed: serde_json::Value = serde_json::from_str(&content)
                .map_err(|_| "the Cursor mcp.json is not valid JSON".to_string())?;
            match parsed.get("mcpServers").and_then(|v| v.get("playwright")) {
                Some(projection) => hash_json_value(projection),
                None => Ok(ABSENT_DIGEST.into()),
            }
        }
        ArtifactKind::McpConfig if matches!(artifact, ArtifactId::HarnessMcp(_)) => {
            harness_mcp_digest_from_path(artifact, path)
        }
        _ => Err(format!(
            "unsupported artifact for managed digest from path: {:?}",
            artifact
        )),
    }
}

/// Hash installed managed content. Missing installed artifact returns [`ABSENT_DIGEST`].
pub fn artifact_installed_managed_digest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let dest = artifact.resolve_dest(home, workspace_root)?;
    if artifact == &ArtifactId::OpenCodePlaywrightMcp {
        let playwright_dest = opencode_playwright_mcp_dest(home);
        return artifact_installed_managed_digest_from_path(artifact, &playwright_dest);
    }
    artifact_installed_managed_digest_from_path(artifact, &dest)
}

/// Hash installed full-file or full-directory content for rollback safety.
pub fn artifact_installed_full_digest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let dest = artifact.resolve_dest(home, workspace_root)?;
    match artifact_kind(artifact) {
        ArtifactKind::SkillFile => {
            if dest.is_file() {
                hash_file(&dest)
            } else {
                Ok(ABSENT_DIGEST.into())
            }
        }
        ArtifactKind::ConfigFile
        | ArtifactKind::TuiConfig
        | ArtifactKind::ClaudeSettings
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

    #[test]
    fn json_digest_ignores_key_order_at_every_level() {
        let sorted: serde_json::Value =
            serde_json::from_str(r#"{"a":1,"permission":{"bash":{"*":"ask","rm *":"deny"}}}"#)
                .unwrap();
        let reordered: serde_json::Value =
            serde_json::from_str(r#"{"permission":{"bash":{"rm *":"deny","*":"ask"}},"a":1}"#)
                .unwrap();
        assert_eq!(
            hash_json_value(&sorted).unwrap(),
            hash_json_value(&reordered).unwrap()
        );
        // Records written before `preserve_order` hashed the sorted serialization.
        assert_eq!(
            hash_json_value(&reordered).unwrap(),
            hash_bytes(br#"{"a":1,"permission":{"bash":{"*":"ask","rm *":"deny"}}}"#)
        );
    }
    use crate::artifact_registry::{ArtifactId, SkillName};
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

    fn overwrite_same_length(path: &Path, content: &str) {
        let meta = fs::metadata(path).unwrap();
        let mtime = meta.modified().unwrap();
        assert_eq!(meta.len(), content.len() as u64);
        fs::write(path, content).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), mtime);
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
    fn fingerprint_ignores_runtime_files_that_shadow_bundled_sources() {
        // Holds the env lock: a test that moves XDG_CONFIG_HOME mid-way changes the digests.
        let _env = crate::test_env::guard::default_xdg_config_home();
        let home = temp("rule-src-home");
        let ws = temp("rule-src-ws");
        write(&ws.join("templates/sync/opencode-rules.md"), "v1");
        write(&home.join(".config/opencode/AGENTS.md"), "v1");
        let fp1 = fp_for_rules(&ws, &home);
        write(&ws.join("templates/sync/opencode-rules.md"), "v2");
        let fp2 = fp_for_rules(&ws, &home);
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn fingerprint_changes_when_installed_rule_changes() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        let home = temp("rule-inst-home");
        let ws = temp("rule-inst-ws");
        write(&ws.join("templates/sync/opencode-rules.md"), "same");
        write(&home.join(".config/opencode/AGENTS.md"), "same");
        let fp1 = fp_for_rules(&ws, &home);
        write(&home.join(".config/opencode/AGENTS.md"), "changed");
        let fp2 = fp_for_rules(&ws, &home);
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn fingerprint_changes_when_installed_rule_changes_without_mtime_or_length() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        let home = temp("rule-stale-home");
        let ws = temp("rule-stale-ws");
        let installed = home.join(".config/opencode/AGENTS.md");
        write(&ws.join("templates/sync/opencode-rules.md"), "0123456789");
        write(&installed, "0123456789");
        let fp1 = fp_for_rules(&ws, &home);
        overwrite_same_length(&installed, "abcdefghij");
        let fp2 = fp_for_rules(&ws, &home);
        assert_ne!(
            fp1, fp2,
            "preview fingerprint must detect same-length installed changes even when mtime is unchanged"
        );
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
        // Holds the env lock: a test that moves XDG_CONFIG_HOME mid-way changes the digests.
        let _env = crate::test_env::guard::default_xdg_config_home();
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
        let _env = crate::test_env::guard::default_xdg_config_home();
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
    fn skill_digest_uses_skill_md_only() {
        let home = temp("skill-digest-home");
        let ws = temp("skill-digest-ws");
        let skill_md = crate::test_env::write_canonical_skill(&ws, None, "frontend-design", "body");
        fs::write(
            ws.join("skills/frontend-design/user-notes.md"),
            "unknown sibling",
        )
        .unwrap();
        let artifact = ArtifactId::OpenCodeSkill(SkillName::new("frontend-design").unwrap());
        let digest = artifact_source_digest(&artifact, &ws, &home).unwrap();
        assert_eq!(digest, hash_file(&skill_md).unwrap());
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
    #[test]
    fn invalid_user_config_errors_never_quote_the_file() {
        let dir = temp("parse-leak");
        let toml_path = dir.join("config.toml");
        write(
            &toml_path,
            "model = \"x\"\n[mcp_servers.gh.env]\nGITHUB_TOKEN = \"FAKE-SECRET-VALUE-123\" oops\n",
        );
        let err = artifact_installed_managed_digest_from_path(&ArtifactId::CodexConfig, &toml_path)
            .unwrap_err();
        assert!(!err.contains("FAKE-SECRET"), "{err}");
        assert_eq!(err, "the Codex config.toml is not valid TOML");
        let json_path = dir.join("opencode.json");
        write(&json_path, "{\"token\": \"FAKE-SECRET-VALUE-123\" oops}");
        let err =
            artifact_installed_managed_digest_from_path(&ArtifactId::OpenCodeConfig, &json_path)
                .unwrap_err();
        assert!(
            !err.contains("FAKE-SECRET") && !err.contains("line"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
