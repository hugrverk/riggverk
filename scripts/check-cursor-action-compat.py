#!/usr/bin/env python3
"""Verify Cursor backend actions map to install-cursor-workspace.sh flags."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "resources/default-workspace/scripts/install-cursor-workspace.sh"
RUST = ROOT / "src-tauri/src/commands/cursor_profile.rs"
CURSOR_VIEW = ROOT / "src/views/CursorView.tsx"
CURSOR_UI = ROOT / "src/lib/cursorWorkspaceResources.ts"
MANIFEST = ROOT / "resources/default-workspace/templates/cursor/manifest.json"

# action id -> argv tail after script path (from run_cursor_profile_action)
ACTION_FLAGS: dict[str, list[str]] = {
    "cursor_diff_global_profile": ["--quiet", "--diff-global-profile"],
    "cursor_apply_global_profile": ["--quiet", "--apply-global-profile"],
    "cursor_validate_global_profile": ["--quiet", "--validate-global-profile"],
    "cursor_open_settings": ["--open-cursor-settings"],
    "cursor_copy_user_rules": ["--copy-user-rules"],
    "cursor_show_playwright_mcp": ["--show-playwright-mcp"],
    "cursor_copy_playwright_mcp": ["--copy-playwright-mcp"],
    "cursor_show_sandbox_safe": ["--show-sandbox-profile", "safe"],
    "cursor_copy_sandbox_safe": ["--copy-sandbox-profile", "safe"],
    "cursor_show_sandbox_playwright_safe": [
        "--show-sandbox-profile",
        "playwright-safe",
    ],
    "cursor_copy_sandbox_playwright_safe": [
        "--copy-sandbox-profile",
        "playwright-safe",
    ],
    "cursor_show_sandbox_playwright_full": [
        "--show-sandbox-profile",
        "playwright-full",
    ],
    "cursor_copy_sandbox_playwright_full": [
        "--copy-sandbox-profile",
        "playwright-full",
    ],
    "cursor_diff_global_agents": ["--quiet", "--global-agents"],
    "cursor_sync_global_agents": ["--quiet", "--apply", "--global-agents"],
}

RUST_MANIFEST_KEYS = [
    "agents",
    "rules",
    "mcp_examples",
    "permissions_templates",
    "global_profile",
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

    for action, flags in ACTION_FLAGS.items():
        for flag in flags:
            if flag.startswith("--"):
                if flag not in script_text and flag not in help_text:
                    fail(
                        f"action {action} uses {flag} but install-cursor-workspace.sh lacks it"
                    )

    rust_text = RUST.read_text(encoding="utf-8")
    for key in RUST_MANIFEST_KEYS:
        if key not in rust_text:
            fail(f"cursor_profile.rs health check missing manifest key: {key}")

    import json

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for key in RUST_MANIFEST_KEYS:
        if key not in manifest:
            fail(f"manifest.json missing key expected by Rust health: {key}")
        if key == "global_profile":
            if not isinstance(manifest[key], str):
                fail("manifest global_profile must be a string path")
        elif not isinstance(manifest[key], list) or not manifest[key]:
            fail(f"manifest {key} must be a non-empty array")

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

    print("Cursor action/script and manifest compatibility checks passed")


if __name__ == "__main__":
    main()
