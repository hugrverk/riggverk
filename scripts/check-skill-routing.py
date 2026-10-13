#!/usr/bin/env python3
"""Validate bundled skill catalog and routing source alignment."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WS_ROOT = REPO_ROOT / "resources/default-workspace"
SKILLS_ROOT = WS_ROOT / "skills"
ADAPTER_ROOT = WS_ROOT / "templates/skills"
ADAPTER_MANIFEST = WS_ROOT / "metadata/skill-adapters.json"
AGENTS_METADATA = WS_ROOT / "metadata/agents.json"
AGENT_ADAPTERS_MANIFEST = WS_ROOT / "metadata/agent-adapters.json"
CLAUDE_AGENT_HEADERS = WS_ROOT / "templates/claude/agents"
EXPECTED_COUNT = 23

EXPECTED_SKILLS = {
    "accessibility-review",
    "browser-qa",
    "context-budget",
    "current-docs",
    "database-migrations",
    "diagnose",
    "frontend-design",
    "handoff",
    "implementation-plan",
    "kretsverket-editor-change",
    "kretsverket-electrical-drawing",
    "kretsverket-file-compatibility",
    "kretsverket-symbol-system",
    "kretsverket-status-report",
    "minimal-implementation",
    "prototype",
    "release-check",
    "retro",
    "screenshot-review",
    "security-review",
    "tdd",
    "wordpress-woocommerce",
    "zoom-out",
}

ALL_HARNESSES = {"codex", "opencode", "claude", "cursor"}

# Description standard (docs/SKILLS.md): one plain line, triggers visible to harnesses
# that never see the body, at most 300 chars. The whole catalog stays under the smallest
# documented harness catalog budget (Codex fallback, 8,000 chars).
DESCRIPTION_MAX_CHARS = 300
CATALOG_DESCRIPTION_BUDGET = 8000
DESCRIPTION_TRIGGER = "Use when"
DONE_WHEN_RE = re.compile(r"^Done when: \S", re.MULTILINE)
BLOCK_SCALAR_RE = re.compile(r"^[>|][+-]?\d*$")
PLAIN_SCALAR_BAD_START = "\"'[]{}>|*&!%@`#"

REMOVED_SKILLS = {
    "agent-report-review",
    "caveman",
    "dependency-evaluation",
    "grill-me",
    "grill-with-docs",
    "improve-codebase-architecture",
    "nextjs-product-slice",
    "supabase-rls-review",
    "to-prd",
    "triage",
    "woocommerce-pdp-review",
    "write-a-skill",
}

STATIC_ROUTING_SOURCES = [
    WS_ROOT / "docs/SKILLS.md",
    WS_ROOT / "templates/global-agent-rules.md",
    WS_ROOT / "templates/cursor/user-rules.md",
    REPO_ROOT / "src/lib/brainSetup.ts",
    AGENTS_METADATA,
]

# Files whose routing bullets must never name a user-invoked skill: harnesses that
# ignore disable-model-invocation (Codex, OpenCode) would otherwise route to it.
RULES_DIRS = [WS_ROOT / "templates/rules", WS_ROOT / "templates/sync"]
RULES_STATIC = [WS_ROOT / "templates/global-agent-rules.md", WS_ROOT / "templates/cursor/user-rules.md"]

ACTIVE_DOC_SOURCES = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "docs/WORKSPACE_CONTRACT.md",
    REPO_ROOT / "docs/SECURITY_MODEL.md",
    WS_ROOT / "README.md",
    WS_ROOT / "docs/SKILLS.md",
    WS_ROOT / "docs/CONCEPTS.md",
    WS_ROOT / "docs/USING_THE_APP.md",
    WS_ROOT / "docs/OPENCODE_CONFIG.md",
    WS_ROOT / "docs/CODEX_CONFIG.md",
]

MIGRATION_FIXTURE_ALLOWLIST = {
    REPO_ROOT / "src/lib/brainSetup.test.ts",
    REPO_ROOT / "scripts/check-skill-routing.py",
    REPO_ROOT / "src-tauri/src/managed_reconciliation_contract.rs",
    REPO_ROOT / "src-tauri/src/managed_bootstrap.rs",
    REPO_ROOT / "src-tauri/src/commands/default_workspace_manifest.rs",
    REPO_ROOT / "src-tauri/src/commands/workspace.rs",
    REPO_ROOT / "src-tauri/src/commands/setup.rs",
    WS_ROOT / "metadata/pre-manifest-ownership.json",
    WS_ROOT / "metadata/shipped-digests.json",
}

DEPRECATED_METADATA_PREFIX = "resources/default-workspace/metadata/deprecated-skills"

FRONTMATTER_RE = re.compile(r"^---\s*$([\s\S]*?)^---\s*$", re.MULTILINE)
FIELD_RE = re.compile(r"^([a-zA-Z0-9_-]+):\s*(.+?)\s*$")
BACKTICK_NAME_RE = re.compile(r"`([a-z][a-z0-9-]*)`")


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def parse_fields(frontmatter: str) -> dict[str, str]:
    """Parse top-level `key: value` lines; indented continuation lines are ignored."""
    fields: dict[str, str] = {}
    for line in frontmatter.splitlines():
        if line[:1] in (" ", "\t"):
            continue
        field = FIELD_RE.match(line.strip())
        if field:
            fields[field.group(1)] = field.group(2)
    return fields


def parse_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.search(text)
    if not match:
        fail(f"{path}: missing YAML frontmatter")
    return parse_fields(match.group(1))


def split_list(raw: str) -> list[str]:
    value = raw.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return [item.strip().strip('"').strip("'") for item in value.split(",") if item.strip()]


def discover_skills() -> dict[str, Path]:
    if not SKILLS_ROOT.is_dir():
        fail(f"skills root not found: {SKILLS_ROOT}")

    discovered: dict[str, Path] = {}
    for entry in sorted(SKILLS_ROOT.iterdir()):
        if not entry.is_dir():
            continue
        root_md = entry / "SKILL.md"
        if root_md.is_file():
            # Reject nested SKILL.md under a flat root skill
            for sub in sorted(entry.iterdir()):
                if sub.is_dir() and (sub / "SKILL.md").is_file():
                    fail(f"unsupported deep skill nesting: {(sub / 'SKILL.md')}")
            meta = parse_frontmatter(root_md)
            name = meta.get("name") or entry.name
            if name in discovered:
                fail(f"duplicate skill name: {name}")
            discovered[name] = root_md
            continue
        for sub in sorted(entry.iterdir()):
            if not sub.is_dir():
                continue
            grouped_md = sub / "SKILL.md"
            if grouped_md.is_file():
                meta = parse_frontmatter(grouped_md)
                name = meta.get("name") or sub.name
                if name in discovered:
                    fail(f"duplicate skill name: {name}")
                discovered[name] = grouped_md
                continue
            for deep in sub.rglob("SKILL.md"):
                fail(f"unsupported deep skill nesting: {deep}")

    return discovered


def validate_skill_metadata(discovered: dict[str, Path]) -> None:
    for name, path in discovered.items():
        meta = parse_frontmatter(path)
        if not meta.get("name"):
            fail(f"{path}: missing name frontmatter")
        if not meta.get("description"):
            fail(f"{path}: missing description frontmatter")
        if meta.get("name") != name:
            fail(f"{path}: frontmatter name {meta.get('name')!r} != discovered {name!r}")
        targets_raw = meta.get("targets", "")
        targets = {t.strip() for t in targets_raw.split(",") if t.strip()}
        if targets != ALL_HARNESSES:
            missing = ALL_HARNESSES - targets
            extra = targets - ALL_HARNESSES
            msg_parts = []
            if missing:
                msg_parts.append(f"missing targets: {sorted(missing)}")
            if extra:
                msg_parts.append(f"unknown targets: {sorted(extra)}")
            fail(f"{path}: {name} targets must be exactly {sorted(ALL_HARNESSES)}; {'; '.join(msg_parts)}")
        invoke = meta.get("disable-model-invocation")
        if invoke is not None and invoke != "true":
            fail(f"{rel(path)}: disable-model-invocation must be 'true' when present, found {invoke!r}")


def validate_related(discovered: dict[str, Path]) -> None:
    """Every `related:` name must be a real skill other than the skill itself."""
    for name, path in discovered.items():
        for related in split_list(parse_frontmatter(path).get("related", "")):
            if related == name:
                fail(f"{rel(path)}: {name} lists itself in related")
            if related not in discovered:
                fail(f"{rel(path)}: related skill {related!r} does not exist")


def validate_descriptions(discovered: dict[str, Path]) -> None:
    """Lint the description standard documented in docs/SKILLS.md."""
    total = 0
    for name, path in discovered.items():
        description = parse_frontmatter(path).get("description", "")
        if BLOCK_SCALAR_RE.match(description):
            fail(f"{rel(path)}: description must be one plain line, not a block scalar ({description!r})")
        if len(description) > DESCRIPTION_MAX_CHARS:
            fail(f"{rel(path)}: description is {len(description)} chars (max {DESCRIPTION_MAX_CHARS})")
        if DESCRIPTION_TRIGGER not in description:
            fail(f"{rel(path)}: description must contain {DESCRIPTION_TRIGGER!r} so every harness sees the triggers")
        if ": " in description or " #" in description or description.endswith(":") or description[:1] in PLAIN_SCALAR_BAD_START:
            fail(f"{rel(path)}: description is not a safe plain YAML scalar (avoid ': ', ' #', and leading quote or indicator characters)")
        if not DONE_WHEN_RE.search(path.read_text(encoding="utf-8")):
            fail(f"{rel(path)}: missing a one-line 'Done when: ...' exit criterion")
        total += len(description)
    if total > CATALOG_DESCRIPTION_BUDGET:
        fail(f"skill descriptions total {total} chars (budget {CATALOG_DESCRIPTION_BUDGET})")


def user_invoked_skills(discovered: dict[str, Path]) -> set[str]:
    return {name for name, path in discovered.items() if parse_frontmatter(path).get("disable-model-invocation") == "true"}


def rules_files() -> list[Path]:
    files = list(RULES_STATIC)
    for directory in RULES_DIRS:
        if not directory.is_dir():
            fail(f"rules directory missing: {directory}")
        files.extend(sorted(directory.glob("*.md")))
    return files


def validate_user_invoked_routing(discovered: dict[str, Path]) -> None:
    """Rules must not route to skills the model is not allowed to invoke."""
    user_invoked = user_invoked_skills(discovered)
    if not user_invoked:
        return
    for source in rules_files():
        if not source.is_file():
            fail(f"routing source missing: {source}")
        for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.lstrip().startswith("- "):
                continue
            for token in BACKTICK_NAME_RE.findall(line):
                if token in user_invoked:
                    fail(f"{rel(source)}:{number}: routing bullet names user-invoked skill `{token}` (disable-model-invocation)")


def parse_claude_header(path: Path) -> dict[str, str]:
    return parse_fields(path.read_text(encoding="utf-8"))


def validate_agent_metadata(discovered: dict[str, Path]) -> None:
    """agents.json must agree with the Claude agent headers and the adapter manifest."""
    metadata = json.loads(AGENTS_METADATA.read_text(encoding="utf-8")).get("agents", {})
    adapters = json.loads(AGENT_ADAPTERS_MANIFEST.read_text(encoding="utf-8")).get("roles", {})
    for filename, entry in metadata.items():
        role = filename.removesuffix(".md")
        default_skills = entry.get("default_skills", [])
        for skill in default_skills:
            if skill not in discovered:
                fail(f"{rel(AGENTS_METADATA)}: {role} default_skills names unknown skill {skill!r}")
        header = CLAUDE_AGENT_HEADERS / f"{role}.header.yaml"
        if header.is_file():
            header_skills = split_list(parse_claude_header(header).get("skills", ""))
            if sorted(header_skills) != sorted(default_skills):
                fail(
                    f"{rel(AGENTS_METADATA)}: {role} default_skills {sorted(default_skills)} "
                    f"differ from Claude header skills {sorted(header_skills)} ({rel(header)})"
                )
        harnesses = set(adapters.get(role, {}).get("harnesses", {}))
        if harnesses and set(entry.get("targets", [])) != harnesses:
            fail(
                f"{rel(AGENTS_METADATA)}: {role} targets {sorted(entry.get('targets', []))} "
                f"differ from {rel(AGENT_ADAPTERS_MANIFEST)} harnesses {sorted(harnesses)}"
            )


def validate_skill_adapters(discovered: dict[str, Path]) -> None:
    if not ADAPTER_MANIFEST.is_file():
        fail(f"adapter manifest missing: {ADAPTER_MANIFEST}")
    try:
        manifest = json.loads(ADAPTER_MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{ADAPTER_MANIFEST}: invalid JSON: {exc}")
    if manifest.get("version") != 1:
        fail(f"{ADAPTER_MANIFEST}: unsupported version")
    if set(manifest.get("targets", [])) != ALL_HARNESSES:
        fail(f"{ADAPTER_MANIFEST}: targets must be exactly {sorted(ALL_HARNESSES)}")
    manifest_skills = manifest.get("skills")
    if not isinstance(manifest_skills, dict):
        fail(f"{ADAPTER_MANIFEST}: missing skills object")
    if set(manifest_skills) != set(discovered):
        missing = set(discovered) - set(manifest_skills)
        extra = set(manifest_skills) - set(discovered)
        if missing:
            fail(f"{ADAPTER_MANIFEST}: missing skills: {sorted(missing)}")
        if extra:
            fail(f"{ADAPTER_MANIFEST}: unknown skills: {sorted(extra)}")

    for skill, canonical_path in discovered.items():
        entry = manifest_skills[skill]
        if entry.get("canonical") != canonical_path.relative_to(WS_ROOT).as_posix():
            fail(f"{ADAPTER_MANIFEST}: {skill} canonical path mismatch")
        if set(entry.get("targets", [])) != ALL_HARNESSES:
            fail(f"{ADAPTER_MANIFEST}: {skill} targets must be exactly {sorted(ALL_HARNESSES)}")
        outputs = entry.get("outputs")
        if not isinstance(outputs, dict) or set(outputs) != ALL_HARNESSES:
            fail(f"{ADAPTER_MANIFEST}: {skill} outputs must cover {sorted(ALL_HARNESSES)}")
        for harness in ALL_HARNESSES:
            expected = ADAPTER_ROOT / harness / skill / "SKILL.md"
            if not expected.is_file():
                fail(f"generated {harness} adapter missing for {skill}: {expected}")
            rel_expected = expected.relative_to(WS_ROOT).as_posix()
            if outputs.get(harness) != rel_expected:
                fail(f"{ADAPTER_MANIFEST}: {skill} {harness} output path mismatch")

    result = subprocess.run(
        [sys.executable, "scripts/generate-skill-adapters.py", "--check"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        output = (result.stdout + result.stderr).strip()
        fail(f"generated skill adapters are stale:\n{output[:4000]}")


STALE_CLAIMS = [
    # Count claims
    ("28 bundled skill", "stale skill count 28"),
    ("24 generic skill", "stale generic skill count"),
    # Layout claims
    ("flat-only", "stale flat-only source layout claim"),
    ("root-level layout only", "stale flat-only source layout claim"),
    # Profile claims
    ("target profile preset", "stale target profile preset claim"),
    ("Manual target selection", "stale manual target selection claim"),
    # Config path claims (outside migration docs)
    ("~/.agents/skills", "stale old Codex skills path (~/.agents/skills -> ~/.codex/skills)"),
    # Skill selection claims
    ("auto-selected skills", "stale auto-selected skills claim"),
    ("per-workspace skill selection", "stale per-workspace skill selection claim"),
    # Rollback claims
    ("restore manually by copying", "stale manual rollback instruction claim"),
]

STALE_CLAIMS_ALLOWLIST = {
    "resources/default-workspace/templates/cursor/README.md": {
        "starter skills",  # Cursor cursor/README correctly describes agents AND skills as separate surfaces
    },
    "resources/default-workspace/templates/cursor/global-profile.json": {
        "starter skills",  # Cursor profile describes skills surface, not the adapter agents
    },
    "resources/default-workspace/docs/CODEX_CONFIG.md": {
        "~/.agents/skills",  # Documents previous app location alongside current $CODEX_HOME/skills
    },
    "resources/default-workspace/README.md": {
        "starter skills",  # Describes Cursor setup with separate agents and skills surfaces
    },
    "README.md": {
        "~/.agents/skills",  # Documents previous app location alongside current $CODEX_HOME/skills
    },
}


def validate_active_docs() -> None:
    for source in ACTIVE_DOC_SOURCES:
        if not source.is_file():
            continue
        text = source.read_text(encoding="utf-8")
        source_rel = rel(source)
        allowlisted = STALE_CLAIMS_ALLOWLIST.get(source_rel, set())
        for pattern, msg in STALE_CLAIMS:
            if pattern in text and pattern not in allowlisted:
                fail(f"{source_rel}: {msg}: found '{pattern}'")


def routing_sources() -> list[Path]:
    sources = list(STATIC_ROUTING_SOURCES)
    for directory in RULES_DIRS:
        if not directory.is_dir():
            fail(f"rules directory missing: {directory}")
        sources.extend(sorted(directory.glob("*.md")))
    return sources


def validate_routing_sources(discovered: set[str]) -> None:
    for source in routing_sources():
        if not source.is_file():
            fail(f"routing source missing: {source}")
        text = source.read_text(encoding="utf-8")
        if "28 skill" in text.lower():
            fail(f"{source}: stale skill count 28")
        if "flat-only" in text.lower() or "root-level layout only" in text.lower():
            fail(f"{source}: stale flat-only source layout claim")
        for removed in REMOVED_SKILLS:
            if removed in text:
                fail(f"{source}: references removed skill {removed}")
        if source.name == "SKILLS.md":
            if f"{EXPECTED_COUNT} skill" not in text:
                fail(f"{source}: missing exact count of {EXPECTED_COUNT} skills")
            for skill in discovered:
                if f"`{skill}`" not in text:
                    fail(f"{source}: bundled skill missing from catalog: {skill}")


SCANNED_SUFFIXES = {".md", ".mdc", ".ts", ".tsx", ".json", ".py", ".sh", ".rs", ".toml", ".yaml", ".yml"}


def scan_repo_for_removed_skills() -> None:
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path in MIGRATION_FIXTURE_ALLOWLIST:
            continue
        if {"node_modules", "target", ".git", ".claude"} & set(path.parts):
            continue
        if path.suffix not in SCANNED_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel_posix = rel(path)
        for removed in REMOVED_SKILLS:
            # Allow removed names only in:
            # 1. Deprecated metadata files
            if rel_posix == "resources/default-workspace/metadata/deprecated-skills.json":
                continue
            if rel_posix.startswith(f"{DEPRECATED_METADATA_PREFIX}/"):
                continue
            # 2. This checker script itself (documents the set)
            if rel_posix == "scripts/check-skill-routing.py":
                continue
            if removed in text:
                fail(f"{rel_posix}: references removed skill {removed} outside migration fixtures")


def main() -> None:
    discovered_map = discover_skills()
    discovered = set(discovered_map.keys())

    if len(discovered) != EXPECTED_COUNT:
        fail(f"expected {EXPECTED_COUNT} skills, found {len(discovered)}")

    if discovered != EXPECTED_SKILLS:
        missing = EXPECTED_SKILLS - discovered
        extra = discovered - EXPECTED_SKILLS
        if missing:
            fail(f"missing expected skills: {sorted(missing)}")
        if extra:
            fail(f"unexpected extra skills: {sorted(extra)}")

    validate_skill_metadata(discovered_map)
    validate_related(discovered_map)
    validate_descriptions(discovered_map)
    validate_skill_adapters(discovered_map)
    validate_routing_sources(discovered)
    validate_user_invoked_routing(discovered_map)
    validate_agent_metadata(discovered_map)
    validate_active_docs()
    scan_repo_for_removed_skills()

    print(f"PASS: {EXPECTED_COUNT} bundled skills and routing sources aligned")


if __name__ == "__main__":
    main()
