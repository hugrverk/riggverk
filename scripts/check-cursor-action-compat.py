#!/usr/bin/env python3
"""Verify Cursor health and installation routing use the unified setup owner."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUST = ROOT / "src-tauri/src/commands/cursor_profile.rs"
VIEW = ROOT / "src/views/CursorView.tsx"
MANIFEST = ROOT / "resources/default-workspace/templates/cursor/manifest.json"


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    rust = RUST.read_text(encoding="utf-8")
    view = VIEW.read_text(encoding="utf-8")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    # Each manifest key must be validated as a quoted key inside manifest_status().
    start = rust.find("fn manifest_status(")
    if start == -1:
        fail("cursor_profile.rs manifest_status() not found")
    validator = rust[start : rust.find("\n}\n", start)]
    for key in ("agents", "rules", "mcp_examples", "global_profile", "setup_runtime"):
        if f'"{key}"' not in validator:
            fail(f"Cursor health missing manifest key: {key}")
        if key not in manifest:
            fail(f"Cursor manifest missing key: {key}")
    if manifest.get("setup_runtime") != "native":
        fail("Cursor manifest setup_runtime must be native")

    # The shared harness page owns the unified install review (preview, then apply with the reviewed plan).
    if view.count("<HarnessPage") != 1 or 'harness="cursor"' not in view:
        fail("Cursor view must render exactly one unified harness page for the cursor harness")
    for obsolete in (
        "onRepairWorkspace",
        "run_cursor_profile_action",
        "Repair workspace",
        "repair workspace",
        "apply global profile",
    ):
        if obsolete in view or obsolete in rust:
            fail(f"obsolete Cursor installation path remains: {obsolete}")

    print("Cursor unified installation compatibility checks passed")


if __name__ == "__main__":
    main()
