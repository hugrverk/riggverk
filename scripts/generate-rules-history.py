#!/usr/bin/env python3
"""Bundle every rules base the app shipped, addressed by content digest.

A rules file the user edited by hand cannot be updated in place. To show what
they changed (and to move their edits below the managed block), the app needs
the exact base the file started from. This writes each distinct historical
version of templates/sync/<harness>-rules.md, plus the current one, to
resources/default-workspace/metadata/rules-history/<harness>/<sha256-hex>.md.
The app verifies that every file hashes to its own name before using it. The committed files are
an append-only baseline: a base that hashes to its own name is kept even when the git history
cannot prove it, so the output survives a repository whose history was squashed.

Usage:
  python3 scripts/generate-rules-history.py --check
  python3 scripts/generate-rules-history.py --write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_history  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "resources/default-workspace/"
HISTORY_ROOT = ROOT / PREFIX / "metadata/rules-history"
HARNESS_RULES = {
    "claude": "templates/sync/claude-rules.md",
    "codex": "templates/sync/codex-rules.md",
    "opencode": "templates/sync/opencode-rules.md",
    "copilot": "templates/sync/copilot-rules.md",
    "pi": "templates/sync/pi-rules.md",
    "kilo": "templates/sync/kilo-rules.md",
}
INDEX_NAME = "index.json"
BASE_PATH = re.compile(r"^([a-z0-9-]+)/([0-9a-f]{64})\.md$")
MAX_BYTES = 256 * 1024


def usable_text(raw: bytes) -> bool:
    if not raw or len(raw) > MAX_BYTES or b"\0" in raw:
        return False
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def generate() -> dict[str, bytes]:
    """Map path relative to the history root -> exact file bytes."""
    by_rel = generate_history.historical_blobs_by_rel()
    outputs: dict[str, bytes] = {}
    index: dict[str, list[str]] = {}
    baseline: dict[str, dict[str, bytes]] = {}
    for path, raw in existing().items():
        match = BASE_PATH.match(path)
        if match and hashlib.sha256(raw).hexdigest() == match[2]:
            baseline.setdefault(match[1], {})[match[2]] = raw
    for harness in sorted(set(HARNESS_RULES) | set(baseline)):
        versions = dict(baseline.get(harness, {}))
        rel = HARNESS_RULES.get(harness)
        if rel is not None:
            for sha in sorted(by_rel.get(rel, ())):
                raw = generate_history.blob(sha)
                if usable_text(raw):
                    versions[hashlib.sha256(raw).hexdigest()] = raw
            current = ROOT / PREFIX / rel
            if not current.is_file():
                raise RuntimeError(f"missing current rules source: {rel}")
            raw = current.read_bytes()
            if not usable_text(raw):
                raise RuntimeError(f"current rules source is not usable text: {rel}")
            versions[hashlib.sha256(raw).hexdigest()] = raw
        index[harness] = [f"sha256:{digest}" for digest in sorted(versions)]
        for digest, raw in versions.items():
            outputs[f"{harness}/{digest}.md"] = raw
    outputs[INDEX_NAME] = (
        json.dumps({"version": 1, "harnesses": index}, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    return outputs


def existing() -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    if not HISTORY_ROOT.is_dir():
        return found
    for path in sorted(HISTORY_ROOT.rglob("*")):
        if path.is_file():
            found[path.relative_to(HISTORY_ROOT).as_posix()] = path.read_bytes()
    return found


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
    actual = existing()
    missing = sorted(set(expected) - set(actual))
    stale = sorted(set(actual) - set(expected))
    changed = sorted(p for p in set(expected) & set(actual) if expected[p] != actual[p])
    if args.check:
        if missing or stale or changed:
            for label, paths in (("missing", missing), ("stale", stale), ("changed", changed)):
                if paths:
                    print(f"{label}: {', '.join(paths)}", file=sys.stderr)
            print("FAIL: rules history is not current; run scripts/generate-rules-history.py --write", file=sys.stderr)
            raise SystemExit(1)
        print(f"PASS: rules history is current ({len(expected) - 1} bundled bases)")
        return
    for rel in stale:
        (HISTORY_ROOT / rel).unlink()
    for rel, raw in expected.items():
        target = HISTORY_ROOT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or target.read_bytes() != raw:
            target.write_bytes(raw)
    for directory in sorted((p for p in HISTORY_ROOT.rglob("*") if p.is_dir()), reverse=True):
        if not any(directory.iterdir()):
            directory.rmdir()
    print(f"wrote {len(expected) - 1} bundled bases under {HISTORY_ROOT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
