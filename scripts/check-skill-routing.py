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
# Per-harness skill adapters are retired: every harness installs the canonical SKILL.md.
RETIRED_ADAPTER_PATHS = (
    WS_ROOT / "templates/skills",
    WS_ROOT / "metadata/skill-adapters.json",
)
AGENTS_METADATA = WS_ROOT / "metadata/agents.json"
AGENT_ADAPTERS_MANIFEST = WS_ROOT / "metadata/agent-adapters.json"
CLAUDE_AGENT_HEADERS = WS_ROOT / "templates/claude/agents"

ALL_HARNESSES = {"codex", "opencode", "claude", "cursor"}

# Harness-specific text lives in the canonical SKILL.md under `## Harness notes`, one `###`
# subsection per harness in this fixed order. Every harness installs the same bytes.
HARNESS_NOTES_HEADING = "## Harness notes"
HARNESS_NOTES_SECTIONS = ("Claude Code", "Codex", "OpenCode", "Cursor")
CLAUDE_NOTES_HEADING = "### Claude Code"
# Frontmatter keys only Claude Code acts on; Codex and OpenCode ignore them.
CLAUDE_ONLY_KEYS = ("context", "agent", "background", "allowed-tools")
# Claude Code runs !`command` (and a fence opened with ```!) when a skill loads; any other
# harness shows the text literally, so it may only appear in the Claude Code notes.
INJECTION_RE = re.compile(r"!`|^\s*(?:`{3,}|~{3,})!", re.MULTILINE)
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^#{1,6}\s")

# Description standard (docs/SKILLS.md): one plain line, triggers visible to harnesses
# that never see the body, at most 300 chars. The whole catalog stays under the smallest
# documented harness catalog budget (Codex fallback, 8,000 chars).
DESCRIPTION_MAX_CHARS = 300
CATALOG_DESCRIPTION_BUDGET = 8000
DESCRIPTION_TRIGGER = "Use when"
DONE_WHEN_RE = re.compile(r"^Done when: \S", re.MULTILINE)
BLOCK_SCALAR_RE = re.compile(r"^[>|][+-]?\d*$")
PLAIN_SCALAR_BAD_START = "\"'[]{}>|*&!%@`#"

STATIC_ROUTING_SOURCES = [
    WS_ROOT / "docs/SKILLS.md",
    WS_ROOT / "templates/global-agent-rules.md",
    WS_ROOT / "templates/cursor/user-rules.md",
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
    WS_ROOT / "docs/WORKFLOWS.md",
    WS_ROOT / "docs/TROUBLESHOOTING.md",
    WS_ROOT / "templates/cursor/README.md",
]

MIGRATION_FIXTURE_ALLOWLIST = {
    REPO_ROOT / "scripts/check-skill-routing.py",
    REPO_ROOT / "src-tauri/src/managed_reconciliation_contract.rs",
    REPO_ROOT / "src-tauri/src/managed_bootstrap.rs",
    REPO_ROOT / "src-tauri/src/commands/workspace.rs",
    REPO_ROOT / "src-tauri/src/commands/setup.rs",
    WS_ROOT / "metadata/pre-manifest-ownership.json",
    WS_ROOT / "metadata/shipped-digests.json",
    # Vendored upstream text (cloudflare/security-audit-skill) uses "triage" in its plain sense.
    WS_ROOT / "skills/security-audit/SKILL.md",
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


def removed_skill_names() -> set[str]:
    source = REPO_ROOT / "src-tauri/src/managed_bootstrap.rs"
    match = re.search(
        r"pub const REMOVED_SKILL_NAMES:\s*&\[&str\]\s*=\s*&\[([^\]]*)\];",
        source.read_text(encoding="utf-8"),
        re.DOTALL,
    )
    if not match:
        fail(f"{rel(source)}: missing REMOVED_SKILL_NAMES declaration")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


REMOVED_SKILLS = removed_skill_names()


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


def read_skill_text(path: Path) -> str:
    """Read a canonical SKILL.md, refusing a BOM or CR line endings.

    Every harness installs the file byte for byte, and shipped digests are over those bytes, so a
    checkout that rewrites line endings would change what users get.
    """
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        fail(f"{rel(path)}: remove the UTF-8 BOM")
    if b"\r" in raw:
        fail(f"{rel(path)}: use LF line endings (found CR)")
    return raw.decode("utf-8")


def parse_frontmatter(path: Path) -> dict[str, str]:
    text = read_skill_text(path)
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


# Skills that start only when the user asks for them in plain words or by slash command.
# The model may invoke them, so disable-model-invocation does not mark them; the rules
# must still never route to them, since each run spends several agents.
ON_REQUEST_PREFIX = "adversarial-"


def validate_user_invoked_routing(discovered: dict[str, Path]) -> None:
    """Rules must not route to skills the model is not allowed to invoke, or to on-request skills."""
    user_invoked = user_invoked_skills(discovered)
    on_request = {name for name in discovered if name.startswith(ON_REQUEST_PREFIX)}
    if not user_invoked and not on_request:
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
                elif token in on_request:
                    fail(f"{rel(source)}:{number}: routing bullet names on-request skill `{token}` ({ON_REQUEST_PREFIX}*)")


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


def frontmatter_keys(frontmatter: str) -> list[str]:
    """Top-level frontmatter keys in file order, duplicates kept."""
    keys: list[str] = []
    for line in frontmatter.splitlines():
        if line[:1] in (" ", "\t"):
            continue
        field = FIELD_RE.match(line.strip())
        if field:
            keys.append(field.group(1))
    return keys


def split_frontmatter(path: Path, text: str) -> tuple[str, list[str]]:
    """Return the frontmatter text and the body lines; the delimiters must be plain `---` lines."""
    lines = text.split("\n")
    if lines[0] != "---":
        fail(f"{rel(path)}: frontmatter must open with a plain '---' line")
    for index in range(1, len(lines)):
        if lines[index].rstrip() == "---":
            if lines[index] != "---":
                fail(f"{rel(path)}: frontmatter delimiters must be plain '---' lines")
            return "\n".join(lines[1:index]), lines[index + 1:]
    fail(f"{rel(path)}: frontmatter never closes")
    raise AssertionError("unreachable")


def headings(body: list[str]) -> list[tuple[int, str]]:
    """(line index, heading line) of every Markdown heading outside fenced code blocks."""
    found: list[tuple[int, str]] = []
    fence: str | None = None
    for index, line in enumerate(body):
        marker = FENCE_RE.match(line)
        if marker:
            if fence is None:
                fence = marker.group(1)[0]
            elif marker.group(1)[0] == fence:
                fence = None
            continue
        if fence is None and HEADING_RE.match(line):
            found.append((index, line.rstrip()))
    return found


def validate_harness_notes(path: Path, frontmatter: str, body: list[str]) -> None:
    """Harness-specific text sits in `## Harness notes` as one `###` subsection per harness."""
    outline = headings(body)
    notes = [(i, h) for i, h in outline if h == HARNESS_NOTES_HEADING]
    if len(notes) > 1:
        fail(f"{rel(path)}: more than one '{HARNESS_NOTES_HEADING}' section")
    claude_lines: range = range(0)
    if notes:
        start = notes[0][0]
        if any(h.startswith("## ") and i > start for i, h in outline):
            fail(f"{rel(path)}: '{HARNESS_NOTES_HEADING}' must be the last '##' section")
        subsections = [(i, h) for i, h in outline if i > start and not h.startswith("####")]
        names: list[str] = []
        for _, heading in subsections:
            if not heading.startswith("### "):
                fail(f"{rel(path)}: '{HARNESS_NOTES_HEADING}' allows only '###' harness subsections, found {heading!r}")
            names.append(heading[4:])
        unknown = [name for name in names if name not in HARNESS_NOTES_SECTIONS]
        if unknown or not names:
            fail(f"{rel(path)}: '{HARNESS_NOTES_HEADING}' subsections must be from {list(HARNESS_NOTES_SECTIONS)}, found {names}")
        if names != sorted(set(names), key=HARNESS_NOTES_SECTIONS.index):
            fail(f"{rel(path)}: harness notes must follow the order {list(HARNESS_NOTES_SECTIONS)} without repeats, found {names}")
        if any(line.strip() for line in body[start + 1 : subsections[0][0]]):
            fail(f"{rel(path)}: text between '{HARNESS_NOTES_HEADING}' and its first subsection")
        for position, (index, heading) in enumerate(subsections):
            if heading == CLAUDE_NOTES_HEADING:
                end = subsections[position + 1][0] if position + 1 < len(subsections) else len(body)
                claude_lines = range(index, end)
    has_claude_notes = bool(claude_lines)
    claude_keys = sorted(set(frontmatter_keys(frontmatter)) & set(CLAUDE_ONLY_KEYS))
    if claude_keys and not has_claude_notes:
        fail(f"{rel(path)}: Claude-only frontmatter {claude_keys} needs a '{CLAUDE_NOTES_HEADING}' notes section")
    for index, line in enumerate(body):
        if index not in claude_lines and INJECTION_RE.search(line):
            fail(
                f"{rel(path)}:{index + 1}: Claude injection syntax is only allowed under "
                f"'{HARNESS_NOTES_HEADING}' > '{CLAUDE_NOTES_HEADING}' (other harnesses show it literally)"
            )
    if INJECTION_RE.search(frontmatter):
        fail(f"{rel(path)}: Claude injection syntax is not allowed in the frontmatter")


def validate_canonical_skill_files(discovered: dict[str, Path]) -> None:
    """Every harness installs the canonical SKILL.md byte for byte, so it must be clean as written."""
    for retired in RETIRED_ADAPTER_PATHS:
        if retired.exists():
            fail(f"{rel(retired)} is retired: harnesses install skills/<name>/SKILL.md directly; delete it")
    for name, path in discovered.items():
        for candidate in (path, *path.parents):
            if candidate == SKILLS_ROOT.parent:
                break
            if candidate.is_symlink():
                fail(f"{rel(candidate)}: refusing symlink skill path")
        if not SKILL_NAME_RE.fullmatch(name):
            fail(f"{rel(path)}: invalid skill name {name!r}")
        frontmatter, body = split_frontmatter(path, read_skill_text(path))
        keys = frontmatter_keys(frontmatter)
        duplicated = sorted({key for key in keys if keys.count(key) > 1})
        if duplicated:
            fail(f"{rel(path)}: duplicate frontmatter keys {duplicated}")
        validate_harness_notes(path, frontmatter, body)


# Phrases of the retired model, one skills folder per harness (Codex in $CODEX_HOME/skills, Cursor
# in ~/.cursor/skills, ~/.agents/skills as an "old" Codex location).
STALE_SKILL_FOLDER_CLAIMS = [
    "skills install to `$CODEX_HOME/skills` (typically",
    "Codex: `$CODEX_HOME/skills` (typically",
    "`~/.cursor/skills` (managed skills",
    "OpenCode: `~/.config/opencode/skills`\n- Claude Code",
    "Copies under the old `~/.agents/skills`",
    "migrate; diverged copies stay conflicts",
    "to the bundled OpenCode global skills path",
    "installs to each harness skill root",
    "Skills follow their harness",
]

STALE_CLAIMS = [
    # Layout claims
    ("flat-only", "stale flat-only source layout claim"),
    ("root-level layout only", "stale flat-only source layout claim"),
    # Profile claims
    ("target profile preset", "stale target profile preset claim"),
    ("Manual target selection", "stale manual target selection claim"),
    # Skills folders: skills are one surface installed into the folders the enabled harnesses read
    # (~/.claude/skills, ~/.agents/skills; $CODEX_HOME/skills only with a customised CODEX_HOME).
    *[(claim, "stale skills folder claim (see docs/WORKSPACE_CONTRACT.md, Installed skill layout)") for claim in STALE_SKILL_FOLDER_CLAIMS],
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
    "resources/default-workspace/README.md": {
        "starter skills",  # Describes Cursor setup with separate agents and skills surfaces
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
        if "flat-only" in text.lower() or "root-level layout only" in text.lower():
            fail(f"{source}: stale flat-only source layout claim")
        for claim in STALE_SKILL_FOLDER_CLAIMS:
            if claim in text:
                fail(f"{source}: stale skills folder claim: found '{claim}'")
        if source.name == "codex.md" and "~/.agents/skills" not in text:
            fail(f"{source}: the Codex rules must name ~/.agents/skills as the Codex skills folder")
        for removed in REMOVED_SKILLS:
            if removed in text:
                fail(f"{source}: references removed skill {removed}")
        if source.name == "SKILLS.md":
            rows = re.findall(r"^\|\s*`([a-z][a-z0-9-]*)`\s*\|", text, re.MULTILINE)
            catalog = set(rows)
            if len(rows) != len(catalog):
                fail(f"{source}: duplicate skill catalog rows")
            if missing := discovered - catalog:
                fail(f"{source}: bundled skills missing from catalog: {sorted(missing)}")
            if extra := catalog - discovered:
                fail(f"{source}: catalog rows without bundled skills: {sorted(extra)}")


SCANNED_SUFFIXES = {".md", ".mdc", ".ts", ".tsx", ".json", ".py", ".sh", ".rs", ".toml", ".yaml", ".yml"}


def repo_files() -> list[Path]:
    """Files git would track: tracked plus untracked ones it does not ignore. Outside a git
    checkout (the tests' throwaway trees) every file is scanned."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )
    if listed.returncode != 0:
        return list(REPO_ROOT.rglob("*"))
    return [REPO_ROOT / name for name in listed.stdout.decode("utf-8").split("\0") if name]


def scan_repo_for_removed_skills() -> None:
    for path in repo_files():
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
            # 2. This checker script itself (parses the removed names)
            if rel_posix == "scripts/check-skill-routing.py":
                continue
            if removed in text:
                fail(f"{rel_posix}: references removed skill {removed} outside migration fixtures")


def main() -> None:
    discovered_map = discover_skills()
    discovered = set(discovered_map.keys())

    validate_skill_metadata(discovered_map)
    validate_related(discovered_map)
    validate_descriptions(discovered_map)
    validate_canonical_skill_files(discovered_map)
    validate_routing_sources(discovered)
    validate_user_invoked_routing(discovered_map)
    validate_agent_metadata(discovered_map)
    validate_active_docs()
    scan_repo_for_removed_skills()

    print(f"PASS: {len(discovered)} bundled skills and routing sources aligned")


if __name__ == "__main__":
    main()
