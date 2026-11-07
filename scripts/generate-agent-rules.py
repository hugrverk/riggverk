#!/usr/bin/env python3
"""Compose harness rule sync files from shared core + harness appendices.

Option B: templates/global-agent-rules.md remains the editable shared core.
Harness-specific text lives in templates/rules/<harness>.md only.

Usage:
  python3 scripts/generate-agent-rules.py --check
  python3 scripts/generate-agent-rules.py --write
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WS_ROOT = REPO_ROOT / "resources" / "default-workspace"
MANIFEST_PATH = WS_ROOT / "metadata" / "rules-adapters.json"


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        fail(f"missing manifest: {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def read_text(path: Path) -> str:
    if not path.is_file():
        fail(f"missing file: {path}")
    return path.read_text(encoding="utf-8")


def strip_leading_title(markdown: str) -> str:
    lines = markdown.splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines = lines[1:]
    return "\n".join(lines).strip()


def compose_shared(core: str, appendix: str) -> str:
    core_text = core.rstrip() + "\n"
    appendix_text = appendix.strip()
    if not appendix_text:
        return core_text if core_text.endswith("\n") else core_text + "\n"
    return core_text + "\n" + appendix_text + "\n"


def compose_cursor(core: str, appendix: str, title: str) -> str:
    body = strip_leading_title(core)
    appendix_text = appendix.strip()
    parts = [f"# {title}", "", appendix_text, "", body]
    return "\n".join(parts).rstrip() + "\n"


def generated_outputs(manifest: dict) -> dict[Path, str]:
    core_rel = manifest.get("core")
    if not core_rel:
        fail("manifest missing core path")
    core = read_text(WS_ROOT / core_rel)
    outputs: dict[Path, str] = {}
    harnesses = manifest.get("harnesses", {})
    for harness_name, harness in harnesses.items():
        appendix = read_text(WS_ROOT / harness["appendix"])
        out = WS_ROOT / harness["output"]
        title = harness.get("title")
        if harness_name == "cursor" and title:
            content = compose_cursor(core, appendix, title)
        else:
            content = compose_shared(core, appendix)
        outputs[out] = content
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    args = parser.parse_args()

    manifest = load_manifest()
    outputs = generated_outputs(manifest)
    stale: list[str] = []

    for path, expected in sorted(outputs.items()):
        rel = path.relative_to(REPO_ROOT)
        if not path.exists():
            stale.append(f"missing {rel}")
            continue
        actual = path.read_text(encoding="utf-8")
        if actual != expected:
            stale.append(f"stale {rel}")

    if args.write:
        for path, content in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {len(outputs)} composed rule files")
        if stale:
            print("updated:", ", ".join(stale))
        sys.exit(0)

    if stale:
        print("FAIL: composed rule files are stale:", file=sys.stderr)
        for item in stale:
            print(f"  - {item}", file=sys.stderr)
        print("Run: python3 scripts/generate-agent-rules.py --write", file=sys.stderr)
        sys.exit(1)

    print(f"PASS: {len(outputs)} composed rule files are current")


if __name__ == "__main__":
    main()
