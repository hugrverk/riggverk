#!/usr/bin/env python3
"""Verify the bundled workspace manifest lists required runtime assets."""

from __future__ import annotations

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
    docs = section_paths(manifest_text, "Docs")
    refresh = managed_refresh_paths(manifest_text)

    required_scripts = {
        "scripts/install-agent-rules.sh",
        "scripts/install-runtime-agents.sh",
        "scripts/install-opencode-config.sh",
        "scripts/generate-opencode-config.py",
        "scripts/playwright-mcp-lib.sh",
        "scripts/check-playwright-mcp.sh",
    }
    required_templates = {
        "templates/opencode.base.json",
        "templates/opencode.policy.json",
        "templates/playwright-mcp.config.json",
    }
    required_docs = {
        "docs/prompt-templates/standard-prompt.md",
        "docs/prompt-templates/masterprompt.md",
        "docs/prompt-templates/batchprompt.md",
    }
    required_refresh = {
        "scripts/install-agent-rules.sh",
        "scripts/install-runtime-agents.sh",
        "scripts/install-opencode-config.sh",
    }
    required_cursor_adapters = {
        "templates/cursor/agents/verifier.md",
        "templates/cursor/agents/security-reviewer.md",
        "templates/cursor/agents/release-checker.md",
        "templates/cursor/agents/browser-qa.md",
        "templates/cursor/agents/repo-scout.md",
    }

    for rel in sorted(required_scripts - scripts):
        fail(f"Scripts section missing: {rel}")
    for rel in sorted(required_templates - templates):
        fail(f"Templates section missing: {rel}")
    for rel in sorted(required_docs - docs):
        fail(f"Docs section missing: {rel}")
    for rel in sorted(required_refresh - refresh):
        fail(f"managed refresh list missing app action script: {rel}")
    for rel in sorted(required_cursor_adapters - templates):
        fail(f"Templates section missing Cursor adapter: {rel}")
    for rel in sorted(required_cursor_adapters):
        adapter_path = ROOT / "resources" / "default-workspace" / rel
        if not adapter_path.is_file() or adapter_path.stat().st_size == 0:
            fail(f"Cursor adapter missing or empty on disk: {rel}")

    user_owned_prefixes = ("docs/", "skills/", "agents/")
    for rel in sorted(refresh):
        if rel.startswith(user_owned_prefixes):
            fail(f"managed refresh must not overwrite user-authored source: {rel}")
        if rel in {"templates/global-agent-rules.md", "templates/opencode.json"}:
            fail(f"managed refresh must not overwrite editable source: {rel}")

    print(
        "  bundled manifest: runtime installers + Cursor adapters listed; "
        "app action scripts refreshable backup-first"
    )


if __name__ == "__main__":
    main()
