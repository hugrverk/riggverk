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


def contains_positive_claim(text: str, phrase: str) -> bool:
    lowered = text.lower()
    needle = phrase.lower()
    start = 0
    while True:
        pos = lowered.find(needle, start)
        if pos == -1:
            return False
        window = lowered[max(0, pos - 24):pos]
        if any(neg in window for neg in ("not ", "never ", "does not ", "don't ", "cannot ")):
            start = pos + 1
            continue
        return True
    return False


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
    if "reduce_motion" not in app_text:
        fail("README.md must document reduce_motion setting")
    if "landing_view" not in app_text:
        fail("README.md must document landing_view setting")

    if re.search(r"\*\*Tools\*\*.*Prompt Builder", app_text):
        fail("README.md must not describe a shared Tools navigation destination")
    if "Tool switching lives in the left sidebar" in app_text:
        fail("README.md must not describe obsolete tool sidebar switching")
    if "up to 500 recent commits" in app_text or "500 recent commits" in app_text:
        fail("README.md must not claim a hard 500-commit Repo Dashboard history cap")
    if "Prompt Builder" not in app_text or "Repo Dashboard" not in app_text:
        fail("README.md must document Prompt Builder and Repo Dashboard surfaces")

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
    if "approval_policy" not in contract or "sandbox_mode" not in contract:
        fail("WORKSPACE_CONTRACT.md must name approval_policy and sandbox_mode Codex ownership")
    if re.search(
        r"top-level and profile fields|generic.*profile fields|manages.*profile fields",
        contract,
        flags=re.IGNORECASE,
    ):
        fail("WORKSPACE_CONTRACT.md must not claim generic current Codex profile ownership")

    release_smoke = read(ROOT / "docs/APP_RELEASE_SMOKE.md")
    if "Recover previous uninstall" not in release_smoke and "uninstall" not in release_smoke.lower():
        fail("APP_RELEASE_SMOKE.md must include uninstall recovery smoke")
    if "Reduce Motion" not in release_smoke and "reduce motion" not in release_smoke.lower():
        fail("APP_RELEASE_SMOKE.md must include Reduce Motion smoke")
    if "landing page" not in release_smoke.lower() and "landing_view" not in release_smoke:
        fail("APP_RELEASE_SMOKE.md must include landing page smoke")

    active_docs = "\n".join(
        read(path)
        for path in (
            APP_README,
            WORKSPACE_README,
            ROOT / "docs/WORKSPACE_CONTRACT.md",
            ROOT / "docs/SECURITY_MODEL.md",
            ROOT / "docs/APP_RELEASE_SMOKE.md",
            ROOT / "resources/default-workspace/docs/USING_THE_APP.md",
            ROOT / "resources/default-workspace/docs/TROUBLESHOOTING.md",
        )
    )
    for false_security_claim in (
        "No secrets in transit or at rest",
        "Environment variables or `.env` files",
    ):
        if false_security_claim in active_docs:
            fail(
                "documentation retains false absolute security claim: "
                f"{false_security_claim}"
            )
    persistent_recovery_phrases = (
        "recovery persists",
        "persistent recovery",
        "persists across app restart",
        "persists across restart",
        "recovery is available after app restart",
        "recovery is available after restart",
        "recovery remains available after restart",
        "recovery remains available after app restart",
        "rediscover recovery automatically",
    )
    for phrase in persistent_recovery_phrases:
        if contains_positive_claim(active_docs, phrase):
            fail(
                "documentation must not claim uninstall recovery persists across app restart: "
                f"{phrase}"
            )

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
