#!/usr/bin/env python3
"""Guard README copies against known stale migration and settings drift."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_README = ROOT / "README.md"
WORKSPACE_README = ROOT / "resources/default-workspace/README.md"
SETTINGS_DEFAULTS = ROOT / "src/lib/settingsDraft.ts"
HARNESS_INSTALLATION = ROOT / "src" / "lib" / "harnessInstallation.ts"

README_PATHS = (APP_README, WORKSPACE_README)

COUNT_CLAIM = re.compile(
    r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
    r"[ \t-]+(?:(?:bundled|canonical|semantic|central|native|global|Markdown|TOML|read-only|starter|generic)\s+)*"
    r"(?:skills?|agents?|subagents?|harnesses)\b(?!\.md\b)",
    re.IGNORECASE,
)
# Fixed behavior examples, rather than sizes of shipped collections. Exempt only the phrase,
# never the rest of its line, so an example cannot hide an unrelated stale catalog count.
COUNT_ALLOWLIST = {
    "docs/WORKSPACE_CONTRACT.md": ("one skill in one folder",),
    "resources/default-workspace/docs/SKILLS.md": (
        "two-agent implementation",
        "two harnesses both read",
        "one skill is not listed twice",
        "one skills folder",
    ),
}


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def read(path: Path) -> str:
    if not path.is_file():
        fail(f"missing file: {path}")
    return path.read_text(encoding="utf-8")


def count_claims(path: str, text: str) -> list[str]:
    errors = []
    for number, line in enumerate(text.splitlines(), 1):
        line = line.replace("**", "").replace("__", "")
        for allowed in COUNT_ALLOWLIST.get(path, ()):
            line = line.replace(allowed, "")
        for match in COUNT_CLAIM.finditer(line):
            errors.append(f"{path}:{number}: hard-coded collection count: {match.group(0)}")
    return errors


def validate_agent_lists(contract: str) -> None:
    workspace = ROOT / "resources/default-workspace"
    agents = json.loads(read(workspace / "metadata/agents.json"))["agents"]
    adapters = json.loads(read(workspace / "metadata/agent-adapters.json"))["roles"]
    cursor = json.loads(read(workspace / "templates/cursor/manifest.json"))
    expected = {"Cursor": {Path(name).stem for name in cursor["agents"]}}
    for label, harness in (("OpenCode", "opencode"), ("Claude Code", "claude"), ("Codex", "codex")):
        roles = {Path(name).stem for name, entry in agents.items() if harness in entry["targets"]}
        adapter_roles = {name for name, entry in adapters.items() if harness in entry["harnesses"]}
        if roles != adapter_roles:
            fail(f"{label}: agents.json and agent-adapters.json roles differ")
        expected[label] = {Path(adapters[name]["harnesses"][harness]["output"]).stem for name in roles}

    section = re.search(r"^## Agents\n(.*?)(?=^## |\Z)", contract, re.MULTILINE | re.DOTALL)
    if not section:
        fail("WORKSPACE_CONTRACT.md missing Agents section")
    rows = re.findall(r"^- (OpenCode|Claude Code|Codex|Cursor): (`.+)$", section.group(1), re.MULTILINE)
    documented = {label: set(re.findall(r"`([^`]+)`", names)) for label, names in rows}
    if len(rows) != len(documented) or documented != expected:
        fail("WORKSPACE_CONTRACT.md Agents lists must match agent metadata and Cursor manifest")

    rules = read(workspace / "docs/AGENT_RULES.md")
    section = re.search(r"^### Cursor\n(.*?)(?=^#{1,3} |\Z)", rules, re.MULTILINE | re.DOTALL)
    names = set(re.findall(r"^- ([a-z][a-z0-9-]*)$", section.group(1), re.MULTILINE)) if section else set()
    if names != expected["Cursor"]:
        fail("AGENT_RULES.md Cursor list must match Cursor manifest")


def validate_maintaining_guide() -> None:
    """docs/MAINTAINING.md names the one generate command and every generator it runs."""
    guide = read(ROOT / "docs/MAINTAINING.md")
    if "python3 scripts/generate.py write" not in guide:
        fail("docs/MAINTAINING.md must give the generate command: python3 scripts/generate.py write")
    names = re.findall(r'Generator\(\s*"([^"]+)"', read(ROOT / "scripts/generate.py"))
    if not names:
        fail("scripts/generate.py registry not found")
    for name in names:
        if f"`{name}`" not in guide:
            fail(f"docs/MAINTAINING.md must describe the generate.py registry entry `{name}`")
    for path in (ROOT / "README.md", ROOT / "docs/RELEASE.md"):
        if "MAINTAINING.md" not in read(path):
            fail(f"{path.relative_to(ROOT)} must link docs/MAINTAINING.md")


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

    for path in (
        *README_PATHS,
        ROOT / "docs/WORKSPACE_CONTRACT.md",
        ROOT / "docs/SECURITY_MODEL.md",
        ROOT / "docs/APP_RELEASE_SMOKE.md",
        ROOT / "docs/MAINTAINING.md",
        *sorted((ROOT / "resources/default-workspace/docs").glob("*.md")),
        ROOT / "resources/default-workspace/templates/cursor/README.md",
    ):
        if errors := count_claims(path.relative_to(ROOT).as_posix(), read(path)):
            fail(errors[0])

    app_text = read(APP_README)
    settings_text = read(SETTINGS_DEFAULTS)

    if "export const DEFAULT_TARGET_IDS: string[] = [...DEFAULT_ENABLED_TARGET_IDS];" not in settings_text:
        fail("settingsDraft.ts DEFAULT_TARGET_IDS must derive from DEFAULT_ENABLED_TARGET_IDS")
    disabled_match = re.search(
        r"const DEFAULT_DISABLED_TARGET_IDS: readonly SetupTargetId\[\] = (\[[^\]]*\]);",
        read(HARNESS_INSTALLATION),
    )
    if not disabled_match:
        fail("harnessInstallation.ts missing DEFAULT_DISABLED_TARGET_IDS")
    if '"codex_config"' not in disabled_match.group(1):
        fail("codex_config must be disabled by default (DEFAULT_DISABLED_TARGET_IDS)")

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

    if "Tool switching lives in the left sidebar" in app_text:
        fail("README.md must not describe obsolete tool sidebar switching")

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
            fail(f"{rel} must not reference ux-context")

    validate_maintaining_guide()

    contract = read(ROOT / "docs/WORKSPACE_CONTRACT.md")
    validate_agent_lists(contract)
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
    if "Motion `full`" not in release_smoke and "reduce motion" not in release_smoke.lower():
        fail("APP_RELEASE_SMOKE.md must include the motion levels smoke")
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
