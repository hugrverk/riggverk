#!/usr/bin/env python3
"""Guard the unified managed installation workflow and its safety contracts."""

from __future__ import annotations

import json
import re
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
    if not isinstance(entries, list) or len(entries) != 14:
        fail("pre-manifest ownership metadata must contain 14 exact entries")
    for entry in entries:
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
        "pub fn directory",
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
    require(
        TAURI / "managed_reconciliation_contract.rs",
        "fresh_profile_installs_workspace_through_unified_setup",
        "pre_manifest_upgrade_reconciles_to_canonical_inventory",
        "pre_manifest_upgrade_rollback_restores_removed_stale_workspace_file",
    )

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
