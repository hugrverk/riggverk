#!/usr/bin/env python3
"""Shared git-history walker of the history-based generators.

generate-pre-manifest-ownership.py, generate-rules-history.py and generate-shipped-digests.py
prove that a file is a version the app shipped. All three read the same data: every blob under
the bundled workspace in every commit reachable from HEAD, plus MERGE_HEAD while a merge is in
progress (so `generate.py write` during `git merge --no-commit` already sees the other side),
plus the tracked working tree. After a commit the working-tree version is the HEAD version, so
the outputs are the same before and after `git commit`.

The walk is cached per process: scripts/generate.py runs the three generators in one process and
walks the history once.
"""

from __future__ import annotations

import functools
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "resources/default-workspace/"


def git(*args: str, root: Path = ROOT) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def require_full_history(root: Path = ROOT) -> None:
    if git("rev-parse", "--is-shallow-repository", root=root).strip() == b"true":
        raise RuntimeError(
            "shallow clone: shipped versions need the full git history; run: git fetch --unshallow"
        )


def revisions(root: Path = ROOT) -> tuple[str, ...]:
    """Commit ids whose history counts as shipped: HEAD, plus MERGE_HEAD during a merge."""
    heads = [git("rev-parse", "--verify", "HEAD^{commit}", root=root).decode().strip()]
    try:
        merge_head = git("rev-parse", "-q", "--verify", "MERGE_HEAD^{commit}", root=root)
    except RuntimeError:
        merge_head = b""
    if merge_head.strip():
        heads.append(merge_head.decode().strip())
    return tuple(heads)


def historical_blobs_by_rel(
    prefix: str = PREFIX, root: Path = ROOT
) -> dict[str, frozenset[str]]:
    """Map bundle-relative path -> every blob sha it had in the history of revisions().

    Matches the bundled workspace at any historical repository location
    (e.g. apps/ux-workspace-app/resources/default-workspace before the
    repository was flattened). Tree inspection is intentional: rev-list
    --objects emits each object once, with a path label that can change when
    unrelated refs are present. The result is a new dict; its values are immutable.
    """
    require_full_history(root)
    return dict(_walk(Path(root).resolve(), prefix, revisions(root)))


@functools.cache
def _walk(root: Path, prefix: str, heads: tuple[str, ...]) -> dict[str, frozenset[str]]:
    rel_to_shas: dict[str, set[str]] = {}
    needle = prefix.encode()
    for commit in git("rev-list", *heads, root=root).decode().splitlines():
        for line in git("ls-tree", "-rz", "-r", "--full-tree", commit, root=root).split(b"\0"):
            if not line:
                continue
            meta, _, raw_path = line.partition(b"\t")
            if not raw_path:
                continue
            parts = meta.split()
            if len(parts) < 3 or parts[1] != b"blob":
                continue
            index = raw_path.find(needle)
            if index == -1:
                continue
            if index != 0 and not raw_path[:index].endswith(b"/"):
                continue
            rel = raw_path[index + len(needle) :].decode("utf-8", errors="surrogateescape")
            if rel:
                rel_to_shas.setdefault(rel, set()).add(parts[2].decode())
    return {rel: frozenset(shas) for rel, shas in rel_to_shas.items()}


@functools.cache
def blob(sha: str, root: Path = ROOT) -> bytes:
    return git("cat-file", "blob", sha, root=root)


def tracked_files(prefix: str = PREFIX, root: Path = ROOT) -> list[str]:
    """Repository-relative paths under prefix in the git index (staged new files included)."""
    listed = git("ls-files", "-z", "--", prefix, root=root).decode().split("\0")
    return sorted(set(filter(None, listed)))
