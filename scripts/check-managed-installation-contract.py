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
    # Markers must be present in code or string literals, not only in comments.
    searchable = blank_rust(text, comments=True, strings=False) if path.suffix == ".rs" else text
    for needle in needles:
        if needle not in searchable:
            fail(f"{path.relative_to(ROOT)} missing contract marker: {needle}")
    return text


def _skip_non_code(text: str, i: int) -> int:
    """Return the index just past a comment, string or char literal starting at i, else i."""
    n = len(text)
    two = text[i : i + 2]
    if two == "//":
        end = text.find("\n", i)
        return n if end == -1 else end
    if two == "/*":
        depth = 0
        j = i
        while j < n:
            pair = text[j : j + 2]
            if pair == "/*":
                depth += 1
                j += 2
            elif pair == "*/":
                depth -= 1
                j += 2
                if depth == 0:
                    return j
            else:
                j += 1
        return n
    raw = re.compile(r'b?r(#*)"').match(text, i)
    if raw and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
        close = '"' + raw.group(1)
        end = text.find(close, raw.end())
        return n if end == -1 else end + len(close)
    if text[i] == '"':
        j = i + 1
        while j < n:
            if text[j] == "\\":
                j += 2
            elif text[j] == '"':
                return j + 1
            else:
                j += 1
        return n
    if text[i] == "'":
        if text[i + 1 : i + 4] == "\\''":
            return i + 4
        if text[i + 1 : i + 2] == "\\":
            end = text.find("'", i + 2)
            return n if end == -1 else end + 1
        if text[i + 2 : i + 3] == "'":
            return i + 3
    return i


def blank_rust(text: str, *, comments: bool, strings: bool) -> str:
    """Blank out comments and/or string and char literals, keeping line structure."""
    out: list[str] = []
    i = 0
    while i < len(text):
        j = _skip_non_code(text, i)
        if j == i:
            out.append(text[i])
            i += 1
            continue
        segment = text[i:j]
        is_comment = segment.startswith("//") or segment.startswith("/*")
        if (is_comment and comments) or (not is_comment and strings):
            out.append(re.sub(r"[^\n]", " ", segment))
        else:
            out.append(segment)
        i = j
    return "".join(out)


def _match_brace(text: str, open_idx: int) -> int:
    depth = 0
    i = open_idx
    while i < len(text):
        j = _skip_non_code(text, i)
        if j != i:
            i = j
            continue
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    fail("unbalanced braces while scanning Rust source")
    raise AssertionError("unreachable")


_ITEM_START = re.compile(
    r"(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+(?:\"[^\"]*\"\s+)?)*"
    r"(?:fn|mod|impl|struct|enum|trait|const|static|use|type)\b"
)
_CFG_TEST = re.compile(r"#\[cfg\(\s*test\s*\)\]")


def _cfg_test_item_end(text: str, start: int) -> int:
    """End index of the item/arm/statement guarded by a #[cfg(test)] attribute."""
    i = start
    while True:  # skip whitespace and any further attributes
        while i < len(text) and text[i].isspace():
            i += 1
        if text.startswith("#[", i):
            i = text.index("]", i) + 1
            continue
        break
    item = _ITEM_START.match(text, i)
    keyword = item.group(0).split()[-1] if item else ""
    depth = 0
    j = i
    while j < len(text):
        k = _skip_non_code(text, j)
        if k != j:
            j = k
            continue
        ch = text[j]
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        elif ch == "{" and depth == 0 and keyword not in ("use", "const", "static", "type"):
            end = _match_brace(text, j) + 1
            while end < len(text) and text[end] in " \t":
                end += 1
            return end + 1 if text[end : end + 1] == "," else end
        elif ch == "{":
            depth += 1
        elif ch == "}":
            if depth == 0:
                return j  # end of the enclosing block (arm without trailing comma)
            depth -= 1
        elif depth == 0 and ch in ";,":
            if ch == "," and item:
                j += 1
                continue
            return j + 1
        j += 1
    return len(text)


def production_rust(path: Path) -> str:
    """Rust source with every #[cfg(test)] item, arm and statement blanked out."""
    text = read(path)
    if "#![cfg(test)]" in text:
        return re.sub(r"[^\n]", " ", text)
    out: list[str] = []
    i = 0
    while True:
        match = _CFG_TEST.search(text, i)
        if not match:
            out.append(text[i:])
            break
        out.append(text[i : match.start()])
        end = _cfg_test_item_end(text, match.end())
        out.append(re.sub(r"[^\n]", " ", text[match.start() : end]))
        i = end
    return "".join(out)


def function_body(code: str, name: str) -> str:
    """Body of `fn name(...)` in comment/string-free code, or fail."""
    match = re.search(rf"\bfn\s+{re.escape(name)}\b", code)
    if not match:
        fail(f"function not found: {name}")
    brace = code.index("{", match.end())
    return code[brace : _match_brace(code, brace) + 1]


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
    # The semantic pre-manifest ownership coverage runs once, as its own
    # release-check step (checked for presence below), not again from here.
    generated_python = list(
        (ROOT / "resources/default-workspace").rglob("__pycache__")
    ) + list((ROOT / "resources/default-workspace").rglob("*.pyc"))
    if generated_python:
        fail("bundled default workspace contains generated Python cache files")

    # The catalog size is not pinned here: the canonical tree is the source of truth, and every
    # harness installs its SKILL.md directly, so there is no generated skill output to keep current.
    skills = list((ROOT / "resources/default-workspace/skills").rglob("SKILL.md"))
    if not skills:
        fail("bundled skills are missing under resources/default-workspace/skills")
    for retired in (
        ROOT / "resources/default-workspace/templates/skills",
        ROOT / "resources/default-workspace/metadata/skill-adapters.json",
        ROOT / "scripts/generate-skill-adapters.py",
    ):
        if retired.exists():
            fail(f"per-harness skill adapters are retired; remove {retired.relative_to(ROOT)}")

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
        "fs::create_dir",
        "fs::create_dir_all",
        "fs::rename",
        "fs::hard_link",
        "fs::set_permissions",
        "fs::OpenOptions",
        "File::create",
        "OpenOptions",
        "set_permissions",
    )
    production_code: dict[Path, str] = {}
    for path in (
        TAURI / "commands/setup.rs",
        TAURI / "setup_transaction.rs",
        # Keeping the user's version of a skill or agent file writes only kept-files.json, through
        # safe_filesystem; diffing writes nothing.
        TAURI / "kept_files.rs",
        TAURI / "file_conflicts.rs",
        TAURI / "commands/file_conflicts.rs",
    ):
        # Whole production file, minus #[cfg(test)] items; comments and string
        # literals are blanked so only real calls count.
        production = blank_rust(production_rust(path), comments=True, strings=True)
        production_code[path] = production
        for mutation in direct_mutations:
            if mutation in production:
                fail(
                    f"{path.relative_to(ROOT)} bypasses safe_filesystem with {mutation}"
                )
    if "write_regular_file_atomic" not in production_code[TAURI / "kept_files.rs"]:
        fail("kept_files.rs must publish kept-files.json through safe_filesystem")
    # The preview token is consumed exactly once, inside the apply owner.
    setup_code = production_code[TAURI / "commands/setup.rs"]
    if len(re.findall(r"\bconsume_preview_token\b", setup_code)) != 1:
        fail("preview token must be consumed in exactly one place (the apply owner)")
    # apply_planned_artifacts reports progress around run_planned_artifacts, which holds the apply body: the
    # token must be consumed in that body, and the wrapper must delegate to it.
    apply_wrapper = function_body(setup_code, "apply_planned_artifacts")
    if not re.search(r"\brun_planned_artifacts\s*\(", apply_wrapper):
        fail("apply_planned_artifacts must delegate to run_planned_artifacts")
    if "consume_preview_token" not in function_body(setup_code, "run_planned_artifacts"):
        fail("preview token consumption must remain inside the apply body (run_planned_artifacts)")

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
    # Skills are one global surface installed per read folder: the retired per-harness skill surfaces
    # only exist to parse old manifests and records, and are never planned.
    lifecycle = read(TAURI / "setup_lifecycle.rs")
    all_surfaces = re.search(r"pub const ALL: &'static \[SetupSurfaceId\] = &\[(.*?)\];", lifecycle, re.S)
    if not all_surfaces:
        fail("SetupSurfaceId::ALL not found")
    if "SetupSurfaceId::Skills" not in all_surfaces.group(1):
        fail("SetupSurfaceId::ALL must contain the global Skills surface")
    for retired_surface in ("ClaudeSkills", "OpenCodeSkills", "CodexSkills", "CursorSkills"):
        if retired_surface in all_surfaces.group(1):
            fail(f"retired per-harness skill surface {retired_surface} must not be in SetupSurfaceId::ALL")
    skill_roots = read(TAURI / "skill_roots.rs")
    for needed in ("pub fn install_roots", "pub fn readers", "pub struct SkillScope", "pub fn codex_home_is_custom"):
        if needed not in skill_roots:
            fail(f"skill_roots.rs must define {needed!r}: skills are installed per read folder")
    if "SkillScope" not in transaction or "scope_for_surfaces" not in transaction:
        fail("setup_transaction must plan the skills surface for the roots of a SkillScope")
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
        "python3 scripts/generate-rules-history.py --check",
        "python3 scripts/generate-shipped-digests.py --check",
        "python3 scripts/check-skill-routing.py",
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

    # Apply only ever receives the reviewed plan's fingerprint and one-time token.
    flow = require(
        FRONTEND / "hooks/useInstallFlow.ts",
        '"apply_setup"',
        "planFingerprint: review.plan.plan_fingerprint",
        "previewToken: review.plan.preview_token",
    )
    if flow.count('"apply_setup"') != 1:
        fail("useInstallFlow must be the only apply_setup caller in the install flow")
    require(FRONTEND / "hooks/useInstallScreen.ts", "useInstallFlow()")
    require(FRONTEND / "components/InstallPlanPane.tsx", "conflict")

    # One install owner per page: Start and the shared HarnessPage each render one plan pane;
    # the harness views are thin configs around HarnessPage.
    for path in (FRONTEND / "views/StartView.tsx", FRONTEND / "views/HarnessPage.tsx"):
        if read(path).count("<InstallPlanPane") != 1:
            fail(f"{path.relative_to(ROOT)} must render exactly one InstallPlanPane")
    for path in (
        FRONTEND / "views/CodexView.tsx",
        FRONTEND / "views/OpenCodeView.tsx",
        FRONTEND / "views/CursorView.tsx",
        FRONTEND / "views/ClaudeView.tsx",
    ):
        if read(path).count("<HarnessPage") != 1:
            fail(f"{path.relative_to(ROOT)} must render exactly one HarnessPage")
    for path in (
        FRONTEND / "views/StartView.tsx",
        FRONTEND / "views/HarnessPage.tsx",
        FRONTEND / "components/InstallPlanPane.tsx",
    ):
        if re.search(r"\brepair\b|setup lifecycle|transaction fingerprint", read(path), re.I):
            fail(f"{path.relative_to(ROOT)} exposes obsolete installation terminology")

    print("managed installation contract checks passed")


if __name__ == "__main__":
    main()
