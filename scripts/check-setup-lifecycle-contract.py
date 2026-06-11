#!/usr/bin/env python3
"""Guard setup lifecycle contracts in Rust and frontend sources."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILLS_ROOT = REPO / "resources/default-workspace/skills"
TAURI_SRC = REPO / "src-tauri/src"
SETUP_RS = TAURI_SRC / "commands/setup.rs"
ARTIFACT_REGISTRY = TAURI_SRC / "artifact_registry.rs"
SETUP_TRANSACTION = TAURI_SRC / "setup_transaction.rs"
PATH_SAFETY = TAURI_SRC / "path_safety.rs"
SETUP_FINGERPRINT = TAURI_SRC / "setup_fingerprint.rs"
CLAUDE_RUNTIME = TAURI_SRC / "commands/claude_runtime.rs"
SETUP_LIFECYCLE_TSX = REPO / "src/components/SetupLifecycle.tsx"
START_VIEW = REPO / "src/views/StartView.tsx"

ACTIVE_DOCS = [
    REPO / "README.md",
    REPO / "docs/WORKSPACE_CONTRACT.md",
    REPO / "docs/SECURITY_MODEL.md",
    REPO / "docs/RELEASE.md",
    REPO / "resources/default-workspace/README.md",
    REPO / "resources/default-workspace/docs/START_HERE.md",
    REPO / "resources/default-workspace/docs/CONCEPTS.md",
    REPO / "resources/default-workspace/docs/USING_THE_APP.md",
    REPO / "resources/default-workspace/docs/WORKFLOWS.md",
    REPO / "resources/default-workspace/docs/SKILLS.md",
    REPO / "resources/default-workspace/docs/AGENT_RULES.md",
    REPO / "resources/default-workspace/docs/OPENCODE_CONFIG.md",
    REPO / "resources/default-workspace/docs/CODEX_CONFIG.md",
    REPO / "resources/default-workspace/docs/TROUBLESHOOTING.md",
    REPO / "resources/default-workspace/templates/cursor/README.md",
]

FORBIDDEN_DOC_PATTERNS = [
    (r"target profile", "target profile claims"),
    (r"profile chip", "profile chip claims"),
    (r"select individual skills", "individual persistent skill selection claims"),
    (r"select the skill", "manual per-skill selection claim"),
    (r"select skills", "manual skill selection claim"),
    (r"flat-only", "flat-only source layout claim"),
    (r"flat skill creation", "flat skill creation instruction claim"),
    (r"Codex config is manual-only", "Codex manual-only claim"),
    (r"app does not write Codex", "app does not write Codex claim"),
    (r"Manual review only", "Codex manual review only claim"),
    (r"update Codex manually", "manual Codex update claim"),
    (r"The app does not overwrite Codex config", "app does not write Codex claim"),
    (r"diff/manual-review only", "Codex diff manual-only claim"),
    (r"repair without preview", "repair without preview claim"),
]

TARGETS_RE = re.compile(r"^targets:\s*(.+)$", re.MULTILINE)
NAME_RE = re.compile(r"^name:\s*(.+)$", re.MULTILINE)


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_active_docs_exist() -> None:
    for doc in ACTIVE_DOCS:
        if not doc.is_file():
            fail(f"missing active doc: {doc.relative_to(REPO)}")


def assert_no_stale_doc_claims() -> None:
    for doc in ACTIVE_DOCS:
        text = read(doc)
        for pattern, label in FORBIDDEN_DOC_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                fail(f"{doc.relative_to(REPO)} contains forbidden {label}")


def assert_bundled_skill_count() -> None:
    skills: list[Path] = []
    for skill_md in SKILLS_ROOT.rglob("SKILL.md"):
        if skill_md.is_file():
            skills.append(skill_md)
    if len(skills) != 21:
        fail(f"expected exactly 21 bundled skills, found {len(skills)}")


def assert_targets_metadata() -> None:
    for skill_md in SKILLS_ROOT.rglob("SKILL.md"):
        text = read(skill_md)
        match = TARGETS_RE.search(text)
        if not match:
            fail(f"{skill_md.relative_to(REPO)} missing targets metadata")
        raw = match.group(1).strip()
        if raw.startswith("[") and raw.endswith("]"):
            raw = raw.strip("[]")
        targets = [t.strip() for t in raw.split(",") if t.strip()]
        if not targets:
            fail(f"{skill_md.relative_to(REPO)} has empty targets")
        for target in targets:
            if target not in {"codex", "opencode", "claude", "cursor"}:
                fail(f"{skill_md.relative_to(REPO)} has unknown target {target!r}")


def assert_agent_counts() -> None:
    claude = list((REPO / "resources/default-workspace/templates/claude/agents").glob("*.md"))
    cursor = list((REPO / "resources/default-workspace/templates/cursor/agents").glob("*.md"))
    codex_toml = list((REPO / "resources/default-workspace/templates/codex/agents").glob("*.toml"))
    codex_md = list((REPO / "resources/default-workspace/templates/codex/agents").glob("*.md"))
    if len(claude) != 5:
        fail(f"expected 5 Claude agents, found {len(claude)}")
    if len(cursor) != 6:
        fail(f"expected 6 Cursor agents, found {len(cursor)}")
    if len(codex_toml) != 4:
        fail(f"expected 4 Codex TOML agents, found {len(codex_toml)}")
    if codex_md:
        fail("Codex agents must use .toml, not .md")


def assert_rust_contracts() -> None:
    artifact_text = read(ARTIFACT_REGISTRY)
    if "#![allow(dead_code)]" in artifact_text:
        fail("artifact_registry.rs must not use module-wide allow(dead_code)")
    setup_text = read(SETUP_RS)
    for forbidden in (
        "fn resolve_surface_path",
        "fn backup_target",
        "fn restore_from_backup",
        "fn compare_agent_dir",
        "fn compare_single_file",
        "struct RepairPreflight",
        "fn preflight_repair",
        "CONSUMED_FINGERPRINTS",
        "mark_fingerprint_consumed",
        "is_fingerprint_consumed",
    ):
        if forbidden in setup_text:
            fail(f"setup.rs still defines or references forbidden pattern {forbidden}")
    if "setup_transaction::detect_surface_state" not in setup_text:
        fail("setup.rs must delegate surface detection to setup_transaction")
    if "let _ = persist_setup_manifest" in setup_text:
        fail("setup.rs must not ignore manifest persistence results")
    if "remove_dir_all" in setup_text and ".cursor/agents" in setup_text:
        fail("setup.rs must not remove_dir_all on shared Cursor agents root")
    txn_text = read(SETUP_TRANSACTION)
    if "artifact:" not in txn_text and "ArtifactManifestOperation" not in txn_text:
        fail("setup_transaction.rs must define artifact manifest operations")
    if "aggregate_operation_kind" not in txn_text:
        fail("setup_transaction.rs must aggregate artifact state for surfaces")
    if "issue_preview_token" not in txn_text or "consume_preview_token" not in txn_text:
        fail("setup preview must use bounded preview tokens")
    if "CONSUMED_FINGERPRINTS" in txn_text:
        fail("setup_transaction.rs must not use unbounded consumed fingerprint state")
    if "validate_backup_copy" not in txn_text:
        fail("setup_transaction.rs must validate backups before mutation")
    if "reject_symlink_parent_chain" not in txn_text:
        fail("setup_transaction.rs must reject symlink parent chains")
    if "post_apply_digest" not in txn_text:
        fail("manifest must record post-apply digests for rollback safety")
    if "validate_operation_consistency" not in txn_text:
        fail("manifest must validate operation and rollback action consistency")
    if "let _ = persist_manifest_atomic" in txn_text:
        fail("setup_transaction.rs must not ignore manifest persistence results")
    if "plan_fingerprint" not in setup_text and "fingerprint" not in setup_text:
        fail("setup apply must require preview fingerprint")
    fp_text = read(SETUP_FINGERPRINT)
    if "artifact_source_digest" not in fp_text or "artifact_installed_managed_digest" not in fp_text:
        fail("setup fingerprint must use independent source and installed digests")
    if "OpenCodePlaywrightMcp" not in artifact_text:
        fail("OpenCode config write set must include Playwright MCP artifact")
    if "serde_json::to_string(artifact)" in txn_text:
        fail("backup filenames must not derive from JSON serialization")
    if "preview_repair_setup" not in setup_text:
        fail("repair must expose read-only preview command")
    if "CreateOnlyArtifacts" not in setup_text:
        fail("repair must use create-only per-artifact execution")
    if "repair_preview_token" not in setup_text:
        fail("repair must issue and require preview tokens")
    if "consume_preview_token(token)" not in setup_text:
        fail("setup apply/repair must consume preview tokens inside apply_planned_artifacts")
    if setup_text.find("consume_preview_token") < setup_text.find("apply_planned_artifacts"):
        fail("preview token consumption must occur inside apply_planned_artifacts after preflight")
    if "validate_artifact_source_dest" not in txn_text:
        fail("setup_transaction must validate artifact source and destination paths")
    if "run_persisted_rollback" not in setup_text:
        fail("rollback must use shared persisted rollback core")
    if "operation_eligible_for_rollback_mutation" not in txn_text:
        fail("rollback eligibility must exclude restored artifacts")
    if "reconcile_in_flight_rollback_artifact" not in txn_text:
        fail("rollback reconciliation owner required in setup_transaction")
    if "RollbackStatus::InFlight" not in setup_text:
        fail("rollback must persist in_flight before artifact mutation")
    if "compute_finalize_rollback_status" not in txn_text:
        fail("rolling_back must finalize when no eligible artifacts remain")
    if "finalize_persisted_rollback" not in setup_text:
        fail("explicit rollback must finalize completed rollbacks")
    codex_merge = read(REPO / "resources/default-workspace/scripts/merge-codex-config.py")
    if "patch_managed_scalar_line" not in codex_merge:
        fail("Codex patcher must preserve managed scalar inline comments")
    if "find_inline_comment_start" not in codex_merge:
        fail("Codex patcher must use bounded inline comment splitter")
    codex_tests = read(REPO / "resources/default-workspace/scripts/test_merge_codex_config.py")
    if 'profile = "custom"  # keep this comment' not in codex_tests:
        fail("Codex tests must cover same-line inline comment preservation")
    if "in_flight" not in read(REPO / "docs/WORKSPACE_CONTRACT.md").lower():
        fail("WORKSPACE_CONTRACT.md must document per-artifact in_flight rollback")
    if "RollingBack" not in setup_text or "rollback_failed" not in read(
        REPO / "resources/default-workspace/docs/USING_THE_APP.md"
    ).lower():
        fail("docs must document rolling_back and rollback_failed resume")
    if "merged.to_string()" in txn_text and "CodexConfig" in txn_text:
        fail("Codex managed rollback must not use toml::Value to_string serialization")
    if "rollback_codex_config_managed_projection" not in read(
        REPO / "src-tauri/src/commands/codex_runtime.rs"
    ):
        fail("Codex managed rollback must use line-preserving Python merge owner")
    if "acceptMutationTransaction" not in read(SETUP_LIFECYCLE_TSX):
        fail("SetupLifecycle must retain failed apply and repair transactions")
    if "post_apply_full_digest" not in txn_text:
        fail("manifest must record post-apply full digests for rollback safety")
    if "merge_managed_opencode_config" not in read(REPO / "src-tauri/src/commands/opencode_runtime.rs"):
        fail("OpenCode managed merge owner required for rollback")
    if "validate_directory_backup_tree" not in txn_text or "entry count mismatch" not in txn_text:
        fail("directory backup validation must be bidirectional")
    path_text = read(PATH_SAFETY)
    if "if !path.exists()" in path_text and "reject_symlink" in path_text:
        fail("path_safety reject_symlink must not gate symlink_metadata on path.exists()")
    if "rollbackEligible" not in read(SETUP_LIFECYCLE_TSX):
        fail("SetupLifecycle must use dry-run rollback eligibility")
    using_app = read(REPO / "resources/default-workspace/docs/USING_THE_APP.md")
    if "not on Workspace" in using_app and "setup lifecycle" in using_app:
        fail("USING_THE_APP.md must not contradict harness vs Workspace setup paths")
    if re.search(r"Install from harness pages,\s*not from Workspace", using_app):
        fail("USING_THE_APP.md must not claim skills install only from harness pages")
    smoke_doc = read(REPO / "docs/APP_RELEASE_SMOKE.md")
    if "smoke-tauri-runtime" in smoke_doc and "webview" not in smoke_doc.lower():
        fail("APP_RELEASE_SMOKE.md must distinguish backend runtime smoke from webview smoke")
    claude_text = read(CLAUDE_RUNTIME)
    if re.search(r"agent:\s*claude", claude_text):
        fail("Claude health must not parse obsolete agent: claude metadata")
    if "compare_agent_dir" in claude_text:
        fail("Claude health must not use compare_agent_dir")


def assert_frontend_contracts() -> None:
    setup_tsx = read(SETUP_LIFECYCLE_TSX)
    if "runSetupTask" not in setup_tsx and "runWsTask" not in setup_tsx:
        fail("SetupLifecycle must use global workspace mutation lock")
    if "previewToken" not in setup_tsx:
        fail("SetupLifecycle apply must forward preview tokens")
    if "lastCompletedApplyRef" not in setup_tsx:
        fail("SetupLifecycle must preserve apply transaction across rollback failure")
    if "rollbackResult" not in setup_tsx:
        fail("SetupLifecycle must separate rollback result state from apply result")
    start_view = read(START_VIEW)
    if re.search(r"onLog=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}", start_view):
        fail("StartView must not pass empty setup onLog callback")
    if re.search(r"onError=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}", start_view):
        fail("StartView must not pass empty setup onError callback")


def main() -> None:
    assert_active_docs_exist()
    assert_no_stale_doc_claims()
    assert_bundled_skill_count()
    assert_targets_metadata()
    assert_agent_counts()
    assert_rust_contracts()
    assert_frontend_contracts()
    print("setup lifecycle contract checks ok")


if __name__ == "__main__":
    main()
