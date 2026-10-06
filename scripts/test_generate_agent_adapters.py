#!/usr/bin/env python3
"""Tests for the Claude agent header contract enforced by generate-agent-adapters.py."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
WS = Path("resources/default-workspace")
GENERATOR_PATH = ROOT / "scripts" / "generate-agent-adapters.py"


def load_generator():
    sys.path.insert(0, str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("generate_agent_adapters", GENERATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load generator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def claude_agent(role: str, **overrides: str | None) -> str:
    fields = {
        "name": role,
        "description": f"Use proactively for {role} work.",
        "model": "sonnet",
        "tools": "Read, Grep, Glob",
        "permissionMode": "plan",
        "maxTurns": "12",
    }
    fields.update(overrides)
    lines = [f"{key}: {value}" for key, value in fields.items() if value is not None]
    return "---\n" + "\n".join(lines) + "\n---\n\nBody.\n"


class ClaudeHeaderContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.generator = load_generator()

    def errors(self, role: str, content: str) -> list[str]:
        path = ROOT / WS / f"templates/claude/agents/{role}.md"
        return self.generator._validate_markdown_frontmatter(path, content, role, "claude")

    def test_valid_read_only_header_passes(self) -> None:
        for role in ("inspector", "sentinel", "repo-scout"):
            self.assertEqual(self.errors(role, claude_agent(role)), [])

    def test_read_only_agent_without_tools_fails(self) -> None:
        errors = self.errors("inspector", claude_agent("inspector", tools=None))
        self.assertTrue(any("explicit non-empty 'tools:'" in e for e in errors), errors)

    def test_read_only_agent_with_extra_tool_fails(self) -> None:
        errors = self.errors("sentinel", claude_agent("sentinel", tools="Read, Grep, Glob, Bash"))
        self.assertTrue(any("must only use read-only tools" in e for e in errors), errors)

    def test_read_only_agent_requires_plan_mode(self) -> None:
        errors = self.errors("inspector", claude_agent("inspector", permissionMode=None))
        self.assertTrue(any("permissionMode: plan" in e for e in errors), errors)

    def test_invalid_and_bypass_permission_modes_fail(self) -> None:
        errors = self.errors("scribe", claude_agent("scribe", tools="Read, Edit", permissionMode="yolo"))
        self.assertTrue(any("invalid permissionMode" in e for e in errors), errors)
        errors = self.errors("scribe", claude_agent("scribe", tools="Read, Edit", permissionMode="bypassPermissions"))
        self.assertTrue(any("must not be bypassPermissions" in e for e in errors), errors)

    def test_every_claude_agent_needs_explicit_tools(self) -> None:
        errors = self.errors("scribe", claude_agent("scribe", tools=None, permissionMode=None))
        self.assertTrue(any("explicit non-empty 'tools:'" in e for e in errors), errors)

    def test_model_must_be_pinned_to_haiku_or_sonnet(self) -> None:
        errors = self.errors("inspector", claude_agent("inspector", model="inherit"))
        self.assertTrue(any("must pin model" in e for e in errors), errors)

    def test_verifier_cannot_list_write_or_edit(self) -> None:
        good = claude_agent("verifier", tools="Read, Grep, Glob, Bash", permissionMode=None, disallowedTools="Write, Edit")
        self.assertEqual(self.errors("verifier", good), [])
        bad = claude_agent("verifier", tools="Read, Edit, Bash", permissionMode=None, disallowedTools="Write")
        errors = self.errors("verifier", bad)
        self.assertTrue(any("must not list Edit" in e for e in errors), errors)
        self.assertTrue(any("must list Edit in disallowedTools" in e for e in errors), errors)

    def test_description_with_colon_space_fails(self) -> None:
        errors = self.errors("inspector", claude_agent("inspector", description="Read-only: include the diff."))
        self.assertTrue(any("plain YAML scalar" in e for e in errors), errors)


class BrokenCopyTests(unittest.TestCase):
    def test_removing_tools_from_a_header_fails_write_and_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tree = Path(tmp)
            (tree / "scripts").mkdir()
            for script in (ROOT / "scripts").glob("*.py"):
                shutil.copy2(script, tree / "scripts" / script.name)
            shutil.copytree(ROOT / WS, tree / WS)
            header = tree / WS / "templates/claude/agents/inspector.header.yaml"
            lines = [line for line in header.read_text(encoding="utf-8").splitlines() if not line.startswith("tools:")]
            header.write_text("\n".join(lines) + "\n", encoding="utf-8")
            for mode in ("--write", "--check"):
                result = subprocess.run(
                    [sys.executable, "scripts/generate-agent-adapters.py", mode],
                    cwd=tree,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("explicit non-empty 'tools:'", result.stderr)


if __name__ == "__main__":
    unittest.main()
