//! Library: the user's refinements below the managed base block of their real rules files.
//!
//! The Library edits exactly the bytes after the END base marker line of the rules file of
//! an enabled harness (`~/.claude/CLAUDE.md`, ...). The BOM, the text above BEGIN, and the block stay
//! byte for byte, which `RulesFile::render_with_suffix` proves on every save.
//!
//! This is the only Library write outside the workspace, so it goes through the destination checks
//! Install uses (`validate_artifact_dest`): the file stays inside its allowlist root, and neither it nor
//! a folder above it may be a symlink. A save holds the mutation lock and the setup mutation guard,
//! re-reads the file inside them, refuses when the user's text changed since it was read (`revision`),
//! backs the file up owner-only, and replaces it atomically. No result or error carries file text.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::process::{run_cmd, ActionResult};
use super::rules::{enabled_rules_artifact, rules_target, user_home};
use super::workspace::{path_arg, setup_workspace_target_path, workspace_target_for_write};
use crate::artifact_registry::ArtifactId;
use crate::rules_block::{self, MalformedReason, RulesConflict, RulesLayout, RulesPlan};
use crate::setup_lifecycle::SetupSurfaceId;

/// Largest refinements text a save accepts (the cap of a personal doc).
const MAX_REFINEMENTS_BYTES: usize = 512 * 1024;

const ABSENT_REASON: &str = "no file yet: install rules from the harness page first";
const LEGACY_REASON: &str = "no base block: convert or install first (harness page, v)";
const LINK_REASON: &str =
    "the file is a link; the app does not write through links: open it (o) and edit where it lives";
const NOT_A_FILE_REASON: &str = "the path is not a regular file";
const CHANGED_REASON: &str = "the file changed on disk since it was opened: reload it";

/// A rules file in the Library list. Carries no file text.
#[derive(Debug, Clone, Serialize)]
pub struct RulesFileSummary {
    pub surface: SetupSurfaceId,
    pub label: String,
    /// Where the file lives, as people know it (`~/.claude/CLAUDE.md`).
    pub file: String,
    pub layout: RulesLayout,
    pub conflict: Option<RulesConflict>,
    pub malformed: Option<MalformedReason>,
    /// Non-blank user lines around the block, counted like Install counts them.
    pub refinement_lines: usize,
    /// Whether the refinements can be edited here.
    pub editable: bool,
    /// Why they cannot; `None` when editable.
    pub reason: Option<String>,
}

/// A rules file opened in the Library.
#[derive(Debug, Clone, Serialize)]
pub struct RulesFileContent {
    #[serde(flatten)]
    pub summary: RulesFileSummary,
    /// The text above the refinements (the user's text above BEGIN and the managed block), with LF
    /// line endings. Read-only here; empty when the file has no block.
    pub before: String,
    /// The text after the END line, with LF line endings: what the editor holds.
    pub refinements: String,
    /// Digest of the user-owned bytes; a save is refused once it no longer matches the file.
    pub revision: Option<String>,
}

/// What the Library found at a rules file's place.
struct Inspected {
    summary: RulesFileSummary,
    /// The destination and the allowlist root a write uses, once both passed Install's checks.
    target: Option<(PathBuf, PathBuf)>,
    /// The file's bytes: a regular file within the size cap, read without following a link.
    bytes: Option<Vec<u8>>,
}

impl Inspected {
    fn refused(mut summary: RulesFileSummary, reason: impl Into<String>) -> Self {
        summary.editable = false;
        summary.reason = Some(reason.into());
        Self {
            summary,
            target: None,
            bytes: None,
        }
    }
}

/// Whether the destination or a folder between it and the allowlist root is a symlink.
fn behind_a_link(dest: &Path, root: &Path) -> bool {
    dest.ancestors()
        .take_while(|path| *path != root && path.starts_with(root))
        .any(|path| fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()))
}

fn display_file(artifact: &ArtifactId, dest: &Path, home: &Path) -> String {
    if let Ok(rel) = dest.strip_prefix(home) {
        return format!("~/{}", rel.to_string_lossy().replace('\\', "/"));
    }
    if let ArtifactId::HarnessRules(harness) = artifact {
        if let Some(rules) = harness.rules() {
            return rules.display_path(home);
        }
    }
    crate::platform_paths::display_path(dest, crate::platform_paths::Platform::current())
}

enum FileRead {
    Absent,
    Bytes(Vec<u8>),
    Refused(RulesLayout, Option<MalformedReason>, String),
}

/// The file's bytes, read only when it is a regular file (never a link) within the size cap.
fn read_rules_bytes(dest: &Path) -> FileRead {
    let too_large = || {
        FileRead::Refused(
            RulesLayout::Malformed,
            Some(MalformedReason::TooLarge),
            MalformedReason::TooLarge.message().to_string(),
        )
    };
    let unreadable = |reason: String| FileRead::Refused(RulesLayout::Malformed, None, reason);
    match fs::symlink_metadata(dest) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return FileRead::Absent,
        Err(error) => return unreadable(format!("cannot inspect the file: {error}")),
        Ok(meta) if meta.file_type().is_symlink() => return unreadable(LINK_REASON.to_string()),
        Ok(meta) if !meta.is_file() => return unreadable(NOT_A_FILE_REASON.to_string()),
        Ok(meta) if meta.len() > rules_block::MAX_RULES_FILE_BYTES => return too_large(),
        Ok(_) => {}
    }
    let file = match fs::File::open(dest) {
        Ok(file) => file,
        Err(error) => return unreadable(format!("cannot read the file: {error}")),
    };
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return unreadable(NOT_A_FILE_REASON.to_string());
    }
    let mut bytes = Vec::new();
    if let Err(error) = file
        .take(rules_block::MAX_RULES_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        return unreadable(format!("cannot read the file: {error}"));
    }
    if bytes.len() as u64 > rules_block::MAX_RULES_FILE_BYTES {
        return too_large();
    }
    FileRead::Bytes(bytes)
}

/// The rules file of an enabled rules surface, as the Library may show and edit it.
fn inspect(
    surface: SetupSurfaceId,
    artifact: &ArtifactId,
    ws_root: &Path,
    home: &Path,
) -> Inspected {
    let label = crate::installation_status::artifact_label(artifact);
    let mut summary = RulesFileSummary {
        surface,
        label: label.clone(),
        file: label,
        layout: RulesLayout::Absent,
        conflict: None,
        malformed: None,
        refinement_lines: 0,
        editable: false,
        reason: None,
    };
    let (dest, root) = match (
        artifact.resolve_dest(home, ws_root),
        artifact.allowlist_root(home, ws_root),
    ) {
        (Ok(dest), Ok(root)) => (dest, root),
        (Err(error), _) | (_, Err(error)) => return Inspected::refused(summary, error),
    };
    summary.file = display_file(artifact, &dest, home);
    // The same checks Install runs before it writes this file.
    if let Err(error) = crate::setup_transaction::validate_artifact_dest(artifact, ws_root, home) {
        let reason = if behind_a_link(&dest, &root) {
            LINK_REASON.to_string()
        } else {
            error
        };
        return Inspected::refused(summary, reason);
    }
    // A file beside the rules file can keep the harness from reading it (Pi); writing would then
    // change nothing the harness sees.
    let preflight = match artifact {
        ArtifactId::HarnessRules(harness) => {
            harness.rules().and_then(|rules| rules.preflight(&dest))
        }
        _ => None,
    };
    let bytes = match read_rules_bytes(&dest) {
        FileRead::Absent => {
            summary.conflict = preflight;
            let reason = preflight.map_or(ABSENT_REASON, RulesConflict::message);
            return Inspected::refused(summary, reason);
        }
        FileRead::Refused(layout, malformed, reason) => {
            summary.layout = layout;
            summary.malformed = malformed;
            return Inspected::refused(summary, reason);
        }
        FileRead::Bytes(bytes) => bytes,
    };
    let reason = match rules_block::parse_bytes(&bytes) {
        Err(malformed) => {
            summary.layout = RulesLayout::Malformed;
            summary.malformed = Some(malformed);
            Some(malformed.message().to_string())
        }
        Ok(None) => {
            summary.layout = RulesLayout::Legacy;
            Some(LEGACY_REASON.to_string())
        }
        Ok(Some(file)) => {
            summary.layout = RulesLayout::Block;
            summary.refinement_lines = file.refinement_lines();
            preflight.map(|conflict| conflict.message().to_string())
        }
    };
    // An edited base block is shown, not refused: the refinements are the user's either way.
    summary.conflict = preflight.or_else(|| recorded_conflict(artifact, ws_root, home));
    summary.editable = reason.is_none();
    summary.reason = reason;
    Inspected {
        summary,
        target: Some((dest, root)),
        bytes: Some(bytes),
    }
}

/// The conflict an Install would report for the file, for display only.
fn recorded_conflict(artifact: &ArtifactId, ws_root: &Path, home: &Path) -> Option<RulesConflict> {
    match crate::setup_transaction::rules_context(artifact, ws_root, home)
        .ok()?
        .assessment
        .plan
    {
        RulesPlan::Conflict(conflict) => Some(conflict),
        _ => None,
    }
}

fn lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn content_of(inspected: Inspected) -> RulesFileContent {
    let parsed = inspected
        .bytes
        .as_deref()
        .and_then(|bytes| rules_block::parse_bytes(bytes).ok().flatten());
    let (before, refinements, revision) = match parsed {
        Some(file) => (
            lf(&[file.prefix, file.begin, file.body, file.end].concat()),
            lf(file.suffix),
            Some(file.user_revision()),
        ),
        None => (String::new(), String::new(), None),
    };
    RulesFileContent {
        summary: inspected.summary,
        before,
        refinements,
        revision,
    }
}

fn surface_key(surface: SetupSurfaceId) -> String {
    serde_json::to_value(surface)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "rules".to_string())
}

/// Replace the refinements of one rules file. Callers hold the mutation lock and the setup
/// mutation guard; everything is read again here, inside them.
fn save_refinements_at(
    surface: SetupSurfaceId,
    artifact: &ArtifactId,
    ws_root: &Path,
    home: &Path,
    content: &str,
    expected_revision: &str,
) -> Result<ActionResult, String> {
    if content.len() > MAX_REFINEMENTS_BYTES {
        return Err("refinements exceed the 512 KB limit".to_string());
    }
    let inspected = inspect(surface, artifact, ws_root, home);
    let label = inspected.summary.label.clone();
    let refused = |reason: &str| format!("{label}: nothing written: {reason}");
    let (Some((dest, root)), Some(bytes), true) = (
        inspected.target,
        inspected.bytes,
        inspected.summary.editable,
    ) else {
        return Err(refused(
            inspected
                .summary
                .reason
                .as_deref()
                .unwrap_or("cannot be edited"),
        ));
    };
    let text =
        std::str::from_utf8(&bytes).map_err(|_| refused(MalformedReason::NotUtf8.message()))?;
    let Ok(Some(file)) = rules_block::parse(text) else {
        return Err(refused("the base block cannot be read"));
    };
    if file.user_revision() != expected_revision {
        return Err(refused(CHANGED_REASON));
    }
    let unchanged = || {
        ActionResult::new(
            true,
            "save_rules_refinements",
            "unchanged".to_string(),
            String::new(),
            Some(0),
        )
    };
    let draft = lf(content);
    if draft == lf(file.suffix) {
        return Ok(unchanged());
    }
    let rendered = file
        .render_with_suffix(&draft)
        .map_err(|refusal| refused(refusal.message()))?;
    if rendered.as_bytes() == bytes.as_slice() {
        return Ok(unchanged());
    }
    // Neither the Library nor Install would read the file again past this size.
    if rendered.len() as u64 > rules_block::MAX_RULES_FILE_BYTES {
        return Err(refused(MalformedReason::TooLarge.message()));
    }
    let backup_path =
        super::content::doc_backup_path(&format!("rules-{}", surface_key(surface)), &dest, None)?;
    super::content::write_doc_backup(&backup_path, text)?;
    crate::safe_filesystem::write_regular_file_atomic(&dest, rendered.as_bytes(), &root)
        .map_err(|error| format!("{label}: write failed: {error}"))?;
    Ok(ActionResult::new(
        true,
        "save_rules_refinements",
        "saved with backup".to_string(),
        String::new(),
        Some(0),
    ))
}

/// The file `o` opens. A link is allowed: it is the user's own file and the OS follows it to where it
/// lives (the app itself never writes through one).
fn open_path(artifact: &ArtifactId, ws_root: &Path, home: &Path) -> Result<PathBuf, String> {
    let dest = artifact.resolve_dest(home, ws_root)?;
    let root = artifact.allowlist_root(home, ws_root)?;
    crate::path_safety::reject_path_escape(&dest, &root, "rules file")?;
    match fs::metadata(&dest) {
        Ok(meta) if meta.is_file() => Ok(dest),
        Ok(_) => Err(NOT_A_FILE_REASON.to_string()),
        Err(_) => Err(ABSENT_REASON.to_string()),
    }
}

/// Read-only: the rules file of every enabled rules surface, with what the Library may do with it.
#[tauri::command(async)]
pub fn list_rules_files() -> Result<Vec<RulesFileSummary>, String> {
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    Ok(SetupSurfaceId::ALL
        .iter()
        .filter_map(|&surface| {
            let artifact = enabled_rules_artifact(surface).ok()?;
            Some(inspect(surface, &artifact, &ws_root, &home).summary)
        })
        .collect())
}

/// Read-only: one rules file split into the read-only text above the refinements and the
/// refinements themselves.
#[tauri::command(async)]
pub fn read_rules_file(surface: String) -> Result<RulesFileContent, String> {
    let (surface_id, artifact) = rules_target(&surface)?;
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    Ok(content_of(inspect(surface_id, &artifact, &ws_root, &home)))
}

/// Replace the text after the END line of one rules file with `content`. Refused unless the file
/// has a well-formed block, is not behind a link, and its user text still has `expected_revision`.
#[tauri::command(async)]
pub fn save_rules_refinements(
    surface: String,
    content: String,
    expected_revision: String,
) -> Result<ActionResult, String> {
    // Writes a file an apply may also write: wait for a running mutation instead of interleaving.
    let _mutation = crate::mutation_lock::acquire();
    let (surface_id, artifact) = rules_target(&surface)?;
    let ws_root = workspace_target_for_write()?;
    let home = user_home()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    save_refinements_at(
        surface_id,
        &artifact,
        &ws_root,
        &home,
        &content,
        &expected_revision,
    )
}

/// Hand one rules file to the OS, to edit what the Library does not (the text above the block).
#[tauri::command]
pub fn open_rules_file(surface: String) -> Result<ActionResult, String> {
    let (_, artifact) = rules_target(&surface)?;
    let ws_root = setup_workspace_target_path()?;
    let home = user_home()?;
    let path = open_path(&artifact, &ws_root, &home)?;
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &home);
    Ok(ActionResult::new(
        ok,
        format!("open_rules_file:{surface}"),
        out,
        err,
        code,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_targets::HarnessId;
    use crate::rules_block::{BEGIN_MARKER, END_MARKER};
    use crate::test_env::{guard, set_test_user_dirs};

    /// Stands for the user's private rules: it must never appear in an error.
    const SECRET: &str = "PRIVATE-RULE-TEXT-7f3a";
    const PREFIX: &str = "# Mine above\n\n";
    const BASE: &str = "# Base\n\n- be careful\n";

    struct Env {
        base: PathBuf,
        home: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-refine-{label}-{nanos}"));
            fs::create_dir_all(base.join("home")).unwrap();
            fs::create_dir_all(base.join("workspace")).unwrap();
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().unwrap();
            unsafe {
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
                std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
                std::env::remove_var("CODEX_HOME");
            }
            let home = user_home().unwrap();
            Self {
                base,
                home,
                _restore: restore,
                _lock: lock,
            }
        }

        fn claude(&self) -> PathBuf {
            self.home.join(".claude/CLAUDE.md")
        }

        fn write(&self, path: &Path, bytes: &[u8]) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }

        fn backups(&self) -> Vec<PathBuf> {
            fs::read_dir(self.base.join("backups/docs"))
                .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
                .unwrap_or_default()
        }

        fn dest(&self, surface: SetupSurfaceId) -> PathBuf {
            let artifact = enabled_rules_artifact(surface).unwrap();
            let ws = setup_workspace_target_path().unwrap();
            artifact.resolve_dest(&self.home, &ws).unwrap()
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn block(body: &str) -> String {
        format!("{BEGIN_MARKER}\n{body}{END_MARKER}\n")
    }

    fn save(surface: &str, content: &str, revision: &str) -> Result<ActionResult, String> {
        save_rules_refinements(surface.into(), content.into(), revision.into())
    }

    fn revision(surface: &str) -> String {
        read_rules_file(surface.into()).unwrap().revision.unwrap()
    }

    fn listed(surface: SetupSurfaceId) -> Option<RulesFileSummary> {
        list_rules_files()
            .unwrap()
            .into_iter()
            .find(|row| row.surface == surface)
    }

    fn update_settings(change: impl FnOnce(&mut crate::settings::AppSettings)) {
        let mut settings = crate::settings::load();
        change(&mut settings);
        crate::settings::save_with_revision_check(settings, None).unwrap();
    }

    /// A file the Library must not edit: listed with the reason, and a save is refused without
    /// echoing the draft, leaving the bytes and the backups alone.
    fn assert_refused(env: &Env, surface: SetupSurfaceId, wire: &str, reason: &str) {
        let row = listed(surface).expect("listed");
        assert!(!row.editable);
        let shown = row.reason.unwrap_or_default();
        assert!(shown.contains(reason), "{shown}");
        assert!(!read_rules_file(wire.into()).unwrap().summary.editable);
        let dest = env.dest(surface);
        let before = fs::read(&dest).ok();
        let error = save(wire, &format!("{SECRET}\n"), "sha256:any").unwrap_err();
        assert!(error.contains(reason), "{error}");
        assert!(!error.contains(SECRET), "{error}");
        assert_eq!(fs::read(&dest).ok(), before);
        assert!(env.backups().is_empty());
    }

    #[test]
    fn a_save_changes_only_the_text_after_the_end_line_and_backs_the_file_up() {
        let env = Env::new("save");
        let original = format!("{PREFIX}{}\n## Old\n- {SECRET}\n", block(BASE));
        env.write(&env.claude(), original.as_bytes());

        let opened = read_rules_file("claude_rules".into()).unwrap();
        assert!(opened.summary.editable, "{:?}", opened.summary.reason);
        assert_eq!(opened.summary.layout, RulesLayout::Block);
        assert_eq!(opened.summary.file, "~/.claude/CLAUDE.md");
        assert_eq!(opened.before, format!("{PREFIX}{}", block(BASE)));
        assert_eq!(opened.refinements, format!("\n## Old\n- {SECRET}\n"));

        let revision = opened.revision.unwrap();
        let result = save("claude_rules", "\n## New\n- small diffs\n", &revision).unwrap();
        assert!(result.success);
        assert_eq!(result.stdout, "saved with backup");
        assert_eq!(
            fs::read_to_string(env.claude()).unwrap(),
            format!("{PREFIX}{}\n## New\n- small diffs\n", block(BASE))
        );

        let backups = env.backups();
        assert_eq!(backups.len(), 1, "{backups:?}");
        let backup_dir = &backups[0];
        let name = backup_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(name.starts_with("rules-claude_rules-"), "{name}");
        let backup = backup_dir.join("CLAUDE.md");
        assert_eq!(fs::read_to_string(&backup).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&backup), 0o600);
            assert_eq!(mode(backup_dir), 0o700);
        }
    }

    #[test]
    fn a_save_keeps_the_bom_the_crlf_endings_and_the_file_mode() {
        let env = Env::new("crlf");
        let original = format!("\u{feff}top\r\n{BEGIN_MARKER}\r\nbase\r\n{END_MARKER}\r\nold\r\n");
        env.write(&env.claude(), original.as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(env.claude(), fs::Permissions::from_mode(0o640)).unwrap();
        }
        let opened = read_rules_file("claude_rules".into()).unwrap();
        assert_eq!(opened.refinements, "old\n");
        assert_eq!(
            opened.before,
            format!("top\n{BEGIN_MARKER}\nbase\n{END_MARKER}\n")
        );

        save("claude_rules", "one\ntwo\n", &opened.revision.unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(env.claude()).unwrap(),
            format!("\u{feff}top\r\n{BEGIN_MARKER}\r\nbase\r\n{END_MARKER}\r\none\r\ntwo\r\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(env.claude()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o640);
        }
    }

    #[test]
    fn an_unchanged_save_writes_nothing_and_backs_nothing_up() {
        let env = Env::new("unchanged");
        let original = format!("{}kept\n", block(BASE)).replace('\n', "\r\n");
        env.write(&env.claude(), original.as_bytes());
        let opened = read_rules_file("claude_rules".into()).unwrap();
        let result = save(
            "claude_rules",
            &opened.refinements,
            &opened.revision.unwrap(),
        )
        .unwrap();
        assert_eq!(result.stdout, "unchanged");
        assert_eq!(fs::read(env.claude()).unwrap(), original.as_bytes());
        assert!(env.backups().is_empty());
    }

    #[test]
    fn a_file_changed_since_it_was_read_is_refused_without_its_text() {
        let env = Env::new("changed");
        env.write(&env.claude(), format!("{}mine\n", block(BASE)).as_bytes());
        let stale = revision("claude_rules");
        let changed = format!("{}mine\n- {SECRET}\n", block(BASE));
        env.write(&env.claude(), changed.as_bytes());

        let error = save("claude_rules", &format!("draft {SECRET}\n"), &stale).unwrap_err();
        assert!(error.contains("changed on disk"), "{error}");
        assert!(
            !error.contains(SECRET) && !error.contains("draft"),
            "{error}"
        );
        assert_eq!(fs::read_to_string(env.claude()).unwrap(), changed);
        assert!(env.backups().is_empty());
    }

    #[test]
    fn a_base_update_after_the_read_keeps_the_draft_saveable_and_the_new_block() {
        let env = Env::new("rebased");
        env.write(&env.claude(), format!("{}mine\n", block(BASE)).as_bytes());
        let opened = revision("claude_rules");
        // Install rewrites the block between the read and the save.
        let newer = block("# Newer base\n");
        env.write(&env.claude(), format!("{newer}mine\n").as_bytes());

        save("claude_rules", "mine, refined\n", &opened).unwrap();
        assert_eq!(
            fs::read_to_string(env.claude()).unwrap(),
            format!("{newer}mine, refined\n")
        );
    }

    #[test]
    fn a_draft_with_a_marker_line_is_refused_and_the_file_is_kept() {
        let env = Env::new("marker");
        let original = format!("{}mine\n", block(BASE));
        env.write(&env.claude(), original.as_bytes());
        let draft = format!("{SECRET}\n{END_MARKER}\n");
        let error = save("claude_rules", &draft, &revision("claude_rules")).unwrap_err();
        assert!(error.contains("marker"), "{error}");
        assert!(!error.contains(SECRET), "{error}");
        assert_eq!(fs::read_to_string(env.claude()).unwrap(), original);
        assert!(env.backups().is_empty());
    }

    #[test]
    fn a_draft_over_the_size_cap_is_refused() {
        let env = Env::new("cap");
        let original = format!("{}mine\n", block(BASE));
        env.write(&env.claude(), original.as_bytes());
        let draft = "x".repeat(MAX_REFINEMENTS_BYTES + 1);
        let error = save("claude_rules", &draft, &revision("claude_rules")).unwrap_err();
        assert!(error.contains("512 KB"), "{error}");
        assert_eq!(fs::read_to_string(env.claude()).unwrap(), original);

        // A draft within its cap that would push the file past the 4 MB read limit.
        let body = format!(
            "{}\n",
            "b".repeat(rules_block::MAX_RULES_FILE_BYTES as usize - 1024)
        );
        let large = block(&body);
        env.write(&env.claude(), large.as_bytes());
        let draft = "x".repeat(4096);
        let error = save("claude_rules", &draft, &revision("claude_rules")).unwrap_err();
        assert!(error.contains("larger than 4 MB"), "{error}");
        assert_eq!(fs::read_to_string(env.claude()).unwrap(), large);
        assert!(env.backups().is_empty());
    }

    #[test]
    fn an_absent_file_is_listed_with_a_reason_and_never_created() {
        let env = Env::new("absent");
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            "no file yet",
        );
        assert!(!env.claude().exists());
    }

    #[test]
    fn a_file_without_a_block_is_refused() {
        let env = Env::new("legacy");
        env.write(&env.claude(), format!("# my rules {SECRET}\n").as_bytes());
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            "no base block",
        );
        let row = listed(SetupSurfaceId::ClaudeRules).unwrap();
        assert_eq!(row.layout, RulesLayout::Legacy);
        let opened = read_rules_file("claude_rules".into()).unwrap();
        assert!(opened.before.is_empty() && opened.refinements.is_empty());
        assert!(opened.revision.is_none());
    }

    #[test]
    fn malformed_non_utf8_and_too_large_files_are_refused_with_their_reason() {
        let env = Env::new("malformed");
        env.write(
            &env.claude(),
            format!("{BEGIN_MARKER}\n{SECRET}\n").as_bytes(),
        );
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            MalformedReason::MissingEnd.message(),
        );
        assert_eq!(
            listed(SetupSurfaceId::ClaudeRules).unwrap().malformed,
            Some(MalformedReason::MissingEnd)
        );

        env.write(&env.claude(), &[0x23, 0xff, 0xfe, b'\n']);
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            MalformedReason::NotUtf8.message(),
        );

        let mut huge = block(BASE).into_bytes();
        huge.resize(rules_block::MAX_RULES_FILE_BYTES as usize + 1, b'x');
        env.write(&env.claude(), &huge);
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            MalformedReason::TooLarge.message(),
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_or_folder_is_never_written_through() {
        let env = Env::new("links");
        let real = env.base.join("dotfiles/CLAUDE.md");
        let original = format!("{}mine {SECRET}\n", block(BASE));
        env.write(&real, original.as_bytes());

        // The file itself is a link.
        fs::create_dir_all(env.home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(&real, env.claude()).unwrap();
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            "is a link",
        );
        assert_eq!(fs::read_to_string(&real).unwrap(), original);
        // `o` still hands the user's own file to the OS, which follows the link.
        let ws = setup_workspace_target_path().unwrap();
        assert_eq!(
            open_path(&ArtifactId::ClaudeRules, &ws, &env.home).unwrap(),
            env.claude()
        );

        // A folder above the file is a link.
        fs::remove_file(env.claude()).unwrap();
        fs::remove_dir(env.home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(env.base.join("dotfiles"), env.home.join(".claude")).unwrap();
        assert_refused(
            &env,
            SetupSurfaceId::ClaudeRules,
            "claude_rules",
            "is a link",
        );
        assert_eq!(fs::read_to_string(&real).unwrap(), original);
    }

    #[test]
    fn a_masked_or_hidden_pi_file_is_refused() {
        let env = Env::new("pi");
        update_settings(|settings| settings.enabled_harness_ids.push(HarnessId::Pi));
        let folder = env.home.join(".pi/agent");
        let pi = folder.join("AGENTS.md");
        env.write(&pi, format!("{}mine {SECRET}\n", block(BASE)).as_bytes());
        env.write(&folder.join("AGENTS.override.md"), b"override\n");
        assert_refused(&env, SetupSurfaceId::PiRules, "pi_rules", "masks this file");
        assert_eq!(
            listed(SetupSurfaceId::PiRules).unwrap().conflict,
            Some(RulesConflict::MaskedByOverride)
        );

        fs::remove_file(folder.join("AGENTS.override.md")).unwrap();
        fs::remove_file(&pi).unwrap();
        env.write(&folder.join("CLAUDE.md"), b"peer\n");
        assert_refused(&env, SetupSurfaceId::PiRules, "pi_rules", "would be hidden");
        assert!(!pi.exists());
    }

    #[test]
    fn a_disabled_harness_or_target_lists_nothing_and_writes_nothing() {
        let env = Env::new("disabled");
        let original = format!("{}mine\n", block(BASE));
        env.write(&env.claude(), original.as_bytes());
        let revision = revision("claude_rules");
        // Pi is off by default: never listed.
        assert!(listed(SetupSurfaceId::PiRules).is_none());

        update_settings(|settings| {
            settings
                .enabled_target_ids
                .retain(|id| id != "claude_rules")
        });
        assert!(listed(SetupSurfaceId::ClaudeRules).is_none());
        assert!(read_rules_file("claude_rules".into()).is_err());
        let error = save("claude_rules", "new\n", &revision).unwrap_err();
        assert!(error.contains("disabled"), "{error}");

        update_settings(|settings| {
            settings.enabled_target_ids.push("claude_rules".to_string());
            settings
                .enabled_harness_ids
                .retain(|id| *id != HarnessId::Claude);
        });
        assert!(listed(SetupSurfaceId::ClaudeRules).is_none());
        let error = save("claude_rules", "new\n", &revision).unwrap_err();
        assert!(error.contains("disabled"), "{error}");
        assert_eq!(fs::read_to_string(env.claude()).unwrap(), original);
        assert!(env.backups().is_empty());
    }

    #[test]
    fn a_save_waits_for_a_running_mutation() {
        let env = Env::new("lock");
        env.write(&env.claude(), format!("{}mine\n", block(BASE)).as_bytes());
        let revision = revision("claude_rules");
        let running = crate::mutation_lock::acquire();
        let saver = std::thread::spawn(move || save("claude_rules", "after\n", &revision));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!saver.is_finished(), "the save must wait for the lock");
        assert_eq!(
            fs::read_to_string(env.claude()).unwrap(),
            format!("{}mine\n", block(BASE))
        );
        drop(running);
        saver.join().unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(env.claude()).unwrap(),
            format!("{}after\n", block(BASE))
        );
    }

    #[test]
    fn a_save_is_refused_while_a_setup_transaction_writes() {
        let env = Env::new("guard");
        let original = format!("{}mine\n", block(BASE));
        env.write(&env.claude(), original.as_bytes());
        let revision = revision("claude_rules");
        let held = loop {
            if let Ok(guard) = crate::setup_mutation_guard::try_acquire_setup_mutation_guard() {
                break guard;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let error = save("claude_rules", "after\n", &revision).unwrap_err();
        drop(held);
        assert!(error.contains("already in progress"), "{error}");
        assert_eq!(fs::read_to_string(env.claude()).unwrap(), original);
    }

    #[test]
    fn open_refuses_a_missing_file_or_a_folder() {
        let env = Env::new("open");
        let ws = setup_workspace_target_path().unwrap();
        let error = open_path(&ArtifactId::ClaudeRules, &ws, &env.home).unwrap_err();
        assert!(error.contains("no file yet"), "{error}");
        fs::create_dir_all(env.claude()).unwrap();
        let error = open_path(&ArtifactId::ClaudeRules, &ws, &env.home).unwrap_err();
        assert!(error.contains("not a regular file"), "{error}");
    }
}
