#!/usr/bin/env python3
"""Generate and verify exact ownership metadata for pre-manifest installs.

Approves every digest the app ever shipped for each managed artifact so a
pre-manifest installation deployed from ANY historical app version is
recognized as app-owned and can be updated or removed. User-modified content
never matches a shipped digest and remains a preserved conflict.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_COMMIT = "2d85d94b6f2f1dc06f45f6ec52a22ae97e499588"
PREFIX = "resources/default-workspace/"
MANIFEST = ROOT / PREFIX / "metadata/pre-manifest-ownership.json"
WORKSPACE_MANIFEST = ROOT / "src-tauri/src/commands/default_workspace_manifest.rs"
BOOTSTRAP = ROOT / "src-tauri/src/managed_bootstrap.rs"


def git(*args: str) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def digest(raw: bytes) -> str:
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def rust_string_list(path: Path, start: str, end: str) -> list[str]:
    text = path.read_text(encoding="utf-8")
    section = text.split(start, 1)[1].split(end, 1)[0]
    return re.findall(r'"([^"]+)"', section)


def current_workspace_paths() -> list[str]:
    text = WORKSPACE_MANIFEST.read_text(encoding="utf-8")
    section = text.split("pub(super) fn categories()", 1)[1]
    return sorted(
        value
        for value in re.findall(r'"([^"]+)"', section)
        if "/" in value or value.endswith(".md") or value.endswith(".json")
    )


def removed_skill_names() -> list[str]:
    return rust_string_list(BOOTSTRAP, "pub const REMOVED_SKILL_NAMES", "];")


def historical_blobs_by_rel() -> dict[str, set[str]]:
    """Map default-workspace relative path -> all blob shas across HEAD history.

    Matches the bundled workspace at any historical repository location
    (e.g. apps/ux-workspace-app/resources/default-workspace before the
    repository was flattened). Tree inspection is intentional: rev-list
    --objects emits each object once, with a path label that can change when
    unrelated refs are present.
    """
    rel_to_shas: dict[str, set[str]] = {}
    prefix = PREFIX.encode()
    for commit in git("rev-list", "HEAD").decode().splitlines():
        for line in git("ls-tree", "-rz", "-r", "--full-tree", commit).split(b"\0"):
            if not line:
                continue
            meta, _, raw_path = line.partition(b"\t")
            if not raw_path:
                continue
            parts = meta.split()
            if len(parts) < 3 or parts[1] != b"blob":
                continue
            index = raw_path.find(prefix)
            if index == -1:
                continue
            if index != 0 and not raw_path[:index].endswith(b"/"):
                continue
            rel = raw_path[index + len(prefix) :].decode(
                "utf-8", errors="surrogateescape"
            )
            if rel:
                rel_to_shas.setdefault(rel, set()).add(parts[2].decode())
    return rel_to_shas


class HistoricalDigests:
    def __init__(self) -> None:
        self._by_rel = historical_blobs_by_rel()
        self._blob_cache: dict[str, str] = {}

    def for_rel(self, rel: str) -> set[str]:
        digests: set[str] = set()
        for sha in sorted(self._by_rel.get(rel, set())):
            cached = self._blob_cache.get(sha)
            if cached is None:
                cached = digest(git("cat-file", "blob", sha))
                self._blob_cache[sha] = cached
            digests.add(cached)
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


def generate() -> dict[str, object]:
    git("cat-file", "-e", f"{SOURCE_COMMIT}^{{commit}}")
    history = HistoricalDigests()
    artifacts: list[dict[str, object]] = []

    removed = removed_skill_names()
    for name in removed:
        digests = history.shipped_for_rels(
            [
                f"skills/{name}/SKILL.md",
                f"metadata/deprecated-skills/{name}/SKILL.md",
            ]
        )
        if not digests:
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
    if not scout:
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
    if not deprecated_meta:
        raise RuntimeError("no historical version found for deprecated-skills.json")
    artifacts.append(
        entry(
            "legacy-metadata:deprecated-skills",
            ["runtime-metadata"],
            deprecated_meta,
            "remove",
        )
    )

    skill_rels = current_skill_rels()
    for name, rel in sorted(skill_rels.items()):
        if name in removed:
            continue
        digests = history.for_rel(rel)
        # Canonical skill files were the harness install source before
        # generated skill adapters were introduced. Keep the current canonical
        # digest approved so pre-adapter installs from the immediately prior
        # app version can be adopted and updated to adapters.
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
    for rel in current_workspace_paths():
        if rel in skill_rel_values:
            continue
        digests = history.for_rel(rel)
        current = current_digest(rel)
        if current is None:
            continue
        digests.discard(current)
        if digests:
            artifacts.append(
                entry(
                    f"workspace:file:{rel}",
                    ["workspace-doc"],
                    digests,
                    "update",
                )
            )

    artifacts.sort(key=lambda value: str(value["identity"]))
    return {
        "migration_id": "pre-managed-state-2d85d94",
        "source_commit": SOURCE_COMMIT,
        "artifacts": artifacts,
    }


def encoded(value: dict[str, object]) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
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
