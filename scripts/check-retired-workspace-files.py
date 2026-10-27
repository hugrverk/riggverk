#!/usr/bin/env python3
"""Verify the frozen list of workspace copies and the runtime assets the app reads from the bundle.

The list lives in src-tauri/src/commands/retired_workspace_files.rs. It is frozen: a bundle file
added later is not part of it, so this check no longer asks for new files to be listed. The Rust
tests pin the list by digest; this check keeps the Rust module, the bundle and the helper assets
consistent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retired_workspace_files as frozen  # noqa: E402

ROOT = frozen.ROOT
BUNDLE = "resources/default-workspace"
COMMANDS = "src-tauri/src/commands.rs"
SRC = "src-tauri/src"
# The list of workspace copies replaced these; nothing may name them again.
OLD_NAMES = ("default_workspace_files", "MANAGED_REFRESH_PATHS", "default_workspace_manifest")
OLD_MANIFEST = "src-tauri/src/commands/default_workspace_manifest.rs"
# State and user data are never workspace copies, whatever the list says.
NEVER_LISTED_PREFIXES = (".agent-workspace/", "docs/context/")

# Helper assets the app runs or renders from the bundle. They are checked in the bundle itself.
REQUIRED_SCRIPTS = (
    "scripts/generate-opencode-config.py",
    "scripts/merge-codex-config.py",
    "scripts/ensure-codex-routing-defaults.py",
)
REQUIRED_TEMPLATES = (
    "templates/opencode.base.json",
    "templates/opencode.policy.json",
    "templates/playwright-mcp.config.json",
    "templates/cursor/manifest.json",
    "templates/cursor/global-profile.json",
    "templates/cursor/mcp/playwright.mcp.json",
)


def errors(root: Path = ROOT) -> list[str]:
    found: list[str] = []
    try:
        listed = frozen.load(root)
    except ValueError as error:
        return [str(error)]
    bundle = root / BUNDLE

    if "mod retired_workspace_files;" not in (root / COMMANDS).read_text(encoding="utf-8"):
        found.append(f"{COMMANDS} must declare the retired_workspace_files module")
    if (root / OLD_MANIFEST).exists():
        found.append(f"{OLD_MANIFEST} was replaced by the frozen list and must stay deleted")
    for path in sorted((root / SRC).rglob("*.rs")):
        if path.name == "retired_workspace_files.rs":
            continue
        text = path.read_text(encoding="utf-8")
        for name in OLD_NAMES:
            if name in text:
                found.append(f"{path.relative_to(root).as_posix()} still refers to {name}")

    if not listed.files:
        found.append("RETIRED_WORKSPACE_FILES lists no files")
    if list(listed.files) != sorted(listed.files):
        found.append("RETIRED_WORKSPACE_FILES must be sorted bytewise")
    if len(set(listed.files)) != len(listed.files):
        found.append("RETIRED_WORKSPACE_FILES lists a path twice")
    if listed.marker in listed.files:
        found.append(f"the marker {listed.marker} stays canonical and must not be in RETIRED_WORKSPACE_FILES")
    for rel in listed.copy_paths():
        if rel.startswith(NEVER_LISTED_PREFIXES) and rel != listed.marker:
            found.append(f"the list names state or user data: {rel}")
        if rel.startswith("/") or ".." in rel.split("/"):
            found.append(f"not a workspace-relative path: {rel}")

    for rel in sorted(set(listed.retired_from_bundle) - set(listed.files)):
        found.append(f"RETIRED_FROM_BUNDLE names a path that is not listed: {rel}")
    for rel in listed.copy_paths():
        if rel in listed.retired_from_bundle:
            if (bundle / rel).exists():
                found.append(f"documented as retired from the bundle, but the bundle holds it: {rel}")
        elif not (bundle / rel).is_file():
            found.append(f"listed file is not in the bundle and not documented as retired: {rel}")

    for rel in (*REQUIRED_SCRIPTS, *REQUIRED_TEMPLATES):
        path = bundle / rel
        if not path.is_file() or path.stat().st_size == 0:
            found.append(f"required runtime asset missing or empty in the bundle: {rel}")
    manifest = bundle / "templates/cursor/manifest.json"
    if manifest.is_file():
        cursor = json.loads(manifest.read_text(encoding="utf-8"))
        for name in cursor["agents"]:
            rel = f"{cursor['agents_dir']}/{name}"
            path = bundle / rel
            if not path.is_file() or path.stat().st_size == 0:
                found.append(f"Cursor adapter missing or empty in the bundle: {rel}")
    return found


def main() -> None:
    found = errors()
    if found:
        raise SystemExit("FAIL: " + "\n      ".join(found))
    listed = frozen.load()
    print(
        f"  frozen workspace copy list: {len(listed.copy_paths())} files sorted, each in the bundle or documented as retired from it; "
        "app-run helper scripts, templates and Cursor adapters checked in the bundle"
    )


if __name__ == "__main__":
    main()
