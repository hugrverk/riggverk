//! The copy of the bundle that earlier releases kept under the workspace folder, frozen as a list.
//!
//! The `WorkspaceBundle` surface still installs these files in this release. The list is flat and
//! sorted, and it is frozen: a bundle file added later is read from the bundle and does not join
//! the copy, and the tests pin the list by digest, so a change is always a deliberate edit of both.
//! Frozen from the `default_workspace_files()` output at `e8624ea`, plus the twelve files that
//! only the early tagged builds shipped (see `RETIRED_FROM_BUNDLE`).

/// Marker of a workspace folder as earlier releases wrote it. It stays canonical: it is the one
/// workspace file that is not a retired copy.
pub(crate) const LEGACY_MARKER_REL: &str = ".agent-workspace/workspace.json";

/// Every other file of the copy, relative to the workspace folder, sorted bytewise. Frozen: the
/// tripwire tests pin the sorted order, the count and a digest of the whole list.
pub(crate) const RETIRED_WORKSPACE_FILES: &[&str] = &[
    "README.md",
    "agent-specs/architect.body.md",
    "agent-specs/inspector.body.md",
    "agent-specs/repo-scout.body.md",
    "agent-specs/scribe.body.md",
    "agent-specs/sentinel.body.md",
    "agent-specs/verifier.body.md",
    "agents/architect.md",
    "agents/autopilot.md",
    "agents/code-reviewer.md",
    "agents/docs-writer.md",
    "agents/inspector.md",
    "agents/qa-verifier.md",
    "agents/repo-scout.md",
    "agents/scribe.md",
    "agents/security-auditor.md",
    "agents/sentinel.md",
    "agents/verifier.md",
    "docs/AGENT_RULES.md",
    "docs/CODEX_CONFIG.md",
    "docs/CONCEPTS.md",
    "docs/GIT_VERSIONING.md",
    "docs/OPENCODE_CONFIG.md",
    "docs/SKILLS.md",
    "docs/START_HERE.md",
    "docs/TROUBLESHOOTING.md",
    "docs/USING_THE_APP.md",
    "docs/WORKFLOWS.md",
    "metadata/agent-adapters.json",
    "metadata/agents.json",
    "metadata/codex-agents.json",
    "metadata/codex-managed-keys.json",
    "metadata/opencode-managed-keys.json",
    "metadata/rules-adapters.json",
    "routing/profiles.json",
    "scripts/bootstrap.sh",
    "scripts/ensure-codex-routing-defaults.py",
    "scripts/generate-opencode-config.py",
    "scripts/install-agent-rules.sh",
    "scripts/install-opencode-config.sh",
    "scripts/install-skills.sh",
    "scripts/merge-codex-config.py",
    "skills/accessibility-review/SKILL.md",
    "skills/adversarial-implementation/SKILL.md",
    "skills/browser-qa/SKILL.md",
    "skills/context-budget/SKILL.md",
    "skills/current-docs/SKILL.md",
    "skills/database-migrations/SKILL.md",
    "skills/diagnose/SKILL.md",
    "skills/frontend-design/SKILL.md",
    "skills/handoff/SKILL.md",
    "skills/implementation-plan/SKILL.md",
    "skills/kretsverket/kretsverket-editor-change/SKILL.md",
    "skills/kretsverket/kretsverket-electrical-drawing/SKILL.md",
    "skills/kretsverket/kretsverket-file-compatibility/SKILL.md",
    "skills/kretsverket/kretsverket-status-report/SKILL.md",
    "skills/kretsverket/kretsverket-status-report/assets/report-template.html",
    "skills/kretsverket/kretsverket-status-report/scripts/verify-report.mjs",
    "skills/kretsverket/kretsverket-symbol-system/SKILL.md",
    "skills/minimal-implementation/SKILL.md",
    "skills/prototype/SKILL.md",
    "skills/release-check/SKILL.md",
    "skills/retro/SKILL.md",
    "skills/screenshot-review/SKILL.md",
    "skills/security-audit/AI-AND-LLM.md",
    "skills/security-audit/ATTACK-CLASSES.md",
    "skills/security-audit/CLIENT-SIDE.md",
    "skills/security-audit/CLOUD-AND-DEPLOYMENT.md",
    "skills/security-audit/DATA-ISOLATION-AND-LIFECYCLE.md",
    "skills/security-audit/DESKTOP-MOBILE-AND-LOCAL-IPC.md",
    "skills/security-audit/HUNTING.md",
    "skills/security-audit/LICENSE",
    "skills/security-audit/MEMORY-SAFETY-AND-BINARY.md",
    "skills/security-audit/PROTOCOLS-RPC-AND-MESSAGING.md",
    "skills/security-audit/RECONNAISSANCE.md",
    "skills/security-audit/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md",
    "skills/security-audit/SKILL.md",
    "skills/security-audit/SUPPLY-CHAIN-AND-RELEASE.md",
    "skills/security-audit/UPSTREAM.md",
    "skills/security-audit/VALIDATION-AND-REPORTING.md",
    "skills/security-audit/WEB-PROTOCOL-AND-AUTH.md",
    "skills/security-audit/report-schema.json",
    "skills/security-audit/validate-coverage-ledger.cjs",
    "skills/security-audit/validate-findings.cjs",
    "skills/security-review/SKILL.md",
    "skills/tdd/SKILL.md",
    "skills/wordpress-woocommerce/SKILL.md",
    "skills/zoom-out/SKILL.md",
    "templates/claude/agents/inspector.md",
    "templates/claude/agents/repo-scout.md",
    "templates/claude/agents/scribe.md",
    "templates/claude/agents/sentinel.md",
    "templates/claude/agents/verifier.md",
    "templates/codex/README.md",
    "templates/codex/agents/inspector.toml",
    "templates/codex/agents/repo_scout.toml",
    "templates/codex/agents/security_reviewer.toml",
    "templates/codex/agents/verifier.toml",
    "templates/codex/config.toml",
    "templates/codex/mcp/README.md",
    "templates/codex/mcp/playwright.toml",
    "templates/cursor/README.md",
    "templates/cursor/agents/browser-qa.md",
    "templates/cursor/agents/inspector.md",
    "templates/cursor/agents/release-checker.md",
    "templates/cursor/agents/repo-scout.md",
    "templates/cursor/agents/security-reviewer.md",
    "templates/cursor/agents/verifier.md",
    "templates/cursor/global-profile.json",
    "templates/cursor/manifest.json",
    "templates/cursor/mcp/README.md",
    "templates/cursor/mcp/mcp.example.json",
    "templates/cursor/mcp/playwright.mcp.json",
    "templates/cursor/rules/core-safety.mdc",
    "templates/cursor/rules/frontend-design.mdc",
    "templates/cursor/rules/nextjs-supabase.mdc",
    "templates/cursor/rules/prompt-contract.mdc",
    "templates/cursor/rules/release-check.mdc",
    "templates/cursor/rules/repo-workflow.mdc",
    "templates/cursor/rules/wordpress-woocommerce.mdc",
    "templates/cursor/user-rules.md",
    "templates/global-agent-rules.md",
    "templates/mcp/copilot.playwright.json",
    "templates/mcp/kilo.playwright.json",
    "templates/mcp/pi.playwright.json",
    "templates/opencode.base.json",
    "templates/opencode.json",
    "templates/opencode.policy.json",
    "templates/playwright-mcp.config.json",
    "templates/prompts/masterprompt.md",
    "templates/prompts/standard-prompt.md",
    "templates/rules/claude.md",
    "templates/rules/codex.md",
    "templates/rules/copilot.md",
    "templates/rules/cursor.md",
    "templates/rules/kilo.md",
    "templates/rules/opencode.md",
    "templates/rules/pi.md",
    "templates/sync/claude-rules.md",
    "templates/sync/codex-rules.md",
    "templates/sync/copilot-rules.md",
    "templates/sync/kilo-rules.md",
    "templates/sync/opencode-rules.md",
    "templates/sync/pi-rules.md",
    "templates/tui.json",
];

/// Listed paths the bundle no longer holds, each a copy that an earlier release shipped and the
/// bundle dropped since. Add a path here, with a comment naming the release that dropped it,
/// before the bundle loses it.
#[cfg(test)]
pub(crate) const RETIRED_FROM_BUNDLE: &[&str] = &[
    // Only the early tagged builds (`app-v0.1.0`, `v0.1.0-alpha`, `v0.1.0-rc.1`) shipped these;
    // the bundle dropped them before the managed state existed.
    "agents/autopilot.md",
    "agents/code-reviewer.md",
    "agents/docs-writer.md",
    "agents/qa-verifier.md",
    "agents/security-auditor.md",
    "routing/profiles.json",
    "scripts/bootstrap.sh",
    "scripts/install-agent-rules.sh",
    "scripts/install-opencode-config.sh",
    "scripts/install-skills.sh",
    "templates/prompts/masterprompt.md",
    "templates/prompts/standard-prompt.md",
    // Moved to a private team pack after 2026.10.17: the Kretsverket and WordPress skills and the
    // Cursor stack rules.
    "skills/kretsverket/kretsverket-editor-change/SKILL.md",
    "skills/kretsverket/kretsverket-electrical-drawing/SKILL.md",
    "skills/kretsverket/kretsverket-file-compatibility/SKILL.md",
    "skills/kretsverket/kretsverket-status-report/SKILL.md",
    "skills/kretsverket/kretsverket-status-report/assets/report-template.html",
    "skills/kretsverket/kretsverket-status-report/scripts/verify-report.mjs",
    "skills/kretsverket/kretsverket-symbol-system/SKILL.md",
    "skills/wordpress-woocommerce/SKILL.md",
    "templates/cursor/rules/nextjs-supabase.mdc",
    "templates/cursor/rules/wordpress-woocommerce.mdc",
];

/// The marker followed by the frozen list: every path the `WorkspaceBundle` surface installs and
/// tracks in this release. Together they are sorted, so the order is stable.
#[cfg(test)]
pub(crate) fn workspace_copy_paths() -> impl Iterator<Item = &'static str> {
    std::iter::once(LEGACY_MARKER_REL).chain(RETIRED_WORKSPACE_FILES.iter().copied())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// `sha256:` digest of `workspace_copy_paths()` joined by newlines: the manifest at `e8624ea`
    /// plus the tag-only files of `RETIRED_FROM_BUNDLE`, computed with a script, not from this
    /// file. Editing the list without this line fails.
    const FROZEN_DIGEST: &str =
        "sha256:cbb356a4e4d72bfbe46d642feedb0d2311f0cca0b4f35dcbaf7e50946bef8e9a";
    /// The marker, the 133 files of the manifest and the 12 tag-only files.
    const FROZEN_COUNT: usize = 146;

    fn bundle_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    #[test]
    fn the_frozen_list_matches_the_list_it_was_frozen_from() {
        let paths: Vec<&str> = workspace_copy_paths().collect();
        assert_eq!(paths.len(), FROZEN_COUNT);
        assert_eq!(
            crate::stable_digest::bytes(paths.join("\n").as_bytes()),
            FROZEN_DIGEST,
            "the list of workspace copies is frozen; changing it is a release decision that also \
             updates FROZEN_DIGEST"
        );
    }

    #[test]
    fn the_list_is_sorted_unique_and_relative() {
        let paths: Vec<&str> = workspace_copy_paths().collect();
        assert!(
            paths.windows(2).all(|pair| pair[0] < pair[1]),
            "the marker and the frozen list must be sorted bytewise without duplicates"
        );
        assert!(
            !RETIRED_WORKSPACE_FILES.contains(&LEGACY_MARKER_REL),
            "the marker stays canonical and is not a retired copy"
        );
        for rel in &paths {
            assert!(!rel.is_empty() && !rel.contains(".."), "{rel}");
            assert!(
                !Path::new(rel).is_absolute() && !rel.contains('\\'),
                "{rel}"
            );
        }
    }

    /// Cleaning up the copy must never reach the state folder or what the user writes.
    #[test]
    fn the_list_never_names_state_or_user_files() {
        for rel in RETIRED_WORKSPACE_FILES {
            assert!(
                !rel.starts_with(crate::workspace_layout::LEGACY_STATE_DIR),
                "{rel}"
            );
            assert!(!rel.starts_with("docs/context/"), "{rel}");
        }
        assert_eq!(LEGACY_MARKER_REL, ".agent-workspace/workspace.json");
    }

    #[test]
    fn every_listed_path_is_in_the_bundle_or_documented_as_retired() {
        let root = bundle_root();
        for rel in RETIRED_FROM_BUNDLE {
            assert!(
                RETIRED_WORKSPACE_FILES.contains(rel),
                "documented as retired but not listed: {rel}"
            );
            assert!(
                !root.join(rel).exists(),
                "documented as retired but the bundle still holds it: {rel}"
            );
        }
        let missing: Vec<&str> = workspace_copy_paths()
            .filter(|rel| !RETIRED_FROM_BUNDLE.contains(rel))
            .filter(|rel| !root.join(rel).is_file())
            .collect();
        assert!(
            missing.is_empty(),
            "listed files absent from the bundle and not documented as retired: {missing:?}"
        );
    }
}
