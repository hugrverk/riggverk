#!/usr/bin/env python3
"""Verify the bundled workspace manifest lists required runtime assets."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "src-tauri" / "src" / "commands" / "default_workspace_manifest.rs"
DEFAULTS = ROOT / "src-tauri" / "src" / "commands" / "defaults.rs"


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def section_paths(text: str, label: str) -> set[str]:
    match = re.search(
        rf'"{re.escape(label)}",\s*&\[\s*([^\]]+)\]',
        text,
        re.DOTALL,
    )
    if not match:
        fail(f"bundled manifest missing {label} section")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def managed_refresh_paths(text: str) -> set[str]:
    match = re.search(
        r"MANAGED_REFRESH_PATHS:\s*&\[&str\]\s*=\s*&\[([^\]]+)\]",
        text,
        re.DOTALL,
    )
    if not match:
        fail("bundled manifest missing MANAGED_REFRESH_PATHS")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def main() -> None:
    if not MANIFEST.is_file():
        fail(f"manifest not found: {MANIFEST.relative_to(ROOT)}")
    if not DEFAULTS.is_file():
        fail(f"defaults module not found: {DEFAULTS.relative_to(ROOT)}")

    manifest_text = MANIFEST.read_text(encoding="utf-8")
    defaults_text = DEFAULTS.read_text(encoding="utf-8")

    if 'mod manifest;' not in defaults_text:
        fail("defaults.rs must load the centralized bundled manifest")
    if "manifest::categories()" not in defaults_text:
        fail("default_workspace_files() must delegate to manifest::categories()")
    if "manifest::MANAGED_REFRESH_PATHS" not in defaults_text:
        fail("managed refresh paths must come from the centralized manifest")

    scripts = section_paths(manifest_text, "Scripts")
    templates = section_paths(manifest_text, "Templates")
    skills = section_paths(manifest_text, "Skills")
    docs = section_paths(manifest_text, "Docs")
    metadata = section_paths(manifest_text, "Metadata")
    refresh = managed_refresh_paths(manifest_text)

    required_scripts = {
        "scripts/generate-opencode-config.py",
        "scripts/merge-codex-config.py",
        "scripts/ensure-codex-routing-defaults.py",
    }
    required_templates = {
        "templates/opencode.base.json",
        "templates/opencode.policy.json",
        "templates/playwright-mcp.config.json",
    }
    required_refresh = {
        "templates/cursor/manifest.json",
        "templates/cursor/global-profile.json",
        "templates/cursor/mcp/playwright.mcp.json",
    }
    cursor = json.loads(
        (ROOT / "resources/default-workspace/templates/cursor/manifest.json").read_text(encoding="utf-8")
    )
    required_cursor_adapters = {f"{cursor['agents_dir']}/{name}" for name in cursor["agents"]}

    for rel in sorted(required_scripts - scripts):
        fail(f"Scripts section missing: {rel}")
    for rel in sorted(required_templates - templates):
        fail(f"Templates section missing: {rel}")
    for rel in sorted(required_refresh - refresh):
        fail(f"managed refresh list missing Cursor profile template: {rel}")
    for rel in sorted(required_cursor_adapters - templates):
        fail(f"Templates section missing Cursor adapter: {rel}")
    for rel in sorted(required_cursor_adapters):
        adapter_path = ROOT / "resources" / "default-workspace" / rel
        if not adapter_path.is_file() or adapter_path.stat().st_size == 0:
            fail(f"Cursor adapter missing or empty on disk: {rel}")

    # Every harness installs the canonical SKILL.md, so the Skills section is the whole
    # skills/ tree (SKILL.md plus supporting files) and nothing else ships for skills.
    workspace_root = ROOT / "resources" / "default-workspace"
    skill_tree = {
        path.relative_to(workspace_root).as_posix()
        for path in (workspace_root / "skills").rglob("*")
        if path.is_file() and not path.name.startswith(".")
    }
    if not any(rel.endswith("/SKILL.md") for rel in skill_tree):
        fail("no canonical skills found under resources/default-workspace/skills")
    for rel in sorted(skill_tree - skills):
        fail(f"Skills section missing: {rel}")
    for rel in sorted(skills - skill_tree):
        fail(f"Skills section has stale path: {rel}")
    retired = [rel for rel in skills | templates | metadata if rel.startswith("templates/skills/") or rel == "metadata/skill-adapters.json"]
    for rel in sorted(retired):
        fail(f"per-harness skill adapters are retired; manifest still lists: {rel}")
    if '"Skill adapters"' in manifest_text:
        fail("bundled manifest still has a Skill adapters section")

    for label, listed in (
        ("Scripts", scripts),
        ("Templates", templates),
        ("Skills", skills),
        ("Docs", docs),
        ("Metadata", metadata),
    ):
        for rel in sorted(listed):
            if not (workspace_root / rel).is_file():
                fail(f"{label} section lists a file that does not exist: {rel}")

    user_owned_prefixes = ("docs/", "skills/", "agents/")
    for rel in sorted(refresh):
        if rel.startswith(user_owned_prefixes):
            fail(f"managed refresh must not overwrite user-authored source: {rel}")
        if rel in {"templates/global-agent-rules.md", "templates/opencode.json"}:
            fail(f"managed refresh must not overwrite editable source: {rel}")

    print(
        "  bundled manifest: app-run helper scripts + Cursor adapters + skills tree listed; "
        "Cursor profile templates refreshable backup-first"
    )


if __name__ == "__main__":
    main()
