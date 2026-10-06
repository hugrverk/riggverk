//! Rules-file previews and explicit actions for hand-edited files.
//!
//! Rules files hold the managed base in a marked block (see `rules_block`). A
//! file the user edited by hand is a conflict the regular update refuses to
//! touch. These commands let the user see what differs, convert the file onto
//! the block (their edits kept below it), or leave it as is. Previews are
//! read-only; the conversion is an ordinary setup transaction with a backup.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::setup::{apply_planned_artifacts, SetupResult};
use super::workspace::setup_workspace_target_path;
use crate::artifact_registry::ArtifactId;
use crate::rules_block::{self, RulesConflict, RulesPlan};
use crate::rules_convert::{self, ConversionOrigin};
use crate::rules_diff;
use crate::setup_lifecycle::SetupSurfaceId;
use crate::setup_transaction::{self, RulesContext, RulesRewrite};

fn user_home() -> Result<PathBuf, String> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

/// The rules surface and artifact a command acts on. The surface must be a
/// rules surface whose harness and target toggle are enabled.
fn rules_target(surface: &str) -> Result<(SetupSurfaceId, ArtifactId), String> {
    let surface_id =
        serde_json::from_value::<SetupSurfaceId>(serde_json::Value::String(surface.to_string()))
            .map_err(|_| format!("Unknown surface ID: {surface}"))?;
    let artifact = match surface_id {
        SetupSurfaceId::ClaudeRules => ArtifactId::ClaudeRules,
        SetupSurfaceId::CodexRules => ArtifactId::CodexRules,
        SetupSurfaceId::OpenCodeRules => ArtifactId::OpenCodeRules,
        _ => return Err(format!("{surface} is not a rules surface")),
    };
    let settings = crate::settings::load();
    if !crate::settings::surface_enabled(&settings, surface_id) {
        return Err(format!("{} is disabled", surface_id.label()));
    }
    Ok((surface_id, artifact))
}

fn file_label(artifact: &ArtifactId) -> &'static str {
    match artifact {
        ArtifactId::ClaudeRules => "CLAUDE.md",
        _ => "AGENTS.md",
    }
}

fn load_context(artifact: &ArtifactId) -> Result<(PathBuf, PathBuf, RulesContext), String> {
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let context = setup_transaction::rules_context(artifact, &ws_root, &home)?;
    Ok((ws_root, home, context))
}

// ── Diff ──

/// Which two texts a rules diff compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RulesDiffMode {
    /// The installed file against what an update would write. For a file the
    /// update refuses, the installed base text against the new base.
    Update,
    /// The closest shipped base against the installed file: what the user
    /// changed.
    Edits,
}

#[derive(Debug, Clone, Serialize)]
pub struct RulesDiffView {
    pub surface: SetupSurfaceId,
    pub mode: RulesDiffMode,
    pub from_label: String,
    pub to_label: String,
    /// False when a regular update would refuse this file (the diff is then
    /// informational) or there is nothing to compare.
    pub applicable: bool,
    pub note: Option<String>,
    /// Digest of the shipped base the installed text was compared with
    /// (`edits` mode only).
    pub compared_base: Option<String>,
    pub added: usize,
    pub removed: usize,
    /// The diff text was cut at 64 KB.
    pub truncated: bool,
    /// Unified diff; empty when both sides are equal.
    pub diff: String,
}

fn parse_mode(mode: Option<&str>) -> Result<RulesDiffMode, String> {
    match mode {
        None | Some("update") => Ok(RulesDiffMode::Update),
        Some("edits") => Ok(RulesDiffMode::Edits),
        Some(other) => Err(format!("Unknown diff mode: {other}")),
    }
}

fn installed_text(context: &RulesContext) -> Result<Option<&str>, String> {
    match &context.installed {
        None => Ok(None),
        Some(bytes) => std::str::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "rules file is not valid UTF-8".to_string()),
    }
}

/// The installed text the user's edits live in: the block body, or the whole
/// file when it has no block.
fn editable_text(installed: &str) -> &str {
    match rules_block::parse(installed) {
        Ok(Some(file)) => file.body,
        _ => installed,
    }
}

/// Builds `RulesDiffView`s for one surface and mode.
struct ViewBuilder {
    surface: SetupSurfaceId,
    mode: RulesDiffMode,
}

impl ViewBuilder {
    fn make(
        &self,
        from_label: &str,
        to_label: &str,
        applicable: bool,
        note: Option<String>,
        compared_base: Option<String>,
        diff: rules_diff::DiffOutput,
    ) -> RulesDiffView {
        RulesDiffView {
            surface: self.surface,
            mode: self.mode,
            from_label: from_label.to_string(),
            to_label: to_label.to_string(),
            applicable,
            note,
            compared_base,
            added: diff.added,
            removed: diff.removed,
            truncated: diff.truncated,
            diff: diff.text,
        }
    }
}

fn build_diff(
    surface: SetupSurfaceId,
    artifact: &ArtifactId,
    context: &RulesContext,
    mode: RulesDiffMode,
) -> RulesDiffView {
    let builder = ViewBuilder { surface, mode };
    let empty = rules_diff::unified_diff("", "", "", "");
    let text = match installed_text(context) {
        Ok(text) => text,
        Err(message) => return builder.make("installed", "new", false, Some(message), None, empty),
    };
    let plan = context.assessment.plan;
    if let (Some(malformed), RulesPlan::Conflict(RulesConflict::MalformedMarkers)) =
        (context.assessment.malformed, plan)
    {
        return builder.make(
            "installed",
            "new",
            false,
            Some(format!(
                "base block markers are malformed: {}",
                malformed.message()
            )),
            None,
            empty,
        );
    }
    match mode {
        RulesDiffMode::Update => update_diff(context, text, plan, &builder),
        RulesDiffMode::Edits => {
            let Some(text) = text else {
                return builder.make(
                    "shipped base",
                    "installed",
                    false,
                    Some("no rules file is installed".to_string()),
                    None,
                    empty,
                );
            };
            let user_text = editable_text(text);
            let bases = rules_convert::known_bases(&context.bundled_root, artifact);
            let closest = rules_convert::closest_base(&context.source_text, &bases, user_text);
            let from_label = format!(
                "shipped base {}",
                closest.digest.chars().take(19).collect::<String>()
            );
            let note = if closest.changed_lines == 0 {
                "matches a shipped base exactly; nothing was edited".to_string()
            } else {
                format!(
                    "compared with the closest shipped base ({} lines differ)",
                    closest.changed_lines
                )
            };
            let diff = rules_diff::unified_diff(&from_label, "installed", &closest.text, user_text);
            builder.make(
                &from_label,
                "installed",
                true,
                Some(note),
                Some(closest.digest),
                diff,
            )
        }
    }
}

fn update_diff(
    context: &RulesContext,
    text: Option<&str>,
    plan: RulesPlan,
    builder: &ViewBuilder,
) -> RulesDiffView {
    let source = &context.source_text;
    match (plan, text) {
        (RulesPlan::Create, _) | (_, None) => {
            let result = rules_block::render_new(source);
            builder.make(
                "(no file)",
                "after update",
                true,
                None,
                None,
                rules_diff::unified_diff("(no file)", "after update", "", &result),
            )
        }
        (RulesPlan::NoChange, Some(_)) => builder.make(
            "installed",
            "after update",
            true,
            Some("the managed block already carries the current base".to_string()),
            None,
            rules_diff::unified_diff("", "", "", ""),
        ),
        (RulesPlan::UpdateBlock, Some(text)) => {
            let after = rules_block::parse(text)
                .ok()
                .flatten()
                .map(|file| file.render_with_body(source))
                .unwrap_or_else(|| rules_block::render_new(source));
            builder.make(
                "installed",
                "after update",
                true,
                None,
                None,
                rules_diff::unified_diff("installed", "after update", text, &after),
            )
        }
        (RulesPlan::WrapLegacy, Some(text)) => {
            let after = rules_block::render_new(source);
            builder.make(
                "installed",
                "after update",
                true,
                Some("the unmodified file is replaced by the managed base block".to_string()),
                None,
                rules_diff::unified_diff("installed", "after update", text, &after),
            )
        }
        (RulesPlan::Conflict(conflict), Some(text)) => {
            let from_label = match conflict {
                RulesConflict::BaseBlockEdited => "your base block",
                _ => "your file",
            };
            let from = match conflict {
                RulesConflict::BaseBlockEdited => editable_text(text),
                _ => text,
            };
            builder.make(
                from_label,
                "new base",
                false,
                Some(format!(
                    "update refused: {}; this shows what the new base contains",
                    conflict.message()
                )),
                None,
                rules_diff::unified_diff(from_label, "new base", from, source),
            )
        }
    }
}

/// Read-only: a bounded unified diff for one rules surface.
///
/// `mode` is `"update"` (default) or `"edits"`.
#[tauri::command(async)]
pub fn preview_rules_diff(surface: String, mode: Option<String>) -> Result<RulesDiffView, String> {
    let mode = parse_mode(mode.as_deref())?;
    let (surface_id, artifact) = rules_target(&surface)?;
    let (_, _, context) = load_context(&artifact)?;
    Ok(build_diff(surface_id, &artifact, &context, mode))
}

// ── Conversion ──

#[derive(Debug, Clone, Serialize)]
pub struct RulesConversionPreview {
    pub surface: SetupSurfaceId,
    /// False when there is nothing to convert or the file cannot be converted.
    pub applicable: bool,
    pub reason: Option<String>,
    pub origin: Option<ConversionOrigin>,
    /// Digest of the shipped base the file was compared with.
    pub compared_base: Option<String>,
    pub compared_base_changed_lines: Option<usize>,
    /// Sections kept below the END marker.
    pub moved_sections: Vec<String>,
    /// Base sections the file lacked; they return with the new base.
    pub removed_sections: Vec<String>,
    /// The complete file that apply writes.
    pub result: String,
    /// Unified diff of the installed file against `result`.
    pub diff: String,
    pub diff_truncated: bool,
    pub plan_fingerprint: Option<String>,
    pub preview_token: Option<String>,
}

fn refused(surface: SetupSurfaceId, reason: impl Into<String>) -> RulesConversionPreview {
    RulesConversionPreview {
        surface,
        applicable: false,
        reason: Some(reason.into()),
        origin: None,
        compared_base: None,
        compared_base_changed_lines: None,
        moved_sections: Vec::new(),
        removed_sections: Vec::new(),
        result: String::new(),
        diff: String::new(),
        diff_truncated: false,
        plan_fingerprint: None,
        preview_token: None,
    }
}

/// Everything a conversion needs, computed from the files as they are now.
struct ConversionPlan {
    converted: rules_convert::Converted,
    operation: setup_transaction::PlannedArtifact,
    installed_text: String,
}

fn plan_conversion(
    surface: SetupSurfaceId,
    artifact: &ArtifactId,
    ws_root: &Path,
    home: &Path,
) -> Result<ConversionPlan, Box<RulesConversionPreview>> {
    let context = setup_transaction::rules_context(artifact, ws_root, home)
        .map_err(|message| Box::new(refused(surface, message)))?;
    if !setup_transaction::is_convertible(context.assessment.plan) {
        let reason = match context.assessment.plan {
            RulesPlan::Conflict(RulesConflict::MalformedMarkers) => {
                "the base block markers are malformed; fix or remove them by hand first".to_string()
            }
            _ => {
                "this file is managed by the base block already; use the regular update".to_string()
            }
        };
        return Err(Box::new(refused(surface, reason)));
    }
    let Some(installed) = &context.installed else {
        return Err(Box::new(refused(surface, "no rules file is installed")));
    };
    let bases = rules_convert::known_bases(&context.bundled_root, artifact);
    let converted = rules_convert::convert(
        installed,
        &context.source_text,
        &bases,
        file_label(artifact),
    )
    .map_err(|message| Box::new(refused(surface, message)))?;
    let operation = setup_transaction::conversion_operation(
        artifact,
        context.assessment,
        RulesRewrite {
            content: converted.result.clone(),
            expected_installed_digest: crate::stable_digest::bytes(installed),
        },
    );
    let installed_text = String::from_utf8_lossy(installed).into_owned();
    Ok(ConversionPlan {
        converted,
        operation,
        installed_text,
    })
}

/// Read-only: the exact file a conversion would write, and the token to apply it.
#[tauri::command(async)]
pub fn preview_rules_conversion(surface: String) -> Result<RulesConversionPreview, String> {
    let (surface_id, artifact) = rules_target(&surface)?;
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let plan = match plan_conversion(surface_id, &artifact, &ws_root, &home) {
        Ok(plan) => plan,
        Err(preview) => return Ok(*preview),
    };
    let fingerprint = setup_transaction::conversion_fingerprint(&ws_root, &home, &plan.operation)?;
    let token = setup_transaction::issue_preview_token(
        &ws_root,
        &fingerprint,
        setup_transaction::PreviewPurpose::Apply,
        &[surface_id],
    )?;
    let diff = rules_diff::unified_diff(
        "installed",
        "after conversion",
        &plan.installed_text,
        &plan.converted.result,
    );
    Ok(RulesConversionPreview {
        surface: surface_id,
        applicable: true,
        reason: None,
        origin: Some(plan.converted.origin),
        compared_base: Some(plan.converted.compared_base),
        compared_base_changed_lines: Some(plan.converted.compared_base_changed_lines),
        moved_sections: plan.converted.moved_sections,
        removed_sections: plan.converted.removed_sections,
        result: plan.converted.result,
        diff: diff.text,
        diff_truncated: diff.truncated,
        plan_fingerprint: Some(fingerprint),
        preview_token: Some(token),
    })
}

/// Convert a hand-edited rules file onto the managed base block. Runs as a
/// regular setup transaction: the file is backed up first and the transaction
/// can be rolled back while the file is unchanged.
#[tauri::command]
pub fn apply_rules_conversion(
    surface: String,
    plan_fingerprint: Option<String>,
    preview_token: Option<String>,
) -> Result<SetupResult, String> {
    let (surface_id, artifact) = rules_target(&surface)?;
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;

    let expected = plan_fingerprint
        .as_deref()
        .ok_or_else(|| "Plan fingerprint required. Re-run preview before applying.".to_string())?;
    if !setup_transaction::validate_fingerprint_format(expected) {
        return Err("Malformed plan fingerprint".to_string());
    }
    let token = preview_token
        .as_deref()
        .ok_or_else(|| "Preview token required. Re-run preview before applying.".to_string())?;

    let plan = plan_conversion(surface_id, &artifact, &ws_root, &home).map_err(|preview| {
        preview
            .reason
            .unwrap_or_else(|| "nothing to convert".to_string())
    })?;
    let current = setup_transaction::conversion_fingerprint(&ws_root, &home, &plan.operation)?;
    if current != expected {
        return Err(
            "Plan fingerprint mismatch: the file changed after preview. Re-run preview before applying."
                .to_string(),
        );
    }
    setup_transaction::validate_preview_token(
        token,
        &ws_root,
        expected,
        setup_transaction::PreviewPurpose::Apply,
        &[surface_id],
    )?;

    let mut result = apply_planned_artifacts(&[plan.operation], Vec::new(), Some(token));
    if result.success {
        clear_user_managed_after_conversion(&ws_root, &artifact, &mut result);
    }
    Ok(result)
}

/// The file is under the block now, so a recorded "I manage it" no longer applies. Runs after
/// the apply released the setup mutation guard, so it takes the guard like
/// `set_rules_user_managed`. A failure is reported in the result: the file would otherwise keep
/// being treated as user managed with no sign why.
fn clear_user_managed_after_conversion(
    ws_root: &Path,
    artifact: &ArtifactId,
    result: &mut SetupResult,
) {
    let cleared = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()
        .and_then(|_guard| crate::rules_preferences::set_user_managed(ws_root, artifact, false));
    if let Err(error) = cleared {
        result.manual_steps.push(format!(
            "The file was converted, but the \"leave as is\" choice for {} could not be cleared: {error}",
            file_label(artifact)
        ));
    }
}

// ── Leave as is ──

/// Record (or clear) that the user manages a hand-edited rules file
/// themselves. A recorded file stays untouched and reports base updates
/// instead of a conflict. Writes only the preferences file.
#[tauri::command]
pub fn set_rules_user_managed(surface: String, user_managed: bool) -> Result<(), String> {
    let (_, artifact) = rules_target(&surface)?;
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    if user_managed {
        let context = setup_transaction::rules_context(&artifact, &ws_root, &home)?;
        if !setup_transaction::is_convertible(context.assessment.plan) {
            return Err("this file is not a conflict; there is nothing to leave as is".to_string());
        }
    }
    crate::rules_preferences::set_user_managed(&ws_root, &artifact, user_managed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-rules-clear-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn converted_result() -> SetupResult {
        SetupResult {
            success: true,
            transaction_id: "1".into(),
            applied: vec![],
            failed: vec![],
            rolled_back: vec![],
            manual_steps: vec![],
            message: String::new(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_clear_of_the_user_managed_choice_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let ws = temp_workspace("write-fails");
        crate::rules_preferences::set_user_managed(&ws, &ArtifactId::ClaudeRules, true).unwrap();
        let prefs_dir = ws.join(".agent-workspace");
        std::fs::set_permissions(&prefs_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::File::create(prefs_dir.join("probe")).is_ok();
        if writable {
            // Running with privileges that ignore directory modes: the failure cannot be staged.
            let _ = std::fs::set_permissions(&prefs_dir, std::fs::Permissions::from_mode(0o755));
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }

        let mut result = converted_result();
        clear_user_managed_after_conversion(&ws, &ArtifactId::ClaudeRules, &mut result);

        let _ = std::fs::set_permissions(&prefs_dir, std::fs::Permissions::from_mode(0o755));
        let still_recorded =
            crate::rules_preferences::is_user_managed(&ws, &ArtifactId::ClaudeRules);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(still_recorded);
        assert!(result.success, "the conversion itself succeeded");
        assert_eq!(result.manual_steps.len(), 1, "{:?}", result.manual_steps);
        assert!(
            result.manual_steps[0].contains("CLAUDE.md")
                && result.manual_steps[0].contains("could not be cleared"),
            "{:?}",
            result.manual_steps
        );
    }

    #[test]
    fn clearing_the_user_managed_choice_waits_for_the_setup_mutation_guard() {
        let ws = temp_workspace("guard-held");
        crate::rules_preferences::set_user_managed(&ws, &ArtifactId::ClaudeRules, true).unwrap();
        let held = loop {
            if let Ok(guard) = crate::setup_mutation_guard::try_acquire_setup_mutation_guard() {
                break guard;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };

        let mut result = converted_result();
        clear_user_managed_after_conversion(&ws, &ArtifactId::ClaudeRules, &mut result);

        drop(held);
        let still_recorded =
            crate::rules_preferences::is_user_managed(&ws, &ArtifactId::ClaudeRules);
        let _ = std::fs::remove_dir_all(&ws);
        assert!(
            still_recorded,
            "the choice must not change without the guard"
        );
        assert_eq!(result.manual_steps.len(), 1, "{:?}", result.manual_steps);
        assert!(
            result.manual_steps[0].contains("already in progress"),
            "{:?}",
            result.manual_steps
        );
    }
}
