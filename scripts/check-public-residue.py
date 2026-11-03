#!/usr/bin/env python3
"""Fail when text the project no longer ships is left in the tree outside a short allowlist.

The first residue is the name from before the Riggverk rename. Every spelling of it is one
case-insensitive pattern: hyphen, underscore, space or nothing between the two words, in any
case (the data folder, the state folder, the rules markers, the environment variables, the icon
and the prose name). It may stay only where an install made under it is read or carried over,
and where history is recorded:

  - a line that holds a constant named LEGACY_* (a whole identifier: LEGACY_ then capitals, digits
    or underscores; the earlier name, used only to read or migrate),
  - the previous app id of the app data move (see PREVIOUS_APP_ID),
  - the files and folders in ALLOWED_PATHS, each with its reason,
  - a line carrying `residue-allow`, or the lines between `residue-allow-begin` and
    `residue-allow-end`, written in a comment (`#`, `//`, `<!--`, `/*`, `*` or `--` before it; the
    same words inside a string do nothing): the upgrade notes of the docs and the few fixtures
    that seed an earlier layout on purpose. A begin without its end is a failure.

The later residues guard cleaned text from coming back, each scoped to the files it concerns:
Swedish in skill descriptions, model ids in skill text, hard-coded user home paths, and team-pack content in the bundle. They name no person: the home-path
residue matches the shape of a path, with a short list of placeholder names.

Adding a residue later is one more entry in RESIDUES with its own scope and allowlist. For
the rename residue, file names are checked too. Files come from git (tracked plus
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
    # Files the residue concerns (see guards.matches); empty means every file.
    scope: tuple[str, ...] = ()
    check_names: bool = False  # also fail on a file whose name matches the pattern


# A pragma counts only in a comment: its words after a comment leader, never inside a string.
_COMMENT = r"(?:#|//|<!--|/\*|\*|--)\s*"
PRAGMA = re.compile(_COMMENT + r"residue-allow(?!-)")
BLOCK_BEGIN = re.compile(_COMMENT + r"residue-allow-begin")
BLOCK_END = re.compile(_COMMENT + r"residue-allow-end")

RENAMED_AWAY = Residue(
    id="the name from before the Riggverk rename",
    pattern=re.compile(_WORDS[0] + r"[-_ ]?" + _WORDS[1], re.IGNORECASE),
    check_names=True,
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
        (re.compile(r"\bLEGACY_[A-Z0-9_]+\b"), "(a) a constant named LEGACY_*, used only to read or migrate an earlier install"),
        (re.compile(re.escape(_PREVIOUS_APP_ID)), "(e) the previous app id the app data move starts from"),
        (PRAGMA, "a line marked residue-allow"),
    ),
)

_BUNDLE = "resources/default-workspace/"
_BUNDLE_HISTORY = Allowed(
    _BUNDLE + "metadata/",
    "metadata history records what earlier releases shipped, so it keeps the text of old bases",
)
_PRAGMA_LINE = (PRAGMA, "a line marked residue-allow")

SWEDISH_TRIGGERS = Residue(
    id="Swedish in a skill description",
    pattern=re.compile(r"^description:.*(?:[åäöÅÄÖ]|\b(?:kör|låt|skriv|granska|statusrapport|lägesrapport)\b)"),
    why="skill descriptions use English trigger phrases; keep Swedish examples in the skill body",
    scope=(_BUNDLE + "skills/*/SKILL.md",),
    allowed_paths=(),
    allowed_lines=(_PRAGMA_LINE,),
)

TEAM_PACK_CONTENT = Residue(
    id="team-pack content in the bundled workspace",
    pattern=re.compile(r"kretsverket|\.kretsym?\b|localhost:1420|wordpress-woocommerce", re.IGNORECASE),
    why="Kretsverket and WordPress content lives in the private team pack, not in the public bundle",
    scope=(_BUNDLE,),
    allowed_paths=(_BUNDLE_HISTORY,),
    allowed_lines=(_PRAGMA_LINE,),
)

MODEL_IDS = Residue(
    id="a concrete model id in skill text",
    pattern=re.compile(
        r"\b(?:gpt-\d[\w.-]*|claude-(?:\d|opus|sonnet|haiku|instant)[\w.-]*|gemini-\d[\w.-]*|grok-\d[\w.-]*"
        r"|glm-\d[\w.-]*|deepseek-[a-z]*\d[\w.-]*|llama-?\d[\w.-]*|qwen\d?-[\w.-]+|kimi-[\w.-]*\d[\w.-]*"
        r"|o[1-9]-(?:mini|pro|preview|high|low)|o[1-9]-\d{4}-\d{2}-\d{2})\b",
        re.IGNORECASE,
    ),
    why="skills name a harness and a <model> placeholder; model ids go stale and tie a skill to one account",
    scope=(_BUNDLE + "skills/",),
    allowed_paths=(),
    allowed_lines=(_PRAGMA_LINE,),
)

# The shape of a user home path, never a name: a placeholder is exempt only as the whole path component.
_PLACEHOLDER_USERS = "example|examples|me|dev|mock|user|you|name|runner|runneradmin|username|someone|someone-else|other|u|x|public|default"
HOME_PATHS = Residue(
    id="a hard-coded user home path",
    pattern=re.compile(
        r"(?:/Users/|/home/|[A-Za-z]:[\\/]+Users[\\/]+)(?!(?:" + _PLACEHOLDER_USERS + r")(?![A-Za-z0-9_.-]))[A-Za-z0-9_][A-Za-z0-9_.-]*",
        re.IGNORECASE,
    ),
    why="use a placeholder user such as Example or someone, never a real account name",
    allowed_paths=(_BUNDLE_HISTORY,),
    allowed_lines=(_PRAGMA_LINE,),
)

RESIDUES = (RENAMED_AWAY, SWEDISH_TRIGGERS, MODEL_IDS, HOME_PATHS, TEAM_PACK_CONTENT)


def allowed_path(residue: Residue, rel: str) -> Allowed | None:
    return next((allowed for allowed in residue.allowed_paths if matches(rel, allowed.spec)), None)


def in_scope(residue: Residue, rel: str) -> bool:
    return not residue.scope or any(matches(rel, spec) for spec in residue.scope)


def scan_residue(residue: Residue, files: list[str], texts: TextCache, report_blocks: bool = False) -> list[str]:
    """Hits of one residue. `report_blocks` also reports an unbalanced pragma block (once, not per residue)."""
    found: list[str] = []
    for rel in files:
        if not in_scope(residue, rel) or allowed_path(residue, rel):
            continue
        if residue.check_names and residue.pattern.search(rel):
            found.append(f"{rel}: the file name holds {residue.id}; {residue.why}")
        text = texts.text(rel)
        if text is None:
            continue
        block_start = 0
        for number, line in enumerate(text.splitlines(), 1):
            if BLOCK_BEGIN.search(line):
                block_start = block_start or number
                continue
            if BLOCK_END.search(line):
                block_start = 0
                continue
            inside_block = block_start > 0
            if inside_block or not residue.pattern.search(line):
                continue
            if any(allow.search(line) for allow, _ in residue.allowed_lines):
                continue
            found.append(f"{rel}:{number}: {line.strip()[:160]}")
        if block_start and report_blocks:
            found.append(f"{rel}:{block_start}: residue-allow-begin has no residue-allow-end")
    return found


def scan(root: Path, files: list[str] | None = None) -> list[str]:
    """Every use of a residue outside its allowlist, as `path:line: text` strings."""
    files = iter_files(root) if files is None else files
    texts = TextCache(root)
    return [hit for index, residue in enumerate(RESIDUES) for hit in scan_residue(residue, files, texts, index == 0)]


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
    root = args.root.resolve()
    files = iter_files(root)
    texts = TextCache(root)
    failed = 0
    for index, residue in enumerate(RESIDUES):
        hits = scan_residue(residue, files, texts, index == 0)
        for hit in hits:
            print(f"FAIL residue {hit}", file=sys.stderr)
        if hits:
            failed += len(hits)
            print(f"FAIL {len(hits)} use(s) of {residue.id}; {residue.why}", file=sys.stderr)
    if failed:
        return 1
    print("  public residue check passed: no retired text outside the allowlist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
