//! Isolated contract tests for pre-manifest upgrade reconciliation.
//!
//! Uses temp HOME and AGENT_WORKSPACE_PATH only — never the real profile.

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use crate::artifact_registry::{AgentName, ArtifactId, SkillName, WorkspaceRelPath};
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::managed_bootstrap::{LEGACY_SCOUT_AGENT, REMOVED_SKILL_NAMES};
    use crate::managed_state::{
        artifact_identity, managed_state_path, read_managed_state, MANAGED_STATE_SCHEMA_VERSION,
    };
    use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};
    use crate::setup_transaction::{
        self, ArtifactTransactionManifest, TransactionStatus, UninstallArtifactPlan,
    };
    use crate::skill_discovery::discover_skill_catalog;
    use crate::skill_roots::SkillRoot;
    use crate::test_env::{guard, guard::EnvRestore, set_test_user_dirs};

    fn current_bundled_workspace_src() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    fn bundled_workspace_src() -> PathBuf {
        std::env::var_os("AGENT_WORKSPACE_HISTORICAL_FIXTURE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(current_bundled_workspace_src)
    }

    fn temp_base(label: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-recon-{label}-{n}"))
    }

    fn surface_id_string(id: SetupSurfaceId) -> String {
        serde_json::to_value(id)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("{id:?}"))
    }

    fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
        if !dst.exists() {
            fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
        }
        for entry in fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
            let entry = entry.map_err(|e| format!("entry: {e}"))?;
            let ft = entry.file_type().map_err(|e| format!("type: {e}"))?;
            if ft.is_symlink() {
                return Err(format!("refusing symlink {}", entry.path().display()));
            }
            let target = dst.join(entry.file_name());
            if ft.is_dir() {
                copy_dir_all(&entry.path(), &target)?;
            } else if ft.is_file() {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
                }
                fs::copy(entry.path(), &target)
                    .map_err(|e| format!("copy {}: {e}", entry.path().display()))?;
            }
        }
        Ok(())
    }

    const SOURCE_COMMIT: &str = "2d85d94b6f2f1dc06f45f6ec52a22ae97e499588";

    fn historical_bytes(rel: &str) -> Vec<u8> {
        let output = Command::new("git")
            .args([
                "show",
                &format!("{SOURCE_COMMIT}:resources/default-workspace/{rel}"),
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
            .output()
            .expect("run git show");
        assert!(
            output.status.success(),
            "historical source missing: {rel}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn historical_scout_bytes() -> Vec<u8> {
        let output = Command::new("git")
            .args([
                "show",
                "931bfa47e2eadb328a0084f6418099c4ae930377^:resources/default-workspace/agents/scout.md",
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
            .output()
            .expect("run git show");
        assert!(output.status.success(), "historical scout source missing");
        output.stdout
    }

    fn write_historical_removed_skill(dir: &Path) {
        fs::create_dir_all(dir).expect("skill dir");
        let name = dir
            .file_name()
            .and_then(|value| value.to_str())
            .expect("skill name");
        fs::write(
            dir.join("SKILL.md"),
            historical_bytes(&format!("metadata/deprecated-skills/{name}/SKILL.md")),
        )
        .expect("historical skill md");
    }

    fn assert_planned_kind(
        planned: &[crate::setup_transaction::PlannedArtifact],
        artifact: ArtifactId,
        expected: OperationKind,
    ) {
        let found = planned
            .iter()
            .find(|operation| operation.artifact == artifact)
            .unwrap_or_else(|| panic!("missing planned artifact: {artifact:?}"));
        assert_eq!(
            found.kind, expected,
            "unexpected operation for {artifact:?}: {found:?}"
        );
    }

    #[test]
    fn old_current_workspace_file_without_managed_state_is_conflict() {
        // Serialize with the other env-mutating fixtures; parallel runs stomp
        // HOME/AGENT_WORKSPACE_PATH mid-flight for guarded tests otherwise.
        let _guard = guard::lock();
        let _restore = guard::EnvRestore::capture();
        let base = temp_base("historical-conflict");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("base");
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).expect("home");
        copy_dir_all(&bundled_workspace_src(), &ws).expect("copy workspace");
        fs::write(
            ws.join("docs/USING_THE_APP.md"),
            "# Using the App\n\nA practical walkthrough of each app area.\n\n## Workspace page\n\nThe landing page and operations terminal. Shows whether the runtime workspace at `~/.config/agent-workspace` is installed, missing, or needs repair.\n\n- **install** / **repair** / **update resources** — copy bundled defaults into the canonical path (never overwrites existing files). **update resources** appears when the workspace is valid but newer bundled files are missing (for example prompt templates after an app upgrade).\n- **refresh** — reload diagnostics and status\n- **open folder** — open the installed workspace in Finder\n- **VERIFY** — release-check and backup management when the workspace is valid\n\nHarness pages (Codex, OpenCode, Cursor, Claude) provide detailed per-tool diff, sync, and install actions. The Workspace page provides a complementary unified **setup lifecycle** — preview, apply, repair, and rollback across managed surfaces. Use either path; they are not mutually exclusive.\n\n## Harness pages (Codex, OpenCode, Cursor, Claude)\n\nPer-tool diff/sync/install actions and skills install for that tool only. Open the harness from the top navigation after the workspace is installed.\n\n## Library\n\nBrowse and edit workspace content in a three-panel layout:\n\n1. **Source rail** (left) — Docs, Rules, Skills, Agents, Configs, Brain Setup\n2. **Item sidebar** (middle) — browse items by section or filter\n3. **Content pane** (right) — preview or edit selected content\n\n### Docs\n\nCurated docs grouped under Start, Guides, Reference, Prompt Templates, and Context. Prompt Templates ships as `docs/prompt-templates/*.md` after install, repair, or update resources. Use \"open\" for your system editor or edit in-app.\n\n### Rules\n\nView and edit `templates/global-agent-rules.md`. Synced to agent rule paths from harness pages.\n\n### Skills\n\nBrowse bundled skills in Library. Install or sync from harness pages (per-tool preview and apply) or from the Workspace unified setup lifecycle (apply/repair across harnesses). These paths are complementary.\n\n### Agents\n\nView and edit `agents/*.md` prompt definitions.\n\n### Configs\n\nView and edit `templates/opencode.json` and related config sources.\n\n## Brain Setup (Library)\n\nCopy a durable instruction block for external assistants (skill routing, security, verification). Does not run agents or change sync targets.\n\n## Settings\n\nAppearance, global text size, and theme colors. Settings autosave.\n\n## Tools\n\nIn-app utilities separate from harness sync:\n\n- **Prompt Loops** — copy/paste prompt templates with skill-weaving for agent runs.\n- **Repo Dashboard** — local git/gh snapshot of a checkout with three pages: Overview (summary, charts, recent activity, contributors), Work (active and done items from docs/gh), and Docs (searchable Markdown reader).\n\n## Dry-run before sync\n\n| Operation | Preview | Apply |\n|-----------|---------|-------|\n| Rules sync | Diff Rules | Sync Rules |\n| OpenCode config sync | Diff Configs | Sync Configs |\n| Codex config | Preview in setup lifecycle | Apply managed fields |\n| Skills install | Dry-run Skills | Install Skills |\n\n## Setup lifecycle (Workspace)\n\n- **Preview** issues a short-lived token and fingerprint; **apply** and **repair** consume the token only after complete backend preflight and immediately before the first mutation.\n- Failed preflight leaves the token valid for retry.\n- Failed apply or repair with a transaction ID remains available for **rollback** when dry-run shows eligible artifacts.\n- Explicit rollback persists per-artifact `in_flight` before each restore, then `restored` or `failed` after validation; interrupted rollbacks reconcile without double-restoring completed artifacts.\n- Transactions in `rolling_back` or `rollback_failed` can be resumed; already `restored` artifacts are skipped; when none remain eligible the transaction finalizes without further filesystem changes.\n- Rollback dry-run lists already restored, still-required, and conflicted artifacts and performs zero manifest writes.\n- Codex managed apply and rollback preserve same-line inline comments on managed scalar fields via the line-preserving merge script, or refuse safely with zero mutation on conflict.\n- Symlinked parents and dangling symlinks in managed paths are rejected.\n\n## Backups\n\nApplying changes that overwrite diverged target files creates backups under the platform-resolved Agent Workspace backup root (for example `~/Library/Application Support/ai.agentworkspace.app/backups` on macOS).\n\n## Release check\n\nRun **release-check** from Workspace VERIFY when the installed workspace includes `scripts/release-check.sh` (the app repo checkout; bundled starter may not include it).\n\nSee [WORKFLOWS.md](WORKFLOWS.md) for common patterns.\n",
        )
        .expect("old workspace doc");
        set_test_user_dirs(&home);
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("home");
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_PATH",
                ws.canonicalize().unwrap().to_string_lossy().as_ref(),
            );
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }
        let artifact = crate::artifact_registry::ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new("docs/USING_THE_APP.md").unwrap(),
        );
        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &[crate::setup_lifecycle::SetupSurfaceId::WorkspaceBundle],
            &ws,
            &resolved_home,
        )
        .expect("plan");
        let found = planned
            .iter()
            .find(|op| op.artifact == artifact)
            .expect("workspace file operation");
        assert_eq!(found.kind, OperationKind::Update);
        let _ = fs::remove_dir_all(&base);
    }

    /// The folder an older version installed the skills of `harness` into.
    fn harness_root(harness: &str) -> SkillRoot {
        match harness {
            "opencode" => SkillRoot::OpenCode,
            "codex" => SkillRoot::CodexHome,
            "claude" => SkillRoot::Claude,
            _ => SkillRoot::Cursor,
        }
    }

    /// A skills folder under the HOME of the test.
    fn skills_dir(root: SkillRoot) -> PathBuf {
        let home = crate::cursor_profile_paths::resolve_user_home().expect("home");
        root.path(&home).expect("skills folder")
    }

    fn source_skill_count() -> usize {
        discover_skill_catalog(&bundled_workspace_src())
            .expect("source catalog")
            .len()
    }

    #[derive(Clone, Copy)]
    enum HarnessSkillLineEndings {
        Native,
        Crlf,
    }

    fn to_crlf(raw: &[u8]) -> Vec<u8> {
        String::from_utf8_lossy(raw)
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes()
    }

    fn install_source_skills_to_harness(harness: &str, line_endings: HarnessSkillLineEndings) {
        let mut catalog = discover_skill_catalog(&bundled_workspace_src()).expect("catalog");
        catalog.sort_by(|a, b| a.name.cmp(&b.name));
        let dest_root = skills_dir(harness_root(harness));
        fs::create_dir_all(&dest_root).expect("dest root");
        for skill in &catalog {
            let target = dest_root.join(&skill.name);
            copy_dir_all(&skill.source_dir, &target).expect("copy skill");
            if matches!(line_endings, HarnessSkillLineEndings::Crlf) {
                let skill_md = target.join("SKILL.md");
                let raw = fs::read(&skill_md).expect("read copied skill");
                fs::write(&skill_md, to_crlf(&raw)).expect("write crlf skill");
            }
        }
    }

    fn install_removed_skills_to_harness(_home: &Path, harness: &str) {
        let dest_root = skills_dir(harness_root(harness));
        fs::create_dir_all(&dest_root).expect("dest root");
        for name in REMOVED_SKILL_NAMES {
            write_historical_removed_skill(&dest_root.join(name));
        }
    }

    fn install_codex_legacy_skills(home: &Path) {
        let legacy = SkillRoot::Agents.path(home).expect("legacy root");
        fs::create_dir_all(&legacy).expect("legacy root");
        let mut catalog = discover_skill_catalog(&bundled_workspace_src()).expect("catalog");
        catalog.sort_by(|a, b| a.name.cmp(&b.name));
        for skill in &catalog {
            copy_dir_all(&skill.source_dir, &legacy.join(&skill.name)).expect("legacy copy");
        }
        for name in REMOVED_SKILL_NAMES {
            write_historical_removed_skill(&legacy.join(name));
        }
        fs::create_dir_all(legacy.join(".system")).expect(".system");
        fs::write(legacy.join(".system/prompt.md"), "keep me").expect(".system file");
        // Codex's own skills below its home are not the app's either.
        let codex_system = skills_dir(SkillRoot::CodexHome).join(".system/prompt.md");
        fs::create_dir_all(codex_system.parent().expect("parent")).expect("codex .system");
        fs::write(codex_system, "codex own").expect("codex .system file");
        fs::create_dir_all(legacy.join("user-custom-skill")).expect("custom skill dir");
        fs::write(
            legacy.join("user-custom-skill/SKILL.md"),
            b"---\nname: user-custom-skill\ndescription: user owned\n---\n",
        )
        .expect("custom skill");
    }

    fn seed_old_installation_workspace(ws: &Path) {
        fs::create_dir_all(ws.join("metadata/deprecated-skills")).expect("meta dir");
        fs::write(
            ws.join("metadata/deprecated-skills.json"),
            "{\n  \"version\": 1,\n  \"skills\": [\n    \"agent-report-review\",\n    \"caveman\",\n    \"dependency-evaluation\",\n    \"grill-me\",\n    \"grill-with-docs\",\n    \"improve-codebase-architecture\",\n    \"nextjs-product-slice\",\n    \"supabase-rls-review\",\n    \"to-prd\",\n    \"triage\",\n    \"woocommerce-pdp-review\",\n    \"write-a-skill\"\n  ]\n}\n",
        )
        .expect("meta json");
        for name in REMOVED_SKILL_NAMES {
            let raw = historical_bytes(&format!("metadata/deprecated-skills/{name}/SKILL.md"));
            fs::create_dir_all(ws.join("metadata/deprecated-skills").join(name))
                .expect("deprecated skill dir");
            fs::write(
                ws.join("metadata/deprecated-skills")
                    .join(name)
                    .join("SKILL.md"),
                &raw,
            )
            .expect("deprecated skill");
            fs::create_dir_all(ws.join("skills").join(name)).expect("runtime skill dir");
            fs::write(ws.join("skills").join(name).join("SKILL.md"), raw).expect("runtime skill");
        }
        fs::write(ws.join("agents/scout.md"), historical_scout_bytes()).expect("runtime scout");
        fs::write(ws.join("user-owned.txt"), "keep runtime file").expect("runtime unknown");
    }

    fn install_agent_files(source: &Path, destination: &Path) {
        fs::create_dir_all(destination).expect("agent destination");
        for entry in fs::read_dir(source).expect("agent source") {
            let entry = entry.expect("agent entry");
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("md")
            {
                fs::copy(entry.path(), destination.join(entry.file_name())).expect("copy agent");
            }
        }
    }

    struct OldInstallFixture {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
    }

    impl OldInstallFixture {
        fn build() -> Self {
            Self::build_with_harness_skill_line_endings(HarnessSkillLineEndings::Native)
        }

        fn build_with_harness_skill_line_endings(line_endings: HarnessSkillLineEndings) -> Self {
            let base = temp_base("fixture");
            let _ = fs::remove_dir_all(&base);
            let home = base.join("home");
            let ws = base.join("workspace");
            fs::create_dir_all(&home).expect("home");
            let source = bundled_workspace_src();
            copy_dir_all(&source, &ws).expect("copy workspace");
            seed_old_installation_workspace(&ws);

            set_test_user_dirs(&home);
            let resolved_home = crate::platform_paths::resolve_user_home(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("home");

            for harness in ["opencode", "codex", "claude", "cursor"] {
                install_source_skills_to_harness(harness, line_endings);
                install_removed_skills_to_harness(&resolved_home, harness);
            }
            install_codex_legacy_skills(&resolved_home);

            let oc_agents = resolved_home.join(".config/opencode/agents");
            install_agent_files(&ws.join("agents"), &oc_agents);
            fs::write(oc_agents.join("scout.md"), historical_scout_bytes())
                .expect("opencode scout");
            fs::write(oc_agents.join("user-agent.md"), "keep harness file")
                .expect("opencode unknown");

            let cursor_agents = resolved_home.join(".cursor/agents");
            install_agent_files(&ws.join("templates/cursor/agents"), &cursor_agents);
            fs::write(cursor_agents.join("user-agent.md"), "keep cursor agent")
                .expect("cursor unknown");

            let opencode_skills = skills_dir(SkillRoot::OpenCode);
            fs::write(
                opencode_skills
                    .join(REMOVED_SKILL_NAMES[1])
                    .join("SKILL.md"),
                "modified stale harness skill",
            )
            .expect("modified harness skill");
            fs::write(
                ws.join("skills")
                    .join(REMOVED_SKILL_NAMES[0])
                    .join("SKILL.md"),
                format!(
                    "---\nname: {}\ndescription: user modified stale runtime skill\ntargets: [codex, opencode, claude, cursor]\n---\n",
                    REMOVED_SKILL_NAMES[0]
                ),
            )
            .expect("modified runtime skill");
            fs::write(
                SkillRoot::Agents
                    .path(&resolved_home)
                    .expect("legacy root")
                    .join(REMOVED_SKILL_NAMES[2])
                    .join("SKILL.md"),
                "modified legacy Codex skill",
            )
            .expect("modified Codex skill");

            let mut current =
                discover_skill_catalog(&bundled_workspace_src()).expect("current catalog");
            current.sort_by(|a, b| a.name.cmp(&b.name));
            fs::write(
                opencode_skills
                    .join(&current.first().expect("current skill").name)
                    .join("SKILL.md"),
                "same-name unowned custom skill",
            )
            .expect("custom same-name skill");

            let ws_canon = ws.canonicalize().unwrap_or_else(|_| ws.clone());
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", ws_canon.to_string_lossy().as_ref());
                std::env::set_var(
                    "AGENT_WORKSPACE_BACKUP_DIR",
                    base.join("backups").to_string_lossy().as_ref(),
                );
            }
            let bootstrap = crate::managed_bootstrap::infer_bootstrap_records(
                &ws_canon,
                &resolved_home,
                &std::collections::HashSet::new(),
            )
            .expect("bootstrap records")
            .records;
            assert!(
                bootstrap.iter().any(|record| {
                    record.identity.contains("\"scout\"")
                        && record.surface.as_deref() == Some("open_code_agents")
                }),
                "exact historical scout should be bootstrap-owned: {bootstrap:?}"
            );

            Self {
                base,
                home: resolved_home,
                ws: ws_canon,
            }
        }

        /// Skill directories in `root`, Codex's own dot directories not counted.
        fn skill_count(&self, root: SkillRoot) -> usize {
            let root = root.path(&self.home).expect("dest");
            if !root.is_dir() {
                return 0;
            }
            fs::read_dir(&root)
                .expect("read skills")
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter(|e| {
                    let file_name = e.file_name();
                    let name = file_name.to_string_lossy();
                    !name.starts_with('.')
                })
                .count()
        }

        fn cleanup(self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn reconciliation_surface_ids() -> Vec<SetupSurfaceId> {
        vec![
            SetupSurfaceId::WorkspaceBundle,
            SetupSurfaceId::Skills,
            SetupSurfaceId::OpenCodeAgents,
        ]
    }

    fn preview_reconciliation() -> SetupPlan {
        let surfaces: Vec<String> = reconciliation_surface_ids()
            .iter()
            .copied()
            .map(surface_id_string)
            .collect();
        preview_setup(surfaces).expect("preview reconciliation surfaces")
    }

    fn apply_surfaces_from_preview(plan: &SetupPlan) -> SetupResult {
        let mut surfaces: Vec<String> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .map(|op| surface_id_string(op.surface))
            .collect();
        surfaces.sort();
        surfaces.dedup();
        apply_setup(
            surfaces,
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply_setup")
    }

    fn display_path_ends_with(path: &str, parts: &[&str]) -> bool {
        let mut suffix = PathBuf::new();
        for part in parts {
            suffix.push(part);
        }
        Path::new(path).ends_with(suffix)
    }

    fn collect_regular_files_under(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
        let mut files = BTreeMap::new();
        if !root.exists() {
            return Ok(files);
        }
        let mut stack = vec![root.to_path_buf()];
        while let Some(current) = stack.pop() {
            let entries = fs::read_dir(&current).map_err(|e| format!("read_dir: {e}"))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("entry: {e}"))?;
                let ft = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
                let path = entry.path();
                if ft.is_symlink() {
                    return Err("refusing symlink in snapshot".to_string());
                }
                if ft.is_dir() {
                    stack.push(path);
                } else if ft.is_file() {
                    let bytes = fs::read(&path).map_err(|e| format!("read: {e}"))?;
                    files.insert(path, bytes);
                }
            }
        }
        Ok(files)
    }

    fn relativize_snapshot(
        base: &Path,
        snapshot: BTreeMap<PathBuf, Vec<u8>>,
    ) -> BTreeMap<PathBuf, Vec<u8>> {
        snapshot
            .into_iter()
            .map(|(path, bytes)| {
                let rel = path.strip_prefix(base).unwrap_or(&path).to_path_buf();
                (rel, bytes)
            })
            .collect()
    }

    fn snapshot_artifact_dest(
        dest: &Path,
        into: &mut BTreeMap<PathBuf, Vec<u8>>,
    ) -> Result<(), String> {
        if dest.is_file() {
            let bytes = fs::read(dest).map_err(|e| format!("read: {e}"))?;
            into.insert(dest.to_path_buf(), bytes);
        } else if dest.is_dir() {
            for (path, bytes) in collect_regular_files_under(dest)? {
                into.insert(path, bytes);
            }
        }
        Ok(())
    }

    fn build_pre_uninstall_snapshot(
        ws: &Path,
        home: &Path,
        plan: &UninstallArtifactPlan,
        fixtures: &[(PathBuf, Vec<u8>)],
    ) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
        let mut snap = BTreeMap::new();
        for planned in &plan.removals {
            let dest = planned
                .artifact
                .resolve_dest(home, ws)
                .map_err(|e| format!("resolve removable: {e}"))?;
            snapshot_artifact_dest(&dest, &mut snap)?;
        }
        for artifact in &plan.merged {
            let dest = artifact
                .resolve_dest(home, ws)
                .map_err(|e| format!("resolve merged: {e}"))?;
            snapshot_artifact_dest(&dest, &mut snap)?;
        }
        let state_path = managed_state_path(ws);
        if state_path.is_file() {
            let bytes = fs::read(&state_path).map_err(|e| format!("read managed state: {e}"))?;
            snap.insert(state_path, bytes);
        }
        for (path, expected) in fixtures {
            let actual = fs::read(path).map_err(|e| format!("read fixture: {e}"))?;
            assert_eq!(actual, *expected, "fixture bytes changed before snapshot");
            snap.insert(path.clone(), expected.clone());
        }
        Ok(snap)
    }

    fn scoped_runtime_snapshot(
        home: &Path,
        ws: &Path,
    ) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
        let mut snap = collect_regular_files_under(ws)?;
        for (path, bytes) in collect_regular_files_under(home)? {
            snap.insert(path, bytes);
        }
        Ok(snap)
    }

    fn removal_identities(plan: &UninstallArtifactPlan) -> BTreeSet<String> {
        plan.removals
            .iter()
            .map(|planned| artifact_identity(&planned.artifact))
            .collect()
    }

    fn read_transaction_manifest(
        backup_root: &Path,
        transaction_id: &str,
        ws: &Path,
    ) -> ArtifactTransactionManifest {
        let manifest_path = backup_root
            .join("setup")
            .join(transaction_id)
            .join("manifest.json");
        let raw = fs::read_to_string(&manifest_path).expect("read manifest");
        let manifest: ArtifactTransactionManifest =
            serde_json::from_str(&raw).expect("parse manifest");
        setup_transaction::validate_manifest(&manifest, ws).expect("valid manifest");
        manifest
    }

    #[test]
    fn fresh_profile_installs_workspace_through_unified_setup() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let base = temp_base("fresh");
        let home = base.join("home");
        let workspace = base.join("runtime");
        fs::create_dir_all(&home).expect("home");
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", workspace.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }
        let status = crate::installation_status::status_for_surfaces(
            &[SetupSurfaceId::WorkspaceBundle],
            &workspace,
            &home,
        )
        .expect("fresh status");
        assert_eq!(
            status.state,
            crate::installation_status::InstallationState::NotInstalled
        );
        let plan = preview_setup(vec![surface_id_string(SetupSurfaceId::WorkspaceBundle)])
            .expect("fresh preview");
        let result = apply_surfaces_from_preview(&plan);
        assert!(result.success, "fresh apply: {}", result.message);
        assert_eq!(
            discover_skill_catalog(&workspace)
                .expect("installed catalog")
                .len(),
            25
        );
        assert!(read_managed_state(&workspace).is_some());
        let current = crate::installation_status::status_for_surfaces(
            &[SetupSurfaceId::WorkspaceBundle],
            &workspace,
            &home,
        )
        .expect("current status");
        assert_eq!(
            current.state,
            crate::installation_status::InstallationState::Current
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn pre_manifest_fixture_detects_stale_removals_before_apply() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();
        assert_eq!(
            discover_skill_catalog(&fixture.ws)
                .expect("runtime catalog")
                .len(),
            37
        );
        assert_eq!(
            fs::read_dir(fixture.ws.join("agents"))
                .expect("runtime agents")
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("md")
                })
                .count(),
            7
        );
        let expected_harness_skills = source_skill_count() + REMOVED_SKILL_NAMES.len();
        for harness in ["opencode", "codex", "claude", "cursor"] {
            assert_eq!(
                fixture.skill_count(harness_root(harness)),
                expected_harness_skills,
                "{harness} should include the complete source and removed skill inventory"
            );
        }
        assert_eq!(
            fs::read_dir(SkillRoot::Agents.path(&fixture.home).expect("legacy root"))
                .expect("legacy Codex")
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.path().is_dir()
                        && !entry.file_name().to_string_lossy().starts_with('.')
                        && entry.file_name() != "user-custom-skill"
                })
                .count(),
            expected_harness_skills
        );
        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &reconciliation_surface_ids(),
            &fixture.ws,
            &fixture.home,
        )
        .expect("artifact plan");
        assert!(
            planned.iter().any(|p| p.kind == OperationKind::Remove),
            "expected Remove artifacts in plan: {:?}",
            planned
        );

        let coverage_name = REMOVED_SKILL_NAMES[3];
        let coverage_skill = SkillName::new(coverage_name).expect("coverage skill");
        for artifact in [
            ArtifactId::WorkspaceFile(
                WorkspaceRelPath::new(format!("skills/{coverage_name}/SKILL.md"))
                    .expect("runtime skill path"),
            ),
            ArtifactId::WorkspaceFile(
                WorkspaceRelPath::new(format!(
                    "metadata/deprecated-skills/{coverage_name}/SKILL.md"
                ))
                .expect("deprecated skill path"),
            ),
            ArtifactId::skill_md(SkillRoot::OpenCode, coverage_skill.clone()),
            ArtifactId::skill_md(SkillRoot::CodexHome, coverage_skill.clone()),
            ArtifactId::skill_md(SkillRoot::Claude, coverage_skill.clone()),
            ArtifactId::skill_md(SkillRoot::Cursor, coverage_skill.clone()),
            ArtifactId::skill_md(SkillRoot::Agents, coverage_skill),
        ] {
            assert_planned_kind(&planned, artifact, OperationKind::Remove);
        }
        assert_planned_kind(
            &planned,
            ArtifactId::WorkspaceFile(
                WorkspaceRelPath::new("metadata/deprecated-skills.json")
                    .expect("deprecated metadata path"),
            ),
            OperationKind::Remove,
        );
        assert_planned_kind(
            &planned,
            ArtifactId::WorkspaceFile(
                WorkspaceRelPath::new("agents/scout.md").expect("runtime scout path"),
            ),
            OperationKind::Remove,
        );
        assert_planned_kind(
            &planned,
            ArtifactId::OpenCodeAgent(
                AgentName::new(LEGACY_SCOUT_AGENT).expect("opencode scout name"),
            ),
            OperationKind::Remove,
        );

        let plan = preview_reconciliation();
        assert!(
            plan.operations
                .iter()
                .any(|op| op.kind == OperationKind::Remove),
            "expected Remove operations in surface preview: {:?}",
            plan.operations
        );
        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_upgrade_reconciles_to_canonical_inventory() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();

        let plan = preview_reconciliation();
        let result = apply_surfaces_from_preview(&plan);
        assert!(result.success, "apply failed: {}", result.message);

        let catalog = discover_skill_catalog(&fixture.ws).expect("catalog");
        assert_eq!(
            catalog.len(),
            26,
            "modified stale runtime skill is preserved"
        );
        assert!(
            fixture
                .ws
                .join("skills")
                .join(REMOVED_SKILL_NAMES[0])
                .join("SKILL.md")
                .is_file(),
            "modified runtime skill should be preserved"
        );

        assert!(
            !fixture.ws.join("metadata/deprecated-skills.json").exists(),
            "deprecated metadata json should be removed"
        );
        // All four harnesses are enabled and Codex has its default home: the skills live in
        // `~/.claude/skills` and `~/.agents/skills`, and nothing else is left of the app's copies.
        assert_eq!(
            fixture.skill_count(SkillRoot::Claude),
            25,
            "Claude should have 25 skills after reconciliation"
        );
        for removed in REMOVED_SKILL_NAMES {
            assert!(
                !skills_dir(SkillRoot::Claude).join(removed).exists(),
                "Claude should not retain removed skill {removed}"
            );
        }
        assert_eq!(
            fixture.skill_count(SkillRoot::CodexHome),
            0,
            "the app's copies in $CODEX_HOME/skills move to ~/.agents/skills"
        );
        assert!(
            skills_dir(SkillRoot::CodexHome)
                .join(".system/prompt.md")
                .is_file(),
            "Codex's own .system folder is never touched"
        );
        assert_eq!(
            fixture.skill_count(SkillRoot::Cursor),
            0,
            "~/.cursor/skills holds no app copy any more"
        );
        // The OpenCode folder keeps what is not the app's to remove: a modified stale skill and a
        // current name whose SKILL.md was replaced by the user's own.
        assert_eq!(
            fixture.skill_count(SkillRoot::OpenCode),
            2,
            "only the modified stale skill and the same-name custom skill remain"
        );
        assert!(
            skills_dir(SkillRoot::OpenCode)
                .join(REMOVED_SKILL_NAMES[1])
                .is_dir(),
            "modified stale OpenCode skill should be preserved"
        );

        assert!(
            !fixture
                .home
                .join(".config/opencode/agents/scout.md")
                .exists(),
            "legacy opencode scout agent should be removed"
        );

        let legacy = SkillRoot::Agents.path(&fixture.home).expect("agents root");
        assert_eq!(
            fixture.skill_count(SkillRoot::Agents),
            25 + 2,
            "25 current skills, the modified stale skill and the user's own skill"
        );
        assert!(
            legacy.join(".system/prompt.md").is_file(),
            "codex legacy .system should be preserved"
        );
        assert!(
            legacy.join(REMOVED_SKILL_NAMES[2]).is_dir(),
            "modified legacy Codex skill should be preserved"
        );
        assert!(
            legacy.join("user-custom-skill/SKILL.md").is_file(),
            "unknown legacy Codex skill should be preserved"
        );
        assert!(
            fixture.ws.join("user-owned.txt").is_file(),
            "unknown runtime file should be preserved"
        );
        for removed in REMOVED_SKILL_NAMES {
            assert!(
                !skills_dir(SkillRoot::CodexHome).join(removed).exists(),
                "$CODEX_HOME/skills should not retain removed skill {removed}"
            );
        }

        let managed = read_managed_state(&fixture.ws).expect("managed-state.json");
        assert_eq!(managed.schema_version, MANAGED_STATE_SCHEMA_VERSION);
        assert!(
            managed_state_path(&fixture.ws).is_file(),
            "managed state should be written"
        );
        let exact_claude = ArtifactId::skill_md(
            SkillRoot::Claude,
            SkillName::new("accessibility-review").expect("canonical skill"),
        );
        assert!(
            managed
                .artifacts
                .iter()
                .any(|record| record.identity
                    == crate::managed_state::artifact_identity(&exact_claude)),
            "selected exact current artifacts should be adopted"
        );
        let conflicted = ArtifactId::skill_md(
            SkillRoot::OpenCode,
            SkillName::new("accessibility-review").expect("canonical skill"),
        );
        assert!(
            managed
                .artifacts
                .iter()
                .all(|record| record.identity
                    != crate::managed_state::artifact_identity(&conflicted)),
            "same-name unowned conflict must remain unclaimed"
        );

        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_crlf_harness_skills_upgrade_to_the_shared_skill() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture =
            OldInstallFixture::build_with_harness_skill_line_endings(HarnessSkillLineEndings::Crlf);

        let plan = preview_reconciliation();
        let result = apply_surfaces_from_preview(&plan);
        assert!(result.success, "apply failed: {}", result.message);

        let name = SkillName::new("accessibility-review").expect("canonical skill");
        let exact_claude = ArtifactId::skill_md(SkillRoot::Claude, name.clone());
        let managed = read_managed_state(&fixture.ws).expect("managed-state.json");
        assert!(
            managed
                .artifacts
                .iter()
                .any(|record| record.identity
                    == crate::managed_state::artifact_identity(&exact_claude)),
            "CRLF pre-adapter harness skill should be adopted and upgraded"
        );
        let source = exact_claude
            .resolve_source(&fixture.ws)
            .expect("skill source");
        let dest = exact_claude
            .resolve_dest(&fixture.home, &fixture.ws)
            .expect("skill dest");
        assert_eq!(
            fs::read(dest).expect("installed skill"),
            fs::read(source).expect("source skill"),
            "installed Claude skill should be the shared canonical skill"
        );
        // The CRLF copies in the folders nobody needs any more were adopted too, and removed.
        for root in [SkillRoot::Cursor, SkillRoot::CodexHome] {
            assert!(
                !ArtifactId::skill_md(root, name.clone())
                    .resolve_dest(&fixture.home, &fixture.ws)
                    .expect("skill dest")
                    .exists(),
                "{root:?}"
            );
        }

        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_upgrade_is_idempotent_on_second_apply() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();

        let first = apply_surfaces_from_preview(&preview_reconciliation());
        assert!(first.success, "first apply: {}", first.message);

        let second_plan = preview_reconciliation();
        assert!(
            !second_plan
                .operations
                .iter()
                .any(|op| op.kind.needs_apply()),
            "second preview should be current: {:?}",
            second_plan.operations
        );

        fixture.cleanup();
    }

    #[test]
    fn pre_manifest_upgrade_rollback_restores_removed_stale_workspace_file() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();

        let surfaces = vec![surface_id_string(SetupSurfaceId::WorkspaceBundle)];
        let plan = preview_setup(surfaces).expect("preview workspace bundle");
        let applied = apply_surfaces_from_preview(&plan);
        assert!(applied.success, "apply: {}", applied.message);
        assert!(
            !fixture.ws.join("metadata/deprecated-skills.json").exists(),
            "stale workspace metadata should be removed before rollback"
        );

        let rolled =
            rollback_setup_transaction(applied.transaction_id.clone(), false).expect("rollback");
        assert!(
            fixture.ws.join("metadata/deprecated-skills.json").is_file(),
            "rollback should restore removed workspace metadata (success={}, message={}, failed={:?})",
            rolled.success,
            rolled.message,
            rolled.failed
        );
        assert!(
            !managed_state_path(&fixture.ws).exists(),
            "rollback must restore previous managed-state absence"
        );

        fixture.cleanup();
    }

    #[test]
    fn bootstrap_does_not_treat_scout_skill_name_as_removed_skill() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();
        let dest = skills_dir(SkillRoot::OpenCode);
        fs::create_dir_all(dest.join(LEGACY_SCOUT_AGENT)).expect("scout skill");
        fs::write(
            dest.join(LEGACY_SCOUT_AGENT).join("SKILL.md"),
            b"user-owned scout skill",
        )
        .expect("scout skill file");
        let plan =
            preview_setup(vec![surface_id_string(SetupSurfaceId::Skills)]).expect("preview skills");
        let remove_scout = plan
            .operations
            .iter()
            .any(|op| op.kind == OperationKind::Remove && op.summary.contains(LEGACY_SCOUT_AGENT));
        assert!(
            !remove_scout,
            "scout skill dir should not be auto-removed unless in REMOVED_SKILL_NAMES"
        );
        fixture.cleanup();
    }

    #[test]
    fn unreadable_artifact_does_not_discard_other_bootstrap_adoptions() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let base = temp_base("bootstrap-partial");
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).expect("home");
        copy_dir_all(&current_bundled_workspace_src(), &ws).expect("copy workspace");
        set_test_user_dirs(&home);
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("home");
        let ws = ws.canonicalize().expect("canonical workspace");
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }
        // An exact historical scout agent is adoptable.
        let scout_dest = resolved_home.join(".config/opencode/agents/scout.md");
        fs::create_dir_all(scout_dest.parent().unwrap()).expect("agents dir");
        fs::write(&scout_dest, historical_scout_bytes()).expect("scout agent");
        // The user's OpenCode config has comments, so it does not parse as JSON.
        fs::write(
            resolved_home.join(".config/opencode/opencode.json"),
            "// my own notes\n{ \"theme\": \"dark\" }\n",
        )
        .expect("commented config");
        // One artifact that cannot be read at all.
        let skill = discover_skill_catalog(&current_bundled_workspace_src())
            .expect("catalog")
            .into_iter()
            .next()
            .expect("skill");
        let unreadable = skills_dir(SkillRoot::Claude)
            .join(&skill.name)
            .join("SKILL.md");
        fs::create_dir_all(unreadable.parent().unwrap()).expect("skill dir");
        fs::write(&unreadable, "unreadable").expect("skill file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).expect("chmod");
        }
        let can_read = fs::read(&unreadable).is_ok();

        let scout = ArtifactId::OpenCodeAgent(AgentName::new(LEGACY_SCOUT_AGENT).expect("scout"));
        let scout_identity = artifact_identity(&scout);
        let inference = crate::managed_bootstrap::infer_bootstrap_records(
            &ws,
            &resolved_home,
            &std::collections::HashSet::new(),
        )
        .expect("inference survives per-artifact failures");
        assert!(
            inference
                .records
                .iter()
                .any(|r| r.identity == scout_identity),
            "scout adoption must survive: {inference:?}"
        );
        if !can_read {
            assert!(
                inference
                    .skipped
                    .iter()
                    .any(|reason| reason.contains(&skill.name)),
                "unreadable artifact must be reported: {:?}",
                inference.skipped
            );
        }
        // Artifacts that already have a managed record are not inspected again.
        let known = std::collections::HashSet::from([scout_identity.clone()]);
        let again = crate::managed_bootstrap::infer_bootstrap_records(&ws, &resolved_home, &known)
            .expect("inference with known records");
        assert!(again.records.iter().all(|r| r.identity != scout_identity));

        // End to end: the adoption still turns the old scout into a removal.
        let planned = setup_transaction::plan_artifacts_for_surfaces(
            &[
                SetupSurfaceId::OpenCodeAgents,
                SetupSurfaceId::OpenCodeConfig,
            ],
            &ws,
            &resolved_home,
        )
        .expect("plan");
        assert_planned_kind(&planned, scout, OperationKind::Remove);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o644));
        }
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "driven by scripts/smoke-pre-manifest-upgrade.sh"]
    fn real_source_commit_pre_manifest_upgrade_smoke() {
        let fixture_path = std::env::var_os("AGENT_WORKSPACE_HISTORICAL_FIXTURE_PATH")
            .map(PathBuf::from)
            .expect("AGENT_WORKSPACE_HISTORICAL_FIXTURE_PATH is required");
        assert!(
            fixture_path
                .join("metadata/deprecated-skills.json")
                .is_file(),
            "fixture must contain source-commit deprecated metadata"
        );
        assert_ne!(
            fs::read(fixture_path.join("docs/WORKFLOWS.md")).expect("historical workflows"),
            fs::read(current_bundled_workspace_src().join("docs/WORKFLOWS.md"))
                .expect("current workflows"),
            "fixture must not be the current bundled workspace"
        );

        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let fixture = OldInstallFixture::build();
        let initial_skills = discover_skill_catalog(&fixture.ws)
            .expect("historical runtime catalog")
            .len();
        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &reconciliation_surface_ids(),
            &fixture.ws,
            &fixture.home,
        )
        .expect("historical artifact plan");
        for rel in [
            "README.md",
            "docs/TROUBLESHOOTING.md",
            "docs/USING_THE_APP.md",
            "docs/WORKFLOWS.md",
            "scripts/merge-codex-config.py",
        ] {
            assert_planned_kind(
                &planned,
                ArtifactId::WorkspaceFile(
                    WorkspaceRelPath::new(rel).expect("historical update path"),
                ),
                OperationKind::Update,
            );
        }
        let plan = preview_reconciliation();
        let conflicts = plan
            .operations
            .iter()
            .filter(|operation| operation.kind == OperationKind::Conflict)
            .count();
        let applied = apply_surfaces_from_preview(&plan);
        assert!(applied.success, "historical apply: {}", applied.message);
        let final_skills = discover_skill_catalog(&fixture.ws)
            .expect("final runtime catalog")
            .len();
        let second = preview_reconciliation();
        assert!(
            !second
                .operations
                .iter()
                .any(|operation| operation.kind.needs_apply()),
            "second preview must be idempotent"
        );
        let rolled = rollback_setup_transaction(applied.transaction_id, false).expect("rollback");
        assert!(rolled.success, "rollback: {}", rolled.message);
        assert!(!managed_state_path(&fixture.ws).exists());
        let reapplied = apply_surfaces_from_preview(&preview_reconciliation());
        assert!(reapplied.success, "reapply: {}", reapplied.message);
        println!(
            "historical inventory: initial_skills={initial_skills} conflicts={conflicts} final_skills={final_skills} idempotent=true rollback=true reapply=true"
        );
        fixture.cleanup();
    }
    #[test]
    fn full_uninstall_removes_app_owned_files_and_preserves_user_content() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let base = temp_base("uninstall");
        let home = base.join("home");
        let workspace = base.join("runtime");
        fs::create_dir_all(&home).expect("home");
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", workspace.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }

        // Install everything through the production flow first.
        let plan = preview_setup(vec![]).expect("preview all");
        let result = apply_surfaces_from_preview(&plan);
        assert!(result.success, "install: {}", result.message);
        assert!(home.join(".claude/skills/diagnose/SKILL.md").is_file());
        assert!(home.join(".claude/CLAUDE.md").is_file());

        // User-owned content that must survive: a custom skill and a
        // user-modified installed skill.
        let custom_skill = home.join(".claude/skills/my-own-skill/SKILL.md");
        fs::create_dir_all(custom_skill.parent().unwrap()).expect("custom dir");
        fs::write(&custom_skill, "---\nname: my-own-skill\n---\nmine\n").expect("custom");
        let modified = home.join(".claude/skills/tdd/SKILL.md");
        fs::write(&modified, "user modified this skill\n").expect("modify");

        let uninstall_plan = preview_uninstall().expect("uninstall preview");
        assert!(
            !uninstall_plan.removable.is_empty(),
            "expected removable artifacts"
        );
        assert!(
            uninstall_plan
                .preserved
                .iter()
                .any(|item| display_path_ends_with(&item.path, &["tdd", "SKILL.md"])),
            "modified skill must be preserved: {:?}",
            uninstall_plan
                .preserved
                .iter()
                .map(|i| i.path.clone())
                .collect::<Vec<_>>()
        );

        let result = apply_uninstall(
            uninstall_plan.plan_fingerprint.clone(),
            uninstall_plan.preview_token.clone(),
        )
        .expect("apply uninstall");
        assert!(result.success, "uninstall: {}", result.message);

        // App-owned files are gone across harnesses.
        assert!(!home.join(".claude/skills/diagnose/SKILL.md").is_file());
        assert!(!home.join(".claude/CLAUDE.md").is_file());
        assert!(!home.join(".codex/AGENTS.md").is_file());
        assert!(!home.join(".agents/skills/diagnose/SKILL.md").is_file());

        // User content survives.
        assert!(custom_skill.is_file(), "custom skill must survive");
        assert!(modified.is_file(), "modified skill must survive");

        // Second preview finds nothing else to remove.
        let again = preview_uninstall().expect("second preview");
        assert!(
            again.removable.is_empty(),
            "uninstall should be exhaustive: {:?}",
            again
                .removable
                .iter()
                .map(|i| i.path.clone())
                .collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn full_uninstall_rollback_restores_pre_uninstall_state_exactly() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let base = temp_base("uninstall-rollback");
        let home = base.join("home");
        let workspace = base.join("runtime");
        let backup_root = base.join("backups");
        fs::create_dir_all(&home).expect("home");
        set_test_user_dirs(&home);
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("resolved home");
        let ws = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.clone());
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                backup_root.to_string_lossy().as_ref(),
            );
        }

        // Phase 2: install through production flow.
        let install_plan = preview_setup(vec![]).expect("preview all surfaces");
        let install_result = apply_surfaces_from_preview(&install_plan);
        assert!(
            install_result.success,
            "install: {}",
            install_result.message
        );
        assert!(
            !install_result.transaction_id.is_empty(),
            "install transaction id required"
        );
        assert!(ws.join("skills/diagnose/SKILL.md").is_file());
        assert!(resolved_home.join(".codex/AGENTS.md").is_file());
        assert!(resolved_home
            .join(".agents/skills/diagnose/SKILL.md")
            .is_file());
        assert!(resolved_home
            .join(".claude/skills/diagnose/SKILL.md")
            .is_file());
        // Nothing is installed for a harness that reads the folders above.
        assert!(!resolved_home.join(".config/opencode/skills").exists());
        assert!(!resolved_home.join(".cursor/skills").exists());
        assert!(!resolved_home.join(".codex/skills").exists());
        assert!(read_managed_state(&ws).is_some());

        // User-owned fixtures before pre-uninstall snapshot.
        let custom_skill = resolved_home.join(".claude/skills/my-own-skill/SKILL.md");
        let custom_bytes = b"---\nname: my-own-skill\n---\nmine\n".to_vec();
        fs::create_dir_all(custom_skill.parent().unwrap()).expect("custom dir");
        fs::write(&custom_skill, &custom_bytes).expect("custom skill");
        let modified_skill = resolved_home.join(".claude/skills/tdd/SKILL.md");
        let modified_bytes = b"user modified this skill\n".to_vec();
        fs::write(&modified_skill, &modified_bytes).expect("modified skill");

        let uninstall_plan =
            setup_transaction::plan_artifacts_for_uninstall(&ws, &resolved_home).expect("plan");
        assert!(
            uninstall_plan
                .preserved
                .iter()
                .any(|artifact| artifact_identity(artifact).contains("tdd")),
            "modified fixture must be classified as preserved"
        );
        assert!(
            !uninstall_plan.removals.iter().any(|planned| planned
                .artifact
                .resolve_dest(&resolved_home, &ws)
                .map(|dest| dest == custom_skill)
                .unwrap_or(false)),
            "unknown custom fixture must never be scheduled for removal"
        );

        let fixtures = [
            (custom_skill.clone(), custom_bytes.clone()),
            (modified_skill.clone(), modified_bytes.clone()),
        ];
        let pre_uninstall =
            build_pre_uninstall_snapshot(&ws, &resolved_home, &uninstall_plan, &fixtures)
                .expect("pre-uninstall snapshot");
        let pre_uninstall_scoped =
            scoped_runtime_snapshot(&resolved_home, &ws).expect("pre-uninstall scoped snapshot");
        let pre_removable_identities = removal_identities(&uninstall_plan);
        assert!(!pre_removable_identities.is_empty());
        let mut removal_destinations: Vec<PathBuf> = uninstall_plan
            .removals
            .iter()
            .map(|planned| {
                planned
                    .artifact
                    .resolve_dest(&resolved_home, &ws)
                    .expect("removal dest before uninstall")
            })
            .collect();
        removal_destinations.sort();

        // Phase 4: uninstall through production flow.
        let uninstall_preview = preview_uninstall().expect("uninstall preview");
        assert!(!uninstall_preview.removable.is_empty());
        assert!(
            uninstall_preview
                .preserved
                .iter()
                .any(|item| display_path_ends_with(&item.path, &["tdd", "SKILL.md"])),
            "modified skill must appear in preserved preview"
        );
        assert!(
            !uninstall_preview.merged.is_empty(),
            "merge-managed configs should be reported when present"
        );
        assert!(uninstall_preview.plan_fingerprint.is_some());
        assert!(uninstall_preview.preview_token.is_some());

        let uninstall_result = apply_uninstall(
            uninstall_preview.plan_fingerprint.clone(),
            uninstall_preview.preview_token.clone(),
        )
        .expect("apply uninstall");
        assert!(
            uninstall_result.success,
            "uninstall: {}",
            uninstall_result.message
        );
        assert!(!uninstall_result.transaction_id.is_empty());
        assert!(uninstall_result.failed.is_empty());
        let uninstall_transaction_id = uninstall_result.transaction_id.clone();

        for dest in &removal_destinations {
            match fs::symlink_metadata(dest) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(metadata) => {
                    let kind = if metadata.is_symlink() {
                        "symlink"
                    } else if metadata.file_type().is_file() {
                        "file"
                    } else if metadata.file_type().is_dir() {
                        "directory"
                    } else {
                        "other"
                    };
                    panic!(
                        "removal destination should be absent after uninstall: {} ({kind})",
                        dest.display()
                    );
                }
                Err(error) => panic!(
                    "failed to check removal destination {}: {error}",
                    dest.display()
                ),
            }
        }
        assert_eq!(
            fs::read(&modified_skill).expect("modified skill"),
            modified_bytes
        );
        assert_eq!(fs::read(&custom_skill).expect("custom skill"), custom_bytes);
        for artifact in &uninstall_plan.merged {
            let dest = artifact
                .resolve_dest(&resolved_home, &ws)
                .expect("merged dest");
            if let Some(expected) = pre_uninstall.get(&dest) {
                assert_eq!(
                    fs::read(&dest).expect("merged config").as_slice(),
                    expected.as_slice()
                );
            }
        }
        assert!(
            !resolved_home
                .join(".claude/skills/diagnose/SKILL.md")
                .is_file(),
            "representative app-owned harness file should be removed"
        );
        let managed_state_after_uninstall = fs::read(managed_state_path(&ws))
            .expect("managed state file should still exist after uninstall");
        assert_ne!(
            managed_state_after_uninstall.as_slice(),
            pre_uninstall
                .get(&managed_state_path(&ws))
                .expect("pre-uninstall managed state")
                .as_slice(),
            "managed state must reflect uninstall rather than silently staying pre-uninstall"
        );

        // Phase 5: rollback dry-run is read-only across the isolated base.
        let pre_dry_run = relativize_snapshot(
            &base,
            collect_regular_files_under(&base).expect("base snapshot before dry-run"),
        );
        let dry_run = rollback_setup_transaction(uninstall_transaction_id.clone(), true)
            .expect("rollback dry-run");
        assert!(dry_run.success, "dry-run: {}", dry_run.message);
        assert!(dry_run.failed.is_empty());
        assert!(
            !dry_run.applied.is_empty(),
            "dry-run should list artifacts requiring restoration"
        );
        assert!(
            dry_run.rolled_back.is_empty(),
            "first dry-run must not report restored artifacts"
        );
        assert_eq!(
            dry_run.applied.len(),
            uninstall_plan.removals.len(),
            "dry-run restore count should match uninstall removal inventory"
        );
        let post_dry_run = relativize_snapshot(
            &base,
            collect_regular_files_under(&base).expect("base snapshot after dry-run"),
        );
        assert_eq!(
            post_dry_run, pre_dry_run,
            "dry-run must not mutate any regular file under the isolated base"
        );

        // Phase 6: explicit rollback restores exact pre-uninstall runtime bytes.
        let rollback = rollback_setup_transaction(uninstall_transaction_id.clone(), false)
            .expect("explicit rollback");
        assert!(rollback.success, "rollback: {}", rollback.message);
        assert!(rollback.failed.is_empty());
        assert!(
            !rollback.rolled_back.is_empty(),
            "rollback must report restored inventory"
        );
        assert_eq!(rollback.transaction_id, uninstall_transaction_id);

        for (path, expected) in &pre_uninstall {
            assert!(
                path.is_file(),
                "restored destination must exist after rollback"
            );
            assert_eq!(
                fs::read(path).expect("restored bytes").as_slice(),
                expected.as_slice()
            );
        }
        assert_eq!(
            fs::read(&modified_skill).expect("modified after rollback"),
            modified_bytes
        );
        assert_eq!(
            fs::read(&custom_skill).expect("custom after rollback"),
            custom_bytes
        );

        let post_rollback_scoped =
            scoped_runtime_snapshot(&resolved_home, &ws).expect("post-rollback scoped snapshot");
        assert_eq!(
            post_rollback_scoped, pre_uninstall_scoped,
            "rollback must restore scoped runtime bytes exactly"
        );

        // Phase 7: restored ownership and idempotency.
        let setup_after = preview_setup(vec![]).expect("preview after rollback");
        let pending: Vec<_> = setup_after
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .collect();
        assert!(
            pending.iter().all(|op| {
                op.kind == OperationKind::Conflict
                    && (op.summary.contains("tdd") || op.summary.contains("Tdd"))
            }),
            "only the deliberate user-modified fixture may remain pending: {:?}",
            pending
        );

        let uninstall_after = preview_uninstall().expect("uninstall preview after rollback");
        let after_plan =
            setup_transaction::plan_artifacts_for_uninstall(&ws, &resolved_home).expect("plan");
        assert_eq!(removal_identities(&after_plan), pre_removable_identities);
        assert!(
            after_plan
                .preserved
                .iter()
                .any(|artifact| artifact_identity(artifact).contains("tdd")),
            "user-modified fixture should remain preserved after rollback"
        );
        assert!(
            uninstall_after
                .removable
                .iter()
                .map(|item| item.path.clone())
                .collect::<BTreeSet<_>>()
                == uninstall_preview
                    .removable
                    .iter()
                    .map(|item| item.path.clone())
                    .collect::<BTreeSet<_>>(),
            "restored app-owned inventory should be removable again by canonical destination"
        );

        let manifest = read_transaction_manifest(&backup_root, &uninstall_transaction_id, &ws);
        assert_eq!(manifest.transaction_status, TransactionStatus::RolledBack);
        assert!(manifest
            .operations
            .iter()
            .all(|op| op.rollback_status == setup_transaction::RollbackStatus::Restored));

        let scoped_before_second =
            scoped_runtime_snapshot(&resolved_home, &ws).expect("before second");
        let second_rollback =
            rollback_setup_transaction(uninstall_transaction_id.clone(), false).expect("second");
        assert!(
            !second_rollback.success,
            "second rollback must refuse an already rolled-back transaction"
        );
        assert!(
            second_rollback.message.contains("already rolled back")
                || second_rollback
                    .failed
                    .iter()
                    .any(|item| item.contains("already rolled back")),
            "second rollback should report already rolled back"
        );
        let scoped_after_second =
            scoped_runtime_snapshot(&resolved_home, &ws).expect("after second");
        assert_eq!(
            scoped_after_second, scoped_before_second,
            "second rollback attempt must not mutate scoped runtime state"
        );

        let _ = fs::remove_dir_all(&base);
    }

    /// File of the app repository at a commit (rules history fixtures).
    fn rules_at_commit(commit: &str, rel: &str) -> String {
        let output = Command::new("git")
            .args([
                "show",
                &format!("{commit}:resources/default-workspace/{rel}"),
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
            .output()
            .expect("run git show");
        assert!(
            output.status.success(),
            "{commit}:{rel}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("utf-8 rules")
    }

    /// The state the owner's `~/.claude/CLAUDE.md` is in: the managed record
    /// holds an old shipped template, and the file is a newer shipped base with
    /// one line of "Codex delegation" edited by hand.
    #[test]
    fn owner_refined_claude_rules_are_a_legacy_conflict_and_stay_untouched() {
        let _guard = guard::lock();
        let _restore = EnvRestore::capture();
        let base = temp_base("owner-rules");
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let ws = base.join("workspace");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&ws).expect("workspace");
        set_test_user_dirs(&home);
        let ws = ws.canonicalize().expect("workspace");
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", ws.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                base.join("backups").to_string_lossy().as_ref(),
            );
        }
        let resolved_home = crate::platform_paths::resolve_user_home(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .expect("home");

        let rel = "templates/sync/claude-rules.md";
        let recorded_template = rules_at_commit("0f2eac13", rel);
        let installed_base = rules_at_commit("0e042154", rel);
        let refined = installed_base.replace("`gpt-5.6-sol` at `high`", "`gpt-6.1-sol` at `xhigh`");
        assert_ne!(refined, installed_base, "fixture must hold the edited line");
        let installed_path = resolved_home.join(".claude/CLAUDE.md");
        fs::create_dir_all(installed_path.parent().unwrap()).expect("claude dir");
        fs::write(&installed_path, &refined).expect("refined rules");
        crate::managed_state::write_managed_state_atomic(
            &ws,
            &crate::managed_state::ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: vec![crate::managed_state::ManagedArtifactRecord {
                    identity: artifact_identity(&ArtifactId::ClaudeRules),
                    hash: crate::stable_digest::bytes(recorded_template.as_bytes()),
                    surface: None,
                }],
            },
        )
        .expect("managed state");

        let planned = crate::setup_transaction::plan_artifacts_for_surfaces(
            &[SetupSurfaceId::ClaudeRules],
            &ws,
            &resolved_home,
        )
        .expect("plan");
        assert_planned_kind(&planned, ArtifactId::ClaudeRules, OperationKind::Conflict);
        assert_eq!(
            planned[0].rules.expect("rules assessment").plan,
            crate::rules_block::RulesPlan::Conflict(
                crate::rules_block::RulesConflict::LegacyDiverged
            )
        );
        let status = crate::installation_status::status_for_surfaces(
            &[SetupSurfaceId::ClaudeRules],
            &ws,
            &resolved_home,
        )
        .expect("status");
        assert_eq!(
            status.state,
            crate::installation_status::InstallationState::Conflict
        );
        assert_eq!(
            status.surfaces[0]
                .rules
                .as_ref()
                .and_then(|rules| rules.conflict_reason),
            Some(crate::rules_block::RulesConflict::LegacyDiverged)
        );

        let plan = preview_setup(vec!["claude_rules".into()]).expect("preview");
        assert!(!plan.has_pending_changes);
        assert!(apply_setup(vec!["claude_rules".into()], false, None, None).is_err());
        assert_eq!(fs::read_to_string(&installed_path).unwrap(), refined);
        let _ = fs::remove_dir_all(&base);
    }
}
