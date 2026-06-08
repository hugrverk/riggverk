#!/usr/bin/env python3
"""Verify Cursor backend actions map to install-cursor-workspace.sh helpers."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "resources/default-workspace/scripts/install-cursor-workspace.sh"
RUST = ROOT / "src-tauri/src/commands/cursor_profile.rs"
CURSOR_VIEW = ROOT / "src/views/CursorView.tsx"
CURSOR_UI = ROOT / "src/lib/cursorWorkspaceResources.ts"
MANIFEST = ROOT / "resources/default-workspace/templates/cursor/manifest.json"

# Shell-backed manual helpers only
ACTION_FLAGS: dict[str, list[str]] = {
    "cursor_open_settings": ["--open-cursor-settings"],
    "cursor_copy_user_rules": ["--copy-user-rules"],
}

RUST_MANIFEST_KEYS = [
    "agents",
    "rules",
    "mcp_examples",
    "global_profile",
    "setup_runtime",
]

NATIVE_ACTIONS = [
    "cursor_diff_global_profile",
    "cursor_apply_global_profile",
    "cursor_validate_global_profile",
    "cursor_diff_global_agents",
    "cursor_sync_global_agents",
]

FORBIDDEN_SHELL_PATTERNS = [
    "--global-agents",
    "--global-agents-only",
    "CURSOR_AGENTS_TARGET",
    "$HOME/.cursor/agents",
]


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if not SCRIPT.is_file():
        fail(f"missing script: {SCRIPT}")
    script_text = SCRIPT.read_text(encoding="utf-8")
    help_match = re.search(
        r"Usage:.*?(?=\n[A-Z]|\Z)", script_text, flags=re.DOTALL
    )
    help_text = help_match.group(0) if help_match else script_text

    for pattern in FORBIDDEN_SHELL_PATTERNS:
        if pattern in script_text:
            fail(
                f"install-cursor-workspace.sh must not implement global agent sync ({pattern})"
            )

    for action, flags in ACTION_FLAGS.items():
        for flag in flags:
            if flag.startswith("--"):
                if flag not in script_text and flag not in help_text:
                    fail(
                        f"action {action} uses {flag} but install-cursor-workspace.sh lacks it"
                    )

    rust_text = RUST.read_text(encoding="utf-8")
    for action in NATIVE_ACTIONS:
        if action not in rust_text:
            fail(f"cursor_profile.rs missing native action handler: {action}")
    if "run_global_profile_action_native" not in rust_text:
        fail("cursor_profile.rs must route global profile actions through native implementation")

    for key in RUST_MANIFEST_KEYS:
        if key not in rust_text:
            fail(f"cursor_profile.rs health check missing manifest key: {key}")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for key in RUST_MANIFEST_KEYS:
        if key not in manifest:
            fail(f"manifest.json missing key expected by Rust health: {key}")
        if key in {"global_profile", "setup_runtime"}:
            if not isinstance(manifest[key], str):
                fail(f"manifest {key} must be a string")
        elif not isinstance(manifest[key], list) or not manifest[key]:
            fail(f"manifest {key} must be a non-empty array")
    if manifest.get("setup_runtime") != "native":
        fail("manifest setup_runtime must be native")

    view_text = CURSOR_VIEW.read_text(encoding="utf-8")
    ui_text = CURSOR_UI.read_text(encoding="utf-8")
    if "repair workspace" not in view_text:
        fail("CursorView.tsx must expose a repair workspace action for stale resources")
    if "isCursorWorkspaceResourcesStale" not in view_text:
        fail("CursorView.tsx must use isCursorWorkspaceResourcesStale for stale-resource UX")
    if "Repair or update the workspace on Start" in view_text:
        fail("CursorView.tsx must not direct stale-resource repair to Start")
    if "CURSOR_STALE_RESOURCES_MESSAGE" not in ui_text:
        fail("cursorWorkspaceResources.ts must define CURSOR_STALE_RESOURCES_MESSAGE")
    if "Repair workspace resources, then apply the global profile." not in rust_text:
        fail("cursor_profile.rs stale next_action must mention repair workspace resources")
    if "Repair or update the workspace on Start" in rust_text:
        fail("cursor_profile.rs must not direct stale-resource repair to Start")

    docs_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in [
            ROOT / "README.md",
            ROOT / "resources/default-workspace/README.md",
            ROOT / "resources/default-workspace/docs/AGENT_RULES.md",
            ROOT / "resources/default-workspace/docs/SKILLS.md",
            ROOT / "resources/default-workspace/templates/cursor/README.md",
            ROOT / "resources/default-workspace/templates/cursor/mcp/README.md",
        ]
    )
    stale_doc_phrases = [
        "CLI-only: `--project --target",
        "install-cursor-workspace.sh --project --target",
        "project rules (CLI-only",
        "See `templates/cursor/sandbox/`",
        "permissions_templates",
        "legacy_sandbox_profiles",
    ]
    for phrase in stale_doc_phrases:
        if phrase in docs_text:
            fail(f"Cursor docs contain stale/deprecated phrase: {phrase}")

    print("Cursor action/script and manifest compatibility checks passed")


if __name__ == "__main__":
    main()
