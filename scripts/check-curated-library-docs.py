#!/usr/bin/env python3
"""Guard curated Library Docs registry: user-facing docs only, prompt templates listed."""

from __future__ import annotations

import re
import sys
from pathlib import Path


FORBIDDEN_REL_PATHS = {
    "templates/cursor/manifest.json",
    "templates/cursor/mcp/README.md",
    "templates/cursor/mcp/mcp.example.json",
    "templates/cursor/mcp/playwright.mcp.json",
    "templates/cursor/sandbox/README.md",
    "templates/cursor/sandbox/safe.json",
    "templates/cursor/sandbox/playwright-safe.json",
    "templates/cursor/sandbox/playwright-full.json",
}

REQUIRED_PROMPT_TEMPLATE_DOCS = {
    "docs/prompt-templates/standard-prompt.md",
    "docs/prompt-templates/masterprompt.md",
    "docs/prompt-templates/batchprompt.md",
}

ALLOWED_CURSOR_DOC_PATHS = {
    "templates/cursor/README.md",
    "templates/cursor/user-rules.md",
}


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    content_rs = repo_root / "src-tauri" / "src" / "commands" / "content.rs"
    text = content_rs.read_text()

    fn_match = re.search(r"fn curated_doc_registry\(\)", text)
    if not fn_match:
        print("FAIL: missing curated_doc_registry() in content.rs", file=sys.stderr)
        return 1

    end = text.find("/// Relative paths that must never appear", fn_match.start())
    if end == -1:
        end = text.find("fn existing_curated_docs", fn_match.start())
    if end == -1:
        print("FAIL: cannot locate end of curated_doc_registry()", file=sys.stderr)
        return 1

    body = text[fn_match.start() : end]
    rel_paths = set(re.findall(r'rel_path:\s*"([^"]+)"', body))

    ok = True
    for forbidden in sorted(FORBIDDEN_REL_PATHS):
        if forbidden in rel_paths:
            print(
                f"FAIL: curated_doc_registry exposes internal Cursor doc: {forbidden}",
                file=sys.stderr,
            )
            ok = False

    cursor_paths = {p for p in rel_paths if p.startswith("templates/cursor/")}
    extra_cursor = cursor_paths - ALLOWED_CURSOR_DOC_PATHS
    if extra_cursor:
        for path in sorted(extra_cursor):
            print(
                f"FAIL: unexpected Cursor doc in curated registry: {path}",
                file=sys.stderr,
            )
        ok = False

    for required in sorted(REQUIRED_PROMPT_TEMPLATE_DOCS):
        if required not in rel_paths:
            print(
                f"FAIL: curated_doc_registry missing prompt template doc: {required}",
                file=sys.stderr,
            )
            ok = False

    if not ok:
        return 1

    print(
        "  curated_doc_registry: prompt templates listed; internal Cursor assets excluded"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
