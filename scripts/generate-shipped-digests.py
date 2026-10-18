#!/usr/bin/env python3
"""Bundle the digest of every version of a file-copy artifact the app shipped.

An installed skill or agent file the app copied in an earlier version no longer
matches the digest recorded in managed-state.json when an older app version (or
a legacy script) synced it without recording ownership. Such a file is still
app-owned: its bytes are exactly a version the app shipped. This writes
resources/default-workspace/metadata/shipped-digests.json so the planner can
prove that, without keeping the old versions themselves.

Format: {"schema": 1, "sources": {"<bundle-relative path>": ["sha256:<hex>", ...]}}
Keys are the bundle sources a file-copy artifact resolves to (see
ArtifactId::resolve_source): templates/claude/agents/<name>.md,
templates/cursor/agents/<name>.md, templates/codex/agents/<name>.toml,
agents/<name>.md and templates/playwright-mcp.config.json. Every harness installs the canonical
skill file, so a skill's key is the logical skills/<name>/SKILL.md: the history of the generic skill
(wherever it lived under skills/) plus its metadata/deprecated-skills copy. Until the canonical
file became the install source the app shipped one generated adapter per harness; those versions
stay provable under the legacy keys templates/skills/<harness>/<name>/SKILL.md, which only the
repository history still holds (the source keys in shipped_digests.rs name the same four
harnesses). A skill's supporting files (skills/security-audit/HUNTING.md,
skills/kretsverket/kretsverket-status-report/assets/report-template.html) are installed next to
its SKILL.md and each has one source, so each is keyed by its own bundle-relative path. Each list
holds every committed version of that path plus the working-tree version.
Retired skills and agents are included so stale removal can prove ownership. Digests use the
format of setup_fingerprint::hash_file. Binary and oversized versions are skipped.

Usage:
  python3 scripts/generate-shipped-digests.py --check
  python3 scripts/generate-shipped-digests.py --write
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "resources/default-workspace/"
OUTPUT = ROOT / PREFIX / "metadata/shipped-digests.json"
SCHEMA = 1
MAX_BYTES = 256 * 1024
HARNESSES = ("claude", "codex", "cursor", "opencode")

# Name grammars of SkillName and AgentName in src-tauri/src/artifact_registry.rs.
SKILL = r"[a-z0-9-]+"
AGENT = r"[a-z0-9_-]+"
# Per-harness adapters are gone from the working tree; their versions live in the history only.
LEGACY_ADAPTER_SKILL = re.compile(rf"^templates/skills/(?:{'|'.join(HARNESSES)})/({SKILL})/SKILL\.md$")
# Skills may sit one category directory deep (skills/<category>/<name>/SKILL.md).
GENERIC_SKILL = re.compile(rf"^skills/(?:{SKILL}/)?({SKILL})/SKILL\.md$")
DEPRECATED_SKILL = re.compile(rf"^metadata/deprecated-skills/({SKILL})/SKILL\.md$")
# Supporting files of a skill: skills/[<category>/]<name>/<rel>, rel being up to four path
# components of the grammar of SkillRelPath (no dot entries). Any SKILL.md is the skill file itself.
SUPPORT_SEGMENT = r"(?!\.)[A-Za-z0-9._-]+"
SKILL_SUPPORT_FILE = re.compile(rf"^skills/(?:{SUPPORT_SEGMENT}/){{1,5}}{SUPPORT_SEGMENT}$")
AGENT_FILES = (
    re.compile(rf"^agents/{AGENT}\.md$"),
    re.compile(rf"^templates/(?:claude|cursor)/agents/{AGENT}\.md$"),
    re.compile(rf"^templates/codex/agents/{AGENT}\.toml$"),
)
SINGLE_FILES = ("templates/playwright-mcp.config.json",)


def load_ownership_module():
    """Reuse the repository-history walker of the pre-manifest generator."""
    path = Path(__file__).with_name("generate-pre-manifest-ownership.py")
    spec = importlib.util.spec_from_file_location("generate_pre_manifest_ownership", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def usable_text(raw: bytes) -> bool:
    if not raw or len(raw) > MAX_BYTES or b"\0" in raw:
        return False
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def digest(raw: bytes) -> str:
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def source_key(rel: str) -> str | None:
    """Map a bundle-relative path to the metadata key it is recorded under."""
    if LEGACY_ADAPTER_SKILL.match(rel) or any(pattern.match(rel) for pattern in AGENT_FILES):
        return rel
    if rel in SINGLE_FILES:
        return rel
    match = GENERIC_SKILL.match(rel) or DEPRECATED_SKILL.match(rel)
    if match:
        return f"skills/{match.group(1)}/SKILL.md"
    if SKILL_SUPPORT_FILE.match(rel) and rel.rsplit("/", 1)[-1] != "SKILL.md":
        return rel
    return None


def generate() -> dict[str, object]:
    ownership = load_ownership_module()
    if ownership.git("rev-parse", "--is-shallow-repository").strip() == b"true":
        raise RuntimeError("shallow clone: shipped versions need the full git history")
    by_rel = ownership.historical_blobs_by_rel()
    sources: dict[str, set[str]] = {}
    blob_digests: dict[str, str | None] = {}

    def add(key: str, raw: bytes) -> None:
        if usable_text(raw):
            sources.setdefault(key, set()).add(digest(raw))

    for rel, shas in sorted(by_rel.items()):
        key = source_key(rel)
        if key is None:
            continue
        for sha in sorted(shas):
            if sha not in blob_digests:
                raw = ownership.git("cat-file", "blob", sha)
                blob_digests[sha] = digest(raw) if usable_text(raw) else None
            if blob_digests[sha] is not None:
                sources.setdefault(key, set()).add(blob_digests[sha])

    # The current version of each tracked source (edits not yet committed included); untracked
    # files are never shipped, so they are not listed.
    workspace = ROOT / PREFIX
    tracked = ownership.git("ls-files", "-z", "--", PREFIX).decode().split("\0")
    for rel_path in sorted(filter(None, tracked)):
        path = ROOT / rel_path
        if not path.is_file() or path.is_symlink():
            continue
        key = source_key(path.relative_to(workspace).as_posix())
        if key is not None:
            add(key, path.read_bytes())

    if not sources:
        raise RuntimeError("no shipped versions found; is the full git history available?")
    return {
        "schema": SCHEMA,
        "sources": {key: sorted(sources[key]) for key in sorted(sources)},
    }


def encoded(value: dict[str, object]) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def describe_difference(expected: dict[str, object], actual: object) -> list[str]:
    if not isinstance(actual, dict) or not isinstance(actual.get("sources"), dict):
        return ["unreadable or malformed metadata"]
    want = expected["sources"]
    have = actual["sources"]
    lines = []
    for key in sorted(set(want) | set(have)):
        missing = sorted(set(want.get(key, [])) - set(have.get(key, [])))
        extra = sorted(set(have.get(key, [])) - set(want.get(key, [])))
        if missing or extra:
            lines.append(f"{key}: {len(missing)} missing, {len(extra)} stale")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        expected = generate()
    except (RuntimeError, KeyError) as error:
        raise SystemExit(f"FAIL: {error}") from error
    count = sum(len(digests) for digests in expected["sources"].values())
    text = encoded(expected).encode("utf-8")
    if args.check:
        current = OUTPUT.read_bytes() if OUTPUT.is_file() else None
        if current != text:
            try:
                actual = json.loads(current) if current is not None else None
            except (json.JSONDecodeError, UnicodeDecodeError):
                actual = None
            for line in describe_difference(expected, actual)[:20]:
                print(line, file=sys.stderr)
            print(
                "FAIL: shipped digests are not current; run scripts/generate-shipped-digests.py --write",
                file=sys.stderr,
            )
            raise SystemExit(1)
        print(f"PASS: shipped digests are current ({count} digests, {len(expected['sources'])} sources)")
        return
    OUTPUT.write_bytes(text)
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({count} digests, {len(expected['sources'])} sources)")


if __name__ == "__main__":
    main()
