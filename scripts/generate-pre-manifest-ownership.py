#!/usr/bin/env python3
"""Generate and verify exact ownership metadata for pre-manifest installs.

Approves every digest the app ever shipped for each managed artifact so a
pre-manifest installation deployed from ANY historical app version is
recognized as app-owned and can be updated or removed. User-modified content
never matches a shipped digest and remains a preserved conflict.

A shipped version is one committed in the history of HEAD (and MERGE_HEAD during a merge) or
the tracked working-tree version, so the output is the same before and after `git commit`. The
committed file is an append-only baseline: every digest in it stays, so the output survives a
repository whose history was squashed (the source commit is then only required to be recorded).

Usage:
  python3 scripts/generate-pre-manifest-ownership.py --check
  python3 scripts/generate-pre-manifest-ownership.py --write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_history  # noqa: E402
import retired_workspace_files  # noqa: E402

# Re-exported: callers that load this script for its history walker keep working.
from generate_history import git, historical_blobs_by_rel  # noqa: E402,F401

ROOT = Path(__file__).resolve().parents[1]
# The pre-manifest ownership source. Written to the manifest and compared by managed_bootstrap.rs,
# so it stays a commit id; it is not looked up.
SOURCE_COMMIT = "2d85d94b6f2f1dc06f45f6ec52a22ae97e499588"
# resources/default-workspace/ at SOURCE_COMMIT. A tree id survives a history rewrite that leaves
# the bundle byte for byte; the commit id does not.
SOURCE_BUNDLE_TREE = "ee0eefd4b7c8d84f7dc40de05556aaa225d9b087"
PREFIX = "resources/default-workspace/"
MANIFEST = ROOT / PREFIX / "metadata/pre-manifest-ownership.json"
BOOTSTRAP = ROOT / "src-tauri/src/managed_bootstrap.rs"
# Skill files in the bundle history: skills/[<category>/]<name>/SKILL.md and deprecated snapshots.
HISTORICAL_SKILL_FILES = (
    re.compile(r"^skills/(?:[a-z0-9-]+/)?([a-z0-9-]+)/SKILL\.md$"),
    re.compile(r"^metadata/deprecated-skills/([a-z0-9-]+)/SKILL\.md$"),
)
# Removed skills that no tagged build shipped, so no installation holds them: sync-agent-rules was
# added in c0b6e8d and removed a day later in 19b4040 (app-v0.1.0 predates both, v0.1.0-alpha has both).
NEVER_RELEASED_SKILLS = ("sync-agent-rules",)
# Skills dropped from the bundle after managed records existed, moved to a team pack after
# 2026.10.17. An installed copy is retired through its managed record, or adopted by a pack that
# ships the same name, so they take no removed-skill identity; their committed `skill:` entries stay
# (append-only) and still prove a pre-manifest copy for a pack that ships the skill.
RETIRED_AFTER_MANIFEST = (
    "kretsverket-editor-change",
    "kretsverket-electrical-drawing",
    "kretsverket-file-compatibility",
    "kretsverket-status-report",
    "kretsverket-symbol-system",
    "wordpress-woocommerce",
)


def digest(raw: bytes) -> str:
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def shipped_digest_variants(raw: bytes) -> set[str]:
    digests = {digest(raw)}
    if b"\0" in raw or b"\n" not in raw:
        return digests
    crlf = raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    digests.add(digest(crlf))
    return digests


def rust_string_list(path: Path, start: str, end: str) -> list[str]:
    text = path.read_text(encoding="utf-8")
    section = text.split(start, 1)[1].split(end, 1)[0]
    return re.findall(r'"([^"]+)"', section)


def workspace_copy_paths() -> list[str]:
    """Every file of the workspace copy: the marker and the frozen RETIRED_WORKSPACE_FILES."""
    return sorted(retired_workspace_files.load(ROOT).copy_paths())


def removed_skill_names() -> list[str]:
    return rust_string_list(BOOTSTRAP, "pub const REMOVED_SKILL_NAMES", "];")


def unregistered_removed_skills(
    historical_rels: Iterable[str], current: Iterable[str], removed: Iterable[str]
) -> list[str]:
    """Skills the bundle history holds that are gone now but missing from REMOVED_SKILL_NAMES."""
    shipped: set[str] = set()
    for rel in historical_rels:
        for pattern in HISTORICAL_SKILL_FILES:
            match = pattern.match(rel)
            if match:
                shipped.add(match.group(1))
    return sorted(
        shipped - set(current) - set(removed) - set(NEVER_RELEASED_SKILLS) - set(RETIRED_AFTER_MANIFEST)
    )


class HistoricalDigests:
    """Digest variants of every shipped version of a bundle path.

    Shipped means committed (see generate_history) or the tracked working-tree version; adding the
    working tree makes every entry the same before and after `git commit`, including the CRLF
    variant of the current version that the update entries keep.
    """

    def __init__(
        self,
        by_rel: Mapping[str, Iterable[str]] | None = None,
        tracked: Iterable[str] | None = None,
        read_blob: Callable[[str], bytes] = generate_history.blob,
        workspace: Path = ROOT / PREFIX,
    ) -> None:
        self._by_rel = historical_blobs_by_rel() if by_rel is None else by_rel
        if tracked is None:
            tracked = (path[len(PREFIX) :] for path in generate_history.tracked_files(PREFIX))
        self._tracked = set(tracked)
        self._read_blob = read_blob
        self._workspace = workspace
        self._blob_cache: dict[str, set[str]] = {}

    def rels(self) -> Iterable[str]:
        return self._by_rel.keys()

    def for_rel(self, rel: str) -> set[str]:
        digests: set[str] = set()
        for sha in sorted(self._by_rel.get(rel, ())):
            cached = self._blob_cache.get(sha)
            if cached is None:
                cached = shipped_digest_variants(self._read_blob(sha))
                self._blob_cache[sha] = cached
            digests.update(cached)
        path = self._workspace / rel
        if rel in self._tracked and path.is_file() and not path.is_symlink():
            digests |= shipped_digest_variants(path.read_bytes())
        return digests

    def shipped_for_rels(self, rels: list[str]) -> set[str]:
        digests: set[str] = set()
        for rel in rels:
            digests |= self.for_rel(rel)
        return digests


def current_digest(rel: str) -> str | None:
    path = ROOT / PREFIX / rel
    if not path.is_file():
        return None
    return digest(path.read_bytes())


def entry(
    identity: str, path_classes: list[str], digests: set[str], action: str
) -> dict[str, object]:
    return {
        "identity": identity,
        "path_classes": path_classes,
        "digests": sorted(digests),
        "action": action,
    }


def workspace_copy_entry(
    rel: str, shipped: set[str], current: str | None
) -> dict[str, object] | None:
    """Approved digests of one file of the workspace copy; None when no version is known.

    A file the bundle still holds is updated: its current version is the bundle's own and needs
    no approval. A file the bundle no longer holds is removed: every shipped version is the app's.
    """
    digests = set(shipped)
    action = "remove"
    if current is not None:
        digests.discard(current)
        action = "update"
    if not digests:
        return None
    return entry(f"workspace:file:{rel}", ["workspace-doc"], digests, action)


def current_skill_rels() -> dict[str, str]:
    """Map current skill name -> bundled SKILL.md relative path."""
    skills_root = ROOT / PREFIX / "skills"
    rels: dict[str, str] = {}
    for skill_md in sorted(skills_root.rglob("SKILL.md")):
        rel = skill_md.relative_to(ROOT / PREFIX).as_posix()
        rels[skill_md.parent.name] = rel
    return rels


def current_agent_rels() -> dict[str, str]:
    """Map agent identity -> bundled adapter relative path."""
    rels: dict[str, str] = {}
    for path in sorted((ROOT / PREFIX / "agents").glob("*.md")):
        if path.stem == "scout":
            continue
        rels[f"agent:opencode:{path.stem}"] = f"agents/{path.name}"
    for path in sorted((ROOT / PREFIX / "templates/claude/agents").glob("*.md")):
        rels[f"agent:claude:{path.stem}"] = f"templates/claude/agents/{path.name}"
    for path in sorted((ROOT / PREFIX / "templates/codex/agents").glob("*.toml")):
        rels[f"agent:codex:{path.stem}"] = f"templates/codex/agents/{path.name}"
    for path in sorted((ROOT / PREFIX / "templates/cursor/agents").glob("*.md")):
        rels[f"agent:cursor:{path.stem}"] = f"templates/cursor/agents/{path.name}"
    return rels


RULES_RELS = {
    "rules:opencode": "templates/sync/opencode-rules.md",
    "rules:codex": "templates/sync/codex-rules.md",
    "rules:claude": "templates/sync/claude-rules.md",
}


def load_baseline() -> dict[str, object]:
    try:
        value = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def generate() -> dict[str, object]:
    baseline = load_baseline()
    kept = {
        str(value["identity"]): value
        for value in baseline.get("artifacts", [])
        if isinstance(value, dict) and "identity" in value
    }

    def proven(identity: str, digests: set[str]) -> set[str]:
        return digests or set(kept.get(identity, {}).get("digests", ()))

    try:
        git("cat-file", "-e", f"{SOURCE_BUNDLE_TREE}^{{tree}}")
    except RuntimeError:
        if baseline.get("source_commit") != SOURCE_COMMIT:
            raise
    history = HistoricalDigests()
    artifacts: list[dict[str, object]] = []

    removed = removed_skill_names()
    skill_rels = current_skill_rels()
    unregistered = unregistered_removed_skills(history.rels(), skill_rels, removed)
    if unregistered:
        raise RuntimeError(
            "skills removed from the bundle must be listed in REMOVED_SKILL_NAMES "
            f"({BOOTSTRAP.relative_to(ROOT)}): {', '.join(unregistered)}"
        )
    for name in removed:
        digests = history.shipped_for_rels(
            [
                f"skills/{name}/SKILL.md",
                f"metadata/deprecated-skills/{name}/SKILL.md",
            ]
        )
        if not proven(f"removed-skill:{name}", digests):
            raise RuntimeError(f"no historical version found for removed skill {name}")
        artifacts.append(
            entry(
                f"removed-skill:{name}",
                [
                    "runtime-skill",
                    "runtime-deprecated-copy",
                    "harness-skill",
                    "codex-legacy-skill",
                ],
                digests,
                "remove",
            )
        )

    scout = history.for_rel("agents/scout.md")
    if not proven("legacy-agent:scout", scout):
        raise RuntimeError("no historical version found for agents/scout.md")
    artifacts.append(
        entry(
            "legacy-agent:scout",
            ["runtime-agent", "opencode-agent"],
            scout,
            "remove",
        )
    )
    deprecated_meta = history.for_rel("metadata/deprecated-skills.json")
    if not proven("legacy-metadata:deprecated-skills", deprecated_meta):
        raise RuntimeError("no historical version found for deprecated-skills.json")
    artifacts.append(
        entry(
            "legacy-metadata:deprecated-skills",
            ["runtime-metadata"],
            deprecated_meta,
            "remove",
        )
    )

    for name, rel in sorted(skill_rels.items()):
        if name in removed:
            continue
        digests = history.for_rel(rel)
        # Canonical skill files were the harness install source before
        # per-harness skill adapters were introduced, and are again. Keep every
        # canonical version approved so installs from any app version that
        # copied the canonical file can be adopted and updated. Per-harness
        # adapter versions are proven by shipped-digests.json instead.
        if digests:
            artifacts.append(
                entry(
                    f"skill:{name}",
                    ["runtime-skill", "harness-skill", "codex-legacy-skill"],
                    digests,
                    "update",
                )
            )

    for identity, rel in sorted(current_agent_rels().items()):
        digests = history.for_rel(rel)
        current = current_digest(rel)
        if current:
            digests.discard(current)
        if digests:
            path_class = f"{identity.split(':')[1]}-agent"
            artifacts.append(entry(identity, [path_class], digests, "update"))

    for identity, rel in sorted(RULES_RELS.items()):
        digests = history.for_rel(rel)
        current = current_digest(rel)
        if current:
            digests.discard(current)
        if digests:
            path_class = f"{identity.split(':')[1]}-rules"
            artifacts.append(entry(identity, [path_class], digests, "update"))

    skill_rel_values = set(skill_rels.values())
    for rel in workspace_copy_paths():
        if rel in skill_rel_values:
            continue
        copy = workspace_copy_entry(rel, history.for_rel(rel), current_digest(rel))
        if copy:
            artifacts.append(copy)

    # Append-only: committed entries stay, and committed digests join the proven ones.
    merged = {str(value["identity"]): value for value in artifacts}
    for identity, old in kept.items():
        value = merged.setdefault(identity, old)
        value["digests"] = sorted(set(value["digests"]) | set(old.get("digests", ())))
    artifacts = sorted(merged.values(), key=lambda value: str(value["identity"]))
    return {
        "migration_id": "pre-managed-state-2d85d94",
        "source_commit": SOURCE_COMMIT,
        "artifacts": artifacts,
    }


def encoded(value: dict[str, object]) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        expected = generate()
    except (RuntimeError, KeyError, IndexError) as error:
        raise SystemExit(f"FAIL: {error}") from error
    if args.check:
        actual = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if actual != expected:
            print("FAIL: pre-manifest ownership metadata is incomplete or stale", file=sys.stderr)
            raise SystemExit(1)
        print("pre-manifest ownership semantic coverage passed")
        return
    MANIFEST.write_text(encoded(expected), encoding="utf-8")
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(expected['artifacts'])} entries)")


if __name__ == "__main__":
    main()
