#!/usr/bin/env python3
"""Ensure curated Library docs do not list internal Cursor implementation assets."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN_DOC_REL_PATHS = [
    "templates/cursor/manifest.json",
    "templates/cursor/mcp/mcp.example.json",
    "templates/cursor/mcp/playwright.mcp.json",
    "templates/cursor/rules/core-safety.mdc",
    "templates/cursor/agents/verifier.md",
]


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    content_rs = (ROOT / "src-tauri/src/commands/content.rs").read_text(encoding="utf-8")
    # Compare against the constant's own list, not "appears anywhere in the file".
    block = re.search(
        r"const FORBIDDEN_LIBRARY_DOC_REL_PATHS:\s*&\[&str\]\s*=\s*&\[(.*?)\];",
        content_rs,
        re.DOTALL,
    )
    if not block:
        fail("content.rs FORBIDDEN_LIBRARY_DOC_REL_PATHS constant not found")
    listed = set(re.findall(r'"([^"]+)"', block.group(1)))
    for rel in FORBIDDEN_DOC_REL_PATHS:
        if rel not in listed:
            fail(f"content.rs FORBIDDEN_LIBRARY_DOC_REL_PATHS missing {rel}")
    print("Curated Library doc exclusions verified")


if __name__ == "__main__":
    main()
