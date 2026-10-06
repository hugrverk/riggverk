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
    skill_adapters = section_paths(manifest_text, "Skill adapters")
    docs = section_paths(manifest_text, "Docs")
    metadata = section_paths(manifest_text, "Metadata")
    refresh = managed_refresh_paths(manifest_text)

    required_scripts = {
        "scripts/install-agent-rules.sh",
        "scripts/install-runtime-agents.sh",
        "scripts/install-opencode-config.sh",
        "scripts/merge-opencode-config.py",
        "scripts/generate-opencode-config.py",
        "scripts/playwright-mcp-lib.sh",
        "scripts/lib/platform-paths.sh",
        "scripts/check-playwright-mcp.sh",
        "scripts/install-codex-config.sh",
        "scripts/install-codex-agents.sh",
        "scripts/merge-codex-config.py",
        "scripts/ensure-codex-routing-defaults.py",
    }
    required_templates = {
        "templates/opencode.base.json",
        "templates/opencode.policy.json",
        "templates/playwright-mcp.config.json",
    }
    required_docs = {
        "docs/prompt-templates/prompt.md",
        "docs/prompt-templates/goal-prompt.md",
        "docs/prompt-templates/batch-prompt.md",
    }
    required_refresh = {
        "scripts/install-agent-rules.sh",
        "scripts/install-runtime-agents.sh",
        "scripts/install-opencode-config.sh",
        "scripts/install-codex-config.sh",
        "scripts/lib/platform-paths.sh",
        "scripts/ensure-codex-routing-defaults.py",
    }
    required_cursor_adapters = {
        "templates/cursor/agents/verifier.md",
        "templates/cursor/agents/security-reviewer.md",
        "templates/cursor/agents/release-checker.md",
        "templates/cursor/agents/browser-qa.md",
        "templates/cursor/agents/repo-scout.md",
        "templates/cursor/agents/inspector.md",
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

    generated_skill_adapters = {
        path.relative_to(ROOT / "resources" / "default-workspace").as_posix()
        for path in (ROOT / "resources/default-workspace/templates/skills").glob("*/*/SKILL.md")
    }
    skill_overlay_sources = {
        path.relative_to(ROOT / "resources" / "default-workspace").as_posix()
        for path in (ROOT / "resources/default-workspace/templates/skills/_overlays").rglob("*.md")
    }
    # The adapter count is derived from the canonical skills and the generator's
    # target list instead of being pinned: every skill needs one adapter per target.
    adapter_metadata = json.loads(
        (ROOT / "resources/default-workspace/metadata/skill-adapters.json").read_text(encoding="utf-8")
    )
    canonical_skills = list((ROOT / "resources/default-workspace/skills").rglob("SKILL.md"))
    expected_adapters = len(canonical_skills) * len(adapter_metadata.get("targets", []))
    if not canonical_skills or len(generated_skill_adapters) != expected_adapters:
        fail(
            f"expected {expected_adapters} generated skill adapters "
            f"({len(canonical_skills)} skills x {len(adapter_metadata.get('targets', []))} targets), "
            f"found {len(generated_skill_adapters)}"
        )
    expected_skill_adapter_paths = generated_skill_adapters | skill_overlay_sources
    missing_skill_adapter_paths = expected_skill_adapter_paths - skill_adapters
    extra_skill_adapter_paths = skill_adapters - expected_skill_adapter_paths
    for rel in sorted(missing_skill_adapter_paths):
        fail(f"Skill adapters section missing: {rel}")
    for rel in sorted(extra_skill_adapter_paths):
        fail(f"Skill adapters section has stale path: {rel}")
    if "metadata/skill-adapters.json" not in metadata:
        fail("Metadata section missing: metadata/skill-adapters.json")
    if not (ROOT / "resources/default-workspace/metadata/skill-adapters.json").is_file():
        fail("skill adapter metadata missing on disk")

    workspace_root = ROOT / "resources" / "default-workspace"
    for label, listed in (
        ("Scripts", scripts),
        ("Templates", templates),
        ("Skill adapters", skill_adapters),
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
        "  bundled manifest: runtime installers + Cursor/skill adapters listed; "
        "app action scripts refreshable backup-first"
    )


if __name__ == "__main__":
    main()
