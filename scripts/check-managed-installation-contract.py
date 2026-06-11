#!/usr/bin/env python3
"""Guard the unified managed installation workflow and its safety contracts."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri/src"
FRONTEND = ROOT / "src"


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def read(path: Path) -> str:
    if not path.is_file():
        fail(f"missing required file: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def require(path: Path, *needles: str) -> str:
    text = read(path)
    for needle in needles:
        if needle not in text:
            fail(f"{path.relative_to(ROOT)} missing contract marker: {needle}")
    return text


def production_rust(path: Path) -> str:
    return read(path).split("#[cfg(test)]", 1)[0]


def forbid_in_tree(root: Path, patterns: tuple[str, ...]) -> None:
    suffixes = {".rs", ".ts", ".tsx", ".py", ".sh"}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in patterns:
            if pattern in text:
                fail(f"{path.relative_to(ROOT)} retains obsolete owner: {pattern}")


def main() -> None:
    semantic = subprocess.run(
        [sys.executable, str(ROOT / "scripts/generate-pre-manifest-ownership.py"), "--check"],
        cwd=ROOT,
        check=False,
    )
    if semantic.returncode:
        fail("semantic pre-manifest ownership coverage failed")

    generated_python = list(
        (ROOT / "resources/default-workspace").rglob("__pycache__")
    ) + list((ROOT / "resources/default-workspace").rglob("*.pyc"))
    if generated_python:
        fail("bundled default workspace contains generated Python cache files")

    skills = list((ROOT / "resources/default-workspace/skills").rglob("SKILL.md"))
    if len(skills) != 21:
        fail(f"expected 21 bundled skills, found {len(skills)}")

    ownership_path = (
        ROOT
        / "resources/default-workspace/metadata/pre-manifest-ownership.json"
    )
    ownership = json.loads(read(ownership_path))
    if not ownership.get("migration_id") or not ownership.get("source_commit"):
        fail("pre-manifest ownership metadata requires migration provenance")
    entries = ownership.get("artifacts")
    if not isinstance(entries, list) or not entries:
        fail("pre-manifest ownership metadata requires artifact entries")
    seen: set[tuple[str, str, str]] = set()
    for entry in entries:
        identity = entry.get("identity")
        action = entry.get("action")
        path_classes = entry.get("path_classes")
        if not isinstance(identity, str) or not identity:
            fail("pre-manifest ownership entries require an identity")
        if action not in {"update", "remove"}:
            fail("pre-manifest ownership action must be update or remove")
        if not isinstance(path_classes, list) or not path_classes:
            fail("pre-manifest ownership entries require path classes")
        for path_class in path_classes:
            key = (identity, path_class, action)
            if key in seen:
                fail("duplicate pre-manifest ownership identity/path/action")
            seen.add(key)
        digests = entry.get("digests", [])
        if not digests or any(
            not re.fullmatch(r"sha256:[0-9a-f]{64}", digest) for digest in digests
        ):
            fail("pre-manifest ownership entries require full SHA-256 digests")

    roots = require(
        TAURI / "setup_roots.rs",
        "pub struct SetupRoots",
        "bundled_root",
        "runtime_root",
        "bundled and runtime workspace roots must be distinct",
    )
    if "unwrap_or_default" in roots:
        fail("setup roots must not silently fall back to an empty path")

    require(
        TAURI / "stable_digest.rs",
        "sha256:",
        "pub fn file",
        "reject_symlink",
    )
    state = require(
        TAURI / "managed_state.rs",
        "MANAGED_STATE_SCHEMA_VERSION: u32 = 2",
        "write_managed_state_atomic",
        "sync_all",
        "restore_managed_state_raw_atomic",
    )
    if "DefaultHasher" in state:
        fail("managed state must not use unstable process hashers")

    setup = require(
        TAURI / "commands/setup.rs",
        "reconcile_interrupted_setup_transactions",
        "run_persisted_automatic_rollback",
        "restore_previous_managed_state",
        "apply_planned_artifacts",
        "consume_preview_token",
    )
    if "op.surface ==" in setup or "Mark all remaining operations" in setup:
        fail("setup apply must not mark or validate artifacts by surface")
    direct_mutations = (
        "fs::write",
        "fs::copy",
        "fs::remove_file",
        "fs::remove_dir",
        "fs::remove_dir_all",
        "fs::create_dir_all",
        "fs::rename",
        "fs::OpenOptions",
    )
    for path in (TAURI / "commands/setup.rs", TAURI / "setup_transaction.rs"):
        production = production_rust(path)
        for mutation in direct_mutations:
            if mutation in production:
                fail(
                    f"{path.relative_to(ROOT)} bypasses safe_filesystem with {mutation}"
                )
    if setup.find("consume_preview_token") < setup.find("apply_planned_artifacts"):
        fail("preview token consumption must remain inside the apply owner")

    require(
        TAURI / "setup_transaction.rs",
        "previous_managed_state_digest",
        "post_apply_digest",
        "post_apply_full_digest",
        "validate_backup_copy",
        "RollbackStatus::InFlight",
        "compute_finalize_rollback_status",
    )
    transaction = read(TAURI / "setup_transaction.rs")
    if any(
        obsolete in transaction
        for obsolete in (
            "ManagedDirectory",
            "RestoreDirectoryArtifact",
            "RemoveCreatedSkillDirectory",
        )
    ):
        fail("transaction model retains directory-scoped skill state")
    registry = read(TAURI / "artifact_registry.rs")
    if "SkillDir" in registry or "SkillFile" not in registry:
        fail("skill artifacts must use the SkillFile model")
    bootstrap = read(TAURI / "managed_bootstrap.rs")
    if "STILL_CURRENT_CHANGED_DOCS" in bootstrap:
        fail("Rust must not duplicate historical ownership digests")
    if re.search(r"#\[cfg\(test\)\][\s\S]{0,500}approved_historical_digest", bootstrap):
        fail("historical ownership must not have cfg(test) digest approvals")
    if "manifest.artifacts.len()" in bootstrap:
        fail("historical ownership tests must not rely on a fixed entry count")
    codex_merge = read(
        ROOT / "resources/default-workspace/scripts/merge-codex-config.py"
    )
    if "--rollback-managed" in codex_merge:
        fail("Codex merge script must render rollback content without mutating profiles")
    safe_filesystem = require(
        TAURI / "safe_filesystem.rs",
        "write_regular_file_atomic",
        "write_new_regular_file_synced",
        "create_directory_all_no_symlinks",
        "remove_empty_directory_no_symlinks",
    )
    copy_owner = safe_filesystem.split("pub fn copy_regular_file_no_symlinks", 1)[1]
    copy_owner = copy_owner.split("pub fn remove_regular_file_no_symlinks", 1)[0]
    if "fs::copy" in copy_owner:
        fail("managed regular file copy must publish atomically")
    cursor_profile_ops = read(TAURI / "cursor_profile_ops.rs")
    global_mcp_start = cursor_profile_ops.find("pub fn run_global_mcp_only")
    if global_mcp_start < 0:
        fail("Cursor global MCP setup owner is missing")
    if "write_regular_file_atomic" not in cursor_profile_ops[global_mcp_start:]:
        fail("Cursor global MCP setup must publish through safe_filesystem")
    require(
        TAURI / "managed_reconciliation_contract.rs",
        "fresh_profile_installs_workspace_through_unified_setup",
        "pre_manifest_upgrade_reconciles_to_canonical_inventory",
        "pre_manifest_upgrade_rollback_restores_removed_stale_workspace_file",
    )
    smoke = require(
        ROOT / "scripts/smoke-pre-manifest-upgrade.sh",
        "git archive",
        "AGENT_WORKSPACE_HISTORICAL_FIXTURE_PATH",
        "real_source_commit_pre_manifest_upgrade_smoke",
    )
    if "bundled_workspace_src" in smoke:
        fail("historical smoke must not seed from the current bundled workspace")

    release = read(ROOT / "scripts/release-check.sh")
    for command in (
        "python3 scripts/generate-pre-manifest-ownership.py --check",
        "bash scripts/smoke-pre-manifest-upgrade.sh",
    ):
        if command not in release:
            fail(f"release-check missing required gate: {command}")

    obsolete_files = (
        FRONTEND / "components/SetupLifecycle.tsx",
        FRONTEND / "components/SetupLifecycle.test.tsx",
        FRONTEND / "components/TargetSkillsPanel.tsx",
        FRONTEND / "components/WorkspaceSkillsVerify.tsx",
        FRONTEND / "views/PassiveTargetView.tsx",
        TAURI / "setup_lifecycle_smoke.rs",
    )
    for path in obsolete_files:
        if path.exists():
            fail(f"obsolete setup owner still exists: {path.relative_to(ROOT)}")

    forbidden = (
        "install_default_workspace",
        "repair_default_workspace",
        "plan_workspace_repair",
        "apply_workspace_repair",
        "preview_repair_setup",
        "repair_setup_artifacts",
        "open_install_skills_script",
        "run_cursor_profile_action",
        "CreateOnlyArtifacts",
        "SetupLifecycle",
    )
    forbid_in_tree(TAURI, forbidden)
    forbid_in_tree(FRONTEND, forbidden)
    for path in (
        TAURI / "commands/setup.rs",
        TAURI / "setup_transaction.rs",
        TAURI / "managed_state.rs",
        TAURI / "managed_bootstrap.rs",
        TAURI / "setup_roots.rs",
        TAURI / "stable_digest.rs",
    ):
        if "allow(dead_code)" in read(path):
            fail(f"{path.relative_to(ROOT)} must not hide obsolete code")

    card = require(
        FRONTEND / "components/HarnessInstallationCard.tsx",
        "installationPrimaryAction",
        "showModal",
        "conflict",
    )
    if card.count("<dialog") != 1:
        fail("installation conflict review must have one dialog owner")

    for path in (
        FRONTEND / "views/StartView.tsx",
        FRONTEND / "views/CodexView.tsx",
        FRONTEND / "views/OpenCodeView.tsx",
        FRONTEND / "views/CursorView.tsx",
        FRONTEND / "views/ClaudeView.tsx",
    ):
        text = read(path)
        if text.count("<HarnessInstallationCard") != 1:
            fail(f"{path.relative_to(ROOT)} must render exactly one installation card")
        if re.search(r"\brepair\b|setup lifecycle|transaction fingerprint", text, re.I):
            fail(f"{path.relative_to(ROOT)} exposes obsolete installation terminology")

    print("managed installation contract checks passed")


if __name__ == "__main__":
    main()
