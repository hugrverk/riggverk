#!/usr/bin/env python3
"""Fail when a name the project no longer uses is left in the tree outside a short allowlist.

The first residue is the name from before the Riggverk rename. Every spelling of it is one
case-insensitive pattern: hyphen, underscore, space or nothing between the two words, in any
case (the data folder, the state folder, the rules markers, the environment variables, the icon
and the prose name). It may stay only where an install made under it is read or carried over,
and where history is recorded:

  - a line that holds a constant named LEGACY_* (the earlier name, used only to read or migrate),
  - the previous app id of the app data move (see PREVIOUS_APP_ID),
  - the files and folders in ALLOWED_PATHS, each with its reason,
  - a line carrying `residue-allow`, or the lines between `residue-allow-begin` and
    `residue-allow-end` (a comment in any syntax): the upgrade notes of the docs and the few
    fixtures that seed an earlier layout on purpose.

Adding a residue later (another name that must leave the public tree) is one more entry in
RESIDUES with its own allowlist. File names are checked too. Files come from git (tracked plus
untracked, not ignored); see scripts/guards.py.

Usage: python3 scripts/check-public-residue.py [--root PATH] [--list-allowed]
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from guards import TextCache, iter_files, matches  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

# Built from fragments so this file does not itself hold the name it bans.
_WORDS = ("ag" "ent", "work" "space")
_PREVIOUS_APP_ID = "ai." + _WORDS[0] + _WORDS[1] + ".app"
_STATE_DIR = "." + _WORDS[0] + "-" + _WORDS[1]


@dataclass(frozen=True)
class Allowed:
    spec: str  # "dir/" prefix, exact path or fnmatch glob, repo-relative (see guards.matches)
    reason: str


@dataclass(frozen=True)
class Residue:
    id: str
    pattern: re.Pattern[str]
    why: str
    allowed_paths: tuple[Allowed, ...]
    # A line matching one of these may keep the name: (regex, reason).
    allowed_lines: tuple[tuple[re.Pattern[str], str], ...]


PRAGMA = re.compile(r"residue-allow(?!-)")
BLOCK_BEGIN = re.compile(r"residue-allow-begin")
BLOCK_END = re.compile(r"residue-allow-end")

RENAMED_AWAY = Residue(
    id="the name from before the Riggverk rename",
    pattern=re.compile(_WORDS[0] + r"[-_ ]?" + _WORDS[1], re.IGNORECASE),
    why="use the Riggverk names; an earlier name may stay only as a LEGACY_* constant, in history or in a marked upgrade note",
    allowed_paths=(
        Allowed(
            "resources/default-workspace/metadata/",
            "(b) metadata history: shipped digests, rules history and the pre-manifest ownership records name what earlier releases shipped",
        ),
        Allowed("release-notes/", "(c) release notes say what each release changed, including the rename"),
        Allowed("src/generated/release-notes.json", "(c) generated from release-notes/"),
        Allowed("docs/RELEASE.md", "(d) the recovery commands name the earlier app and its data directory"),
        Allowed(
            f"resources/default-workspace/{_STATE_DIR}/workspace.json",
            "(f) the bundled copy of the retired workspace marker: digest-tracked by the frozen copy list and the pre-manifest ownership records; the app ships no new marker",
        ),
        Allowed(
            "src-tauri/src/legacy_layout_contract.rs",
            "(f) the upgrade contract: proves how the earlier folder, state folder, markers and variables are carried over",
        ),
        Allowed(
            "src-tauri/src/identity_contract.rs",
            "(f) pins every earlier identifier that is still read",
        ),
    ),
    allowed_lines=(
        (re.compile(r"LEGACY_"), "(a) a constant named LEGACY_*, used only to read or migrate an earlier install"),
        (re.compile(re.escape(_PREVIOUS_APP_ID)), "(e) the previous app id the app data move starts from"),
        (PRAGMA, "a line marked residue-allow"),
    ),
)

RESIDUES = (RENAMED_AWAY,)


def allowed_path(residue: Residue, rel: str) -> Allowed | None:
    return next((allowed for allowed in residue.allowed_paths if matches(rel, allowed.spec)), None)


def scan(root: Path, files: list[str] | None = None) -> list[str]:
    """Every use of a residue outside its allowlist, as `path:line: text` strings."""
    files = iter_files(root) if files is None else files
    texts = TextCache(root)
    found: list[str] = []
    for residue in RESIDUES:
        for rel in files:
            if allowed_path(residue, rel):
                continue
            if residue.pattern.search(rel):
                found.append(f"{rel}: the file name holds {residue.id}; {residue.why}")
            text = texts.text(rel)
            if text is None:
                continue
            inside_block = False
            for number, line in enumerate(text.splitlines(), 1):
                if BLOCK_BEGIN.search(line):
                    inside_block = True
                    continue
                if BLOCK_END.search(line):
                    inside_block = False
                    continue
                if inside_block or not residue.pattern.search(line):
                    continue
                if any(allow.search(line) for allow, _ in residue.allowed_lines):
                    continue
                found.append(f"{rel}:{number}: {line.strip()[:160]}")
    return found


def describe_allowed() -> str:
    lines = []
    for residue in RESIDUES:
        lines.append(f"{residue.id}:")
        lines += [f"  path {allowed.spec}: {allowed.reason}" for allowed in residue.allowed_paths]
        lines += [f"  line /{allow.pattern}/: {reason}" for allow, reason in residue.allowed_lines]
        lines.append("  block: between residue-allow-begin and residue-allow-end")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    parser.add_argument("--list-allowed", action="store_true", help="print the allowlist and exit")
    args = parser.parse_args(argv)
    if args.list_allowed:
        print(describe_allowed())
        return 0
    found = scan(args.root.resolve())
    for hit in found:
        print(f"FAIL residue {hit}", file=sys.stderr)
    if found:
        print(f"FAIL {len(found)} use(s) of a retired name; {RESIDUES[0].why}", file=sys.stderr)
        return 1
    print("  public residue check passed: no retired name outside the allowlist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
