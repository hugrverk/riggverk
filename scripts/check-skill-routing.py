#!/usr/bin/env python3
"""Validate bundled skill catalog and routing source alignment."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_ROOT = REPO_ROOT / "resources/default-workspace/skills"
EXPECTED_COUNT = 21

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
    "minimal-implementation",
    "prototype",
    "release-check",
    "screenshot-review",
    "security-review",
    "tdd",
    "wordpress-woocommerce",
    "zoom-out",
}

ALL_HARNESSES = {"codex", "opencode", "claude", "cursor"}

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

ROUTING_SOURCES = [
    REPO_ROOT / "resources/default-workspace/docs/SKILLS.md",
    REPO_ROOT / "resources/default-workspace/templates/global-agent-rules.md",
    REPO_ROOT / "resources/default-workspace/templates/cursor/user-rules.md",
    REPO_ROOT / "src/lib/brainSetup.ts",
    REPO_ROOT / "resources/default-workspace/metadata/agents.json",
]

ACTIVE_DOC_SOURCES = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "docs/WORKSPACE_CONTRACT.md",
    REPO_ROOT / "docs/SECURITY_MODEL.md",
    REPO_ROOT / "resources/default-workspace/README.md",
    REPO_ROOT / "resources/default-workspace/docs/SKILLS.md",
    REPO_ROOT / "resources/default-workspace/docs/CONCEPTS.md",
    REPO_ROOT / "resources/default-workspace/docs/USING_THE_APP.md",
    REPO_ROOT / "resources/default-workspace/docs/OPENCODE_CONFIG.md",
    REPO_ROOT / "resources/default-workspace/docs/CODEX_CONFIG.md",
]

MIGRATION_FIXTURE_ALLOWLIST = {
    REPO_ROOT / "src/lib/brainSetup.test.ts",
    REPO_ROOT / "scripts/check-skill-routing.py",
    REPO_ROOT / "src-tauri/src/deprecated_skills.rs",
    REPO_ROOT / "src-tauri/src/commands/default_workspace_manifest.rs",
    REPO_ROOT / "src-tauri/src/commands/workspace.rs",
}

DEPRECATED_METADATA_PREFIX = "resources/default-workspace/metadata/deprecated-skills"

FRONTMATTER_RE = re.compile(r"^---\s*$([\s\S]*?)^---\s*$", re.MULTILINE)
FIELD_RE = re.compile(r"^([a-zA-Z0-9_-]+):\s*(.+?)\s*$")


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def parse_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.search(text)
    if not match:
        fail(f"{path}: missing YAML frontmatter")
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        field = FIELD_RE.match(line.strip())
        if field:
            fields[field.group(1)] = field.group(2)
    return fields


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


def extract_skill_tokens(text: str) -> set[str]:
    tokens: set[str] = set()
    for match in re.finditer(r"`([a-z][a-z0-9-]*)`", text):
        tokens.add(match.group(1))
    for match in re.finditer(r"([a-z][a-z0-9-]*):", text):
        tokens.add(match.group(1))
    return tokens


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
    ("~/.codex/skills", "stale old Codex skills path (~/.codex/skills -> ~/.agents/skills)"),
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
        "~/.codex/skills",  # Documents legacy migration path alongside current ~/.agents/skills
    },
    "resources/default-workspace/README.md": {
        "starter skills",  # Describes Cursor setup with separate agents and skills surfaces
    },
}

def validate_active_docs() -> None:
    for source in ACTIVE_DOC_SOURCES:
        if not source.is_file():
            continue
        text = source.read_text(encoding="utf-8")
        rel = source.relative_to(REPO_ROOT).as_posix()
        allowlisted = STALE_CLAIMS_ALLOWLIST.get(rel, set())
        for pattern, msg in STALE_CLAIMS:
            if pattern in text and pattern not in allowlisted:
                fail(f"{rel}: {msg}: found '{pattern}'")

def validate_routing_sources(discovered: set[str]) -> None:
    for source in ROUTING_SOURCES:
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
        if source.name == "agents.json":
            for skill in discovered:
                if f'"{skill}"' not in text and skill not in ("kretsverket-editor-change", "kretsverket-electrical-drawing", "kretsverket-file-compatibility", "kretsverket-symbol-system"):
                    # agents.json only lists default_skills subsets, not full catalog
                    continue
        if source.name == "SKILLS.md":
            if "21 skill" not in text and "21 skills" not in text:
                fail(f"{source}: missing exact count of 21 skills")
            for skill in discovered:
                if f"`{skill}`" not in text:
                    fail(f"{source}: bundled skill missing from catalog: {skill}")


def scan_repo_for_removed_skills() -> None:
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path in MIGRATION_FIXTURE_ALLOWLIST:
            continue
        if "node_modules" in path.parts or "target" in path.parts or ".git" in path.parts:
            continue
        if path.suffix not in {".md", ".ts", ".tsx", ".json", ".py", ".sh", ".rs"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel_posix = path.relative_to(REPO_ROOT).as_posix()
        for removed in REMOVED_SKILLS:
            if removed in text and rel_posix.startswith("resources/default-workspace/skills/"):
                continue
            if removed in text and (
                rel_posix == "resources/default-workspace/metadata/deprecated-skills.json"
                or rel_posix.startswith(f"{DEPRECATED_METADATA_PREFIX}/")
            ):
                continue
            if removed in text:
                rel = path.relative_to(REPO_ROOT)
                fail(f"{rel}: references removed skill {removed} outside migration fixtures")


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
    validate_routing_sources(discovered)
    validate_active_docs()
    scan_repo_for_removed_skills()

    print(f"PASS: {EXPECTED_COUNT} bundled skills and routing sources aligned")


if __name__ == "__main__":
    main()
