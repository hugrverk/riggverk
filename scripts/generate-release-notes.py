#!/usr/bin/env python3
"""Bundle the release notes the app shows as "what's new".

release-notes/<version>.md (one per release, CalVer YYYY.M.N) is the owner-edited source. This writes
src/generated/release-notes.json, newest release first, which the app imports at build time. Sections
named "Install" are for the GitHub release page only and are left out, and a trailing PR reference
such as "(#41)" is dropped from each item.

Usage:
  python3 scripts/generate-release-notes.py --check
  python3 scripts/generate-release-notes.py --write
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTES_DIR = ROOT / "release-notes"
OUTPUT = ROOT / "src/generated/release-notes.json"

CALVER = re.compile(r"^(\d{4})\.([1-9]|1[0-2])\.([1-9]\d*)$")
EXCLUDED_SECTIONS = {"install"}
PR_SUFFIX = re.compile(r"\s*\(#\d+\)\s*$")
BULLET = re.compile(r"^[-*]\s+(.*)$")


class NotesError(Exception):
    pass


def version_key(version: str) -> tuple[int, int, int]:
    match = CALVER.match(version)
    if not match:
        raise NotesError(f"not a CalVer version (YYYY.M.N): {version}")
    return int(match[1]), int(match[2]), int(match[3])


def parse_notes(version: str, text: str) -> dict:
    """One release: {"version", "sections": [{"title", "items"}]}, without the Install section."""
    version_key(version)
    lines = text.splitlines()
    first = next((line for line in lines if line.strip()), "")
    named = re.search(rf"(?<![\d.]){re.escape(version)}(?!\.?\d)", first)
    if not (first.startswith("# ") and named):
        raise NotesError(f"release-notes/{version}.md must start with a '# ' heading naming {version}")

    sections: list[dict] = []
    skipping = False
    current: dict | None = None
    item_open = False
    for line in lines[lines.index(first) + 1 :]:
        stripped = line.strip()
        if not stripped or (stripped.startswith("<!--") and stripped.endswith("-->")):
            item_open = False
            continue
        if stripped.startswith("## "):
            title = stripped[3:].strip()
            skipping = title.lower() in EXCLUDED_SECTIONS
            current = None if skipping else {"title": title, "items": []}
            if current:
                sections.append(current)
            item_open = False
            continue
        if skipping:
            continue
        if current is None:
            current = {"title": "", "items": []}
            sections.append(current)
        bullet = BULLET.match(stripped)
        if bullet:
            current["items"].append(bullet[1])
            item_open = True
        elif item_open and line[:1] in (" ", "\t"):
            current["items"][-1] += " " + stripped
        else:
            current["items"].append(stripped)
            item_open = False

    for section in sections:
        section["items"] = [PR_SUFFIX.sub("", item) for item in section["items"]]
    sections = [section for section in sections if section["items"]]
    if not sections:
        raise NotesError(f"release-notes/{version}.md has no items for the what's new overlay")
    return {"version": version, "sections": sections}


def build_bundle(notes_dir: Path = NOTES_DIR) -> str:
    releases = []
    for path in sorted(notes_dir.glob("*.md")) if notes_dir.is_dir() else []:
        releases.append(parse_notes(path.stem, path.read_text(encoding="utf-8")))
    releases.sort(key=lambda release: version_key(release["version"]), reverse=True)
    return json.dumps({"releases": releases}, indent=2, ensure_ascii=False) + "\n"


def run(write: bool, notes_dir: Path = NOTES_DIR, output: Path = OUTPUT) -> int:
    try:
        expected = build_bundle(notes_dir)
    except NotesError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    label = output.relative_to(ROOT) if output.is_relative_to(ROOT) else output
    if write:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(expected, encoding="utf-8", newline="\n")
        print(f"wrote {label}")
        return 0
    actual = output.read_text(encoding="utf-8") if output.is_file() else None
    if actual != expected:
        print(f"FAIL: {label} is stale; run: python3 scripts/generate-release-notes.py --write", file=sys.stderr)
        return 1
    print(f"{label} is current")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="fail when the bundled file is stale")
    mode.add_argument("--write", action="store_true", help="regenerate the bundled file")
    return run(write=parser.parse_args().write)


if __name__ == "__main__":
    raise SystemExit(main())
