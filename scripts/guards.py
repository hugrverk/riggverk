"""Rule engine shared by scripts/check-bundle-content.py and scripts/check-source.py.

A rule is data: the files it applies to and a regular expression that must not appear in
them (forbid) or must appear in at least one of them (require). A rule whose files match
nothing on disk fails too, so a renamed file cannot turn a guard into a silent no-op.

Files come from git (tracked plus untracked, not ignored) when the root is a git checkout,
otherwise from a walk that skips .git, target, node_modules and dist. Binary files (a NUL
byte in the first 8 KiB) are not searched.
"""

from __future__ import annotations

import fnmatch
import os
import re
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

PRUNED_DIRS = frozenset({".git", "target", "node_modules", "dist"})


@dataclass(frozen=True)
class Rule:
    id: str
    kind: str  # "forbid" or "require"
    pattern: str  # searched line by line, or in the whole text when whole_file is set
    files: tuple[str, ...]  # "dir/" prefix, exact path or fnmatch glob, all repo-relative
    why: str
    sample: str  # text the pattern matches; the tests plant it to prove the rule fires
    exclude: tuple[str, ...] = ()
    allow: str | None = None  # forbid only: a match that fully matches this is fine
    whole_file: bool = False

    def __post_init__(self) -> None:
        if self.kind not in ("forbid", "require"):
            raise ValueError(f"{self.id}: kind must be forbid or require")


def walk(root: Path, prune: Iterable[str] = ()) -> list[str]:
    """Every file under root (symlinks included), as sorted POSIX paths relative to root."""
    pruned = set(prune)
    found: list[str] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in pruned)
        base = Path(current)
        for name in names:
            found.append((base / name).relative_to(root).as_posix())
    return sorted(found)


def iter_files(root: Path) -> list[str]:
    """Regular files under root, as sorted POSIX paths relative to root."""
    if (root / ".git").exists():
        listing = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root,
            capture_output=True,
            check=True,
        ).stdout.decode("utf-8", "surrogateescape")
        names = sorted({name for name in listing.split("\0") if name})
    else:
        names = walk(root, PRUNED_DIRS)
    return [name for name in names if (root / name).is_file()]


def matches(path: str, spec: str) -> bool:
    if spec.endswith("/"):
        return path.startswith(spec)
    if any(char in spec for char in "*?["):
        return fnmatch.fnmatchcase(path, spec)
    return path == spec


def in_scope(rule: Rule, files: Iterable[str]) -> list[str]:
    return [
        path
        for path in files
        if any(matches(path, spec) for spec in rule.files)
        and not any(matches(path, spec) for spec in rule.exclude)
    ]


class TextCache:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._texts: dict[str, str | None] = {}

    def text(self, rel: str) -> str | None:
        """File text, or None for a binary or unreadable file."""
        if rel not in self._texts:
            try:
                data = (self.root / rel).read_bytes()
            except OSError:
                data = b"\0"
            self._texts[rel] = None if b"\0" in data[:8192] else data.decode("utf-8", "replace")
        return self._texts[rel]


def find(rule: Rule, rel: str, text: str) -> list[str]:
    """Matches of the rule in one file, as `path:line: text` strings."""
    regex = re.compile(rule.pattern)
    allow = re.compile(rule.allow) if rule.allow else None
    hits: list[str] = []
    if rule.whole_file:
        match = regex.search(text)
        if match and not (allow and allow.fullmatch(match.group(0))):
            hits.append(f"{rel}:{text.count(chr(10), 0, match.start()) + 1}: {match.group(0)[:160]!r}")
        return hits
    for number, line in enumerate(text.splitlines(), 1):
        for match in regex.finditer(line):
            if allow and allow.fullmatch(match.group(0)):
                continue
            hits.append(f"{rel}:{number}: {line.strip()[:160]}")
            break
    return hits


def check(root: Path, rules: Iterable[Rule], files: list[str] | None = None) -> list[str]:
    """Run the rules over root; return one failure message per broken rule."""
    files = iter_files(root) if files is None else files
    cache = TextCache(root)
    failures: list[str] = []
    for rule in rules:
        targets = in_scope(rule, files)
        if not targets:
            failures.append(f"{rule.id}: no file matches {', '.join(rule.files)} ({rule.why})")
            continue
        hits = [hit for rel in targets if (text := cache.text(rel)) is not None for hit in find(rule, rel, text)]
        if rule.kind == "forbid" and hits:
            failures.append(f"{rule.id}: {rule.why}\n" + "\n".join(f"    {hit}" for hit in hits))
        elif rule.kind == "require" and not hits:
            failures.append(
                f"{rule.id}: {rule.why} (pattern {rule.pattern!r} not found in {', '.join(rule.files)})"
            )
    return failures
