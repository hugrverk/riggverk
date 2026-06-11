#!/usr/bin/env python3
"""Guard README copies against known stale migration and settings drift."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_README = ROOT / "README.md"
WORKSPACE_README = ROOT / "resources/default-workspace/README.md"
SETTINGS_DEFAULTS = ROOT / "src/lib/settingsDraft.ts"

README_PATHS = (APP_README, WORKSPACE_README)


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def read(path: Path) -> str:
    if not path.is_file():
        fail(f"missing file: {path}")
    return path.read_text(encoding="utf-8")


def main() -> None:
    for path in README_PATHS:
        text = read(path)
        rel = path.relative_to(ROOT)
        for banned in ("ux-workspace", "private-context"):
            if banned in text:
                fail(f"{rel} must not mention deprecated repo boundary: {banned}")
        if "24 starter skills" in text:
            fail(f"{rel} must not claim 24 starter skills")

    app_text = read(APP_README)
    settings_text = read(SETTINGS_DEFAULTS)

    default_match = re.search(
        r'export const DEFAULT_TARGET_IDS = (\[[^\]]+\]);',
        settings_text,
    )
    if not default_match:
        fail("settingsDraft.ts missing DEFAULT_TARGET_IDS")
    default_ids = default_match.group(1)
    if "codex_config" in default_ids:
        fail("DEFAULT_TARGET_IDS must not include codex_config by default")

    settings_table = re.search(
        r"\| `enabled_target_ids` \|.*?\|",
        app_text,
        flags=re.DOTALL,
    )
    if not settings_table:
        fail("README.md settings table missing enabled_target_ids row")
    if "codex_config" in settings_table.group(0):
        fail("README.md must not list codex_config in default enabled_target_ids")

    if "app_font_size" not in app_text:
        fail("README.md must document app_font_size setting")
    if "extra-large" not in app_text:
        fail("README.md must document extra-large app_font_size value")

    if re.search(r"\*\*Tools\*\*.*Prompt Loops", app_text):
        fail("README.md must not describe a shared Tools navigation destination")
    if "Tool switching lives in the left sidebar" in app_text:
        fail("README.md must not describe obsolete tool sidebar switching")
    if "up to 500 recent commits" in app_text or "500 recent commits" in app_text:
        fail("README.md must not claim a hard 500-commit Repo Dashboard history cap")
    if "Prompt Loops" not in app_text or "Repo Dashboard" not in app_text:
        fail("README.md must document Prompt Loops and Repo Dashboard surfaces")

    if "Save in Settings" in app_text or "Save** in Settings" in app_text:
        fail("README.md must not say target toggles require Save in Settings")

    if "bundled resource preview" in app_text:
        fail("README.md must not claim bundled resource preview UI on Workspace")

    if "Install or Update" not in app_text:
        fail("README.md must document the unified Install or Update workflow")

    for path in (
        ROOT / "resources/default-workspace/docs/USING_THE_APP.md",
        ROOT / "resources/default-workspace/docs/WORKFLOWS.md",
        ROOT / "resources/default-workspace/docs/TROUBLESHOOTING.md",
    ):
        text = read(path)
        rel = path.relative_to(ROOT)
        if "Save in Settings" in text:
            fail(f"{rel} must not say target toggles require Save in Settings")
        if "ux-context" in text:
            fail(f"{rel} must not reference ux-context for prompt templates")

    contract = read(ROOT / "docs/WORKSPACE_CONTRACT.md")
    for stale in (
        "read-only summary of bundled default resources in the Workspace tab",
        "read-only workspace creation dry-run plan",
    ):
        if stale in contract:
            fail(f"WORKSPACE_CONTRACT.md must not claim stale Workspace UI: {stale}")

    combined_active_docs = "\n".join(read(path) for path in README_PATHS)
    for obsolete in ("Setup Lifecycle", "repair workspace", "update resources"):
        if obsolete.lower() in combined_active_docs.lower():
            fail(f"README copies retain obsolete installation term: {obsolete}")

    sandbox_primary_patterns = [
        "playwright-safe as the primary",
        "playwright-full as the primary",
        "safe/playwright-safe/playwright-full as primary",
        "primary Cursor UX is the safe/playwright",
    ]
    for phrase in sandbox_primary_patterns:
        if phrase in app_text:
            fail(f"README.md presents legacy sandbox profiles as primary UX: {phrase}")

    print("README/docs drift checks passed")


if __name__ == "__main__":
    main()
