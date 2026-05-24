#!/usr/bin/env python3
"""Verify default_workspace_files() lists required bundled assets (not test fixtures)."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    defaults_rs = repo_root / "src-tauri" / "src" / "commands" / "defaults.rs"
    text = defaults_rs.read_text()

    fn_match = re.search(r"pub\(crate\) fn default_workspace_files\(\)", text)
    if not fn_match:
        print("FAIL: missing default_workspace_files() in defaults.rs", file=sys.stderr)
        return 1

    test_marker = text.find("#[cfg(test)]", fn_match.start())
    if test_marker == -1:
        print("FAIL: defaults.rs missing #[cfg(test)] after default_workspace_files()", file=sys.stderr)
        return 1

    body = text[fn_match.start() : test_marker]

    def section_paths(label: str) -> set[str]:
        match = re.search(
            rf'"{re.escape(label)}",\s*&\[\s*([^\]]+)\]',
            body,
            re.DOTALL,
        )
        if not match:
            print(f"FAIL: default_workspace_files() missing {label} section", file=sys.stderr)
            raise SystemExit(1)
        return set(re.findall(r'"([^"]+)"', match.group(1)))

    scripts = section_paths("Scripts")
    templates = section_paths("Templates")

    required_scripts = {
        "scripts/generate-opencode-config.py",
        "scripts/playwright-mcp-lib.sh",
        "scripts/check-playwright-mcp.sh",
    }
    required_templates = {
        "templates/opencode.base.json",
        "templates/opencode.policy.json",
        "templates/playwright-mcp.config.json",
    }
    docs = section_paths("Docs")
    required_docs = {
        "docs/prompt-templates/standard-prompt.md",
        "docs/prompt-templates/masterprompt.md",
        "docs/prompt-templates/batchprompt.md",
    }

    ok = True
    for rel in sorted(required_scripts):
        if rel not in scripts:
            print(f"FAIL: Scripts section missing: {rel}", file=sys.stderr)
            ok = False
    for rel in sorted(required_templates):
        if rel not in templates:
            print(f"FAIL: Templates section missing: {rel}", file=sys.stderr)
            ok = False
    for rel in sorted(required_docs):
        if rel not in docs:
            print(f"FAIL: Docs section missing: {rel}", file=sys.stderr)
            ok = False

    if not ok:
        return 1

    print("  default_workspace_files(): generator, opencode base/policy, playwright mcp, prompt-template docs listed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
