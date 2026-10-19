#!/usr/bin/env python3
"""Regression tests for collection-count lint and the canonical agent lists."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
WS = Path("resources/default-workspace")
SPEC = importlib.util.spec_from_file_location("docs_drift", ROOT / "scripts/check-readme-docs-drift.py")
assert SPEC and SPEC.loader
drift = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(drift)


class CountLintTests(unittest.TestCase):
    def test_collection_counts_fail(self) -> None:
        for claim in (
            "25 skills", "**25** canonical semantic skills", "24 starter skills",
            "six Markdown agents", "four TOML agents", "five native subagents",
            "six global agents", "seven harnesses", "four central harnesses",
            "five read-only subagent roles", "28 bundled skills", "24 generic skills",
        ):
            with self.subTest(claim=claim):
                errors = drift.count_claims("README.md", f"Title\n{claim}\n")
                self.assertEqual(len(errors), 1)
                self.assertIn("README.md:2: hard-coded collection count:", errors[0])

    def test_limits_and_variable_samples_pass(self) -> None:
        self.assertEqual(drift.count_claims(
            "README.md", "64 files, 2 MiB, four path levels; N skills, 1 copy each; One SKILL.md per harness",
        ), [])

    def test_fixed_behavior_allowlist_is_path_and_phrase_specific(self) -> None:
        path = "resources/default-workspace/docs/SKILLS.md"
        phrase = "two-agent implementation"
        self.assertEqual(drift.count_claims(path, phrase), [])
        self.assertTrue(drift.count_claims("README.md", phrase))
        errors = drift.count_claims(path, f"{phrase}; 25 skills")
        self.assertEqual(len(errors), 1)
        self.assertIn("25 skills", errors[0])

    def test_fixed_installation_behavior_passes(self) -> None:
        self.assertEqual(drift.count_claims("docs/WORKSPACE_CONTRACT.md", "one skill in one folder"), [])
        path = "resources/default-workspace/docs/SKILLS.md"
        for phrase in ("two harnesses both read", "one skill is not listed twice", "one skills folder"):
            with self.subTest(phrase=phrase):
                self.assertEqual(drift.count_claims(path, phrase), [])


class AgentListTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tree = Path(tmp.name)
        for rel in (
            WS / "metadata/agents.json",
            WS / "metadata/agent-adapters.json",
            WS / "templates/cursor/manifest.json",
            WS / "docs/AGENT_RULES.md",
        ):
            dest = self.tree / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, dest)
        self.contract = (ROOT / "docs/WORKSPACE_CONTRACT.md").read_text(encoding="utf-8")
        root_patch = patch.object(drift, "ROOT", self.tree)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def assert_fails(self, message: str) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            drift.validate_agent_lists(self.contract)
        self.assertEqual(raised.exception.code, 1)
        self.assertIn(message, stderr.getvalue())

    def test_baseline_passes(self) -> None:
        drift.validate_agent_lists(self.contract)

    def test_missing_documented_agent_fails(self) -> None:
        self.contract = self.contract.replace("- Claude Code: `repo-scout`, ", "- Claude Code: ", 1)
        self.assert_fails("Agents lists must match")

    def test_extra_documented_agent_fails(self) -> None:
        self.contract = self.contract.replace("- Cursor: `repo-scout`", "- Cursor: `unknown-agent`, `repo-scout`", 1)
        self.assert_fails("Agents lists must match")

    def test_duplicate_harness_list_fails(self) -> None:
        self.contract = self.contract.replace("## Agents\n", "## Agents\n\n- Cursor: `unknown-agent`.\n", 1)
        self.assert_fails("Agents lists must match")

    def test_codex_uses_native_output_basename(self) -> None:
        self.contract = self.contract.replace("`security_reviewer`", "`sentinel`")
        self.assert_fails("Agents lists must match")

    def test_metadata_and_adapter_targets_must_agree(self) -> None:
        path = self.tree / WS / "metadata/agents.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["agents"]["architect.md"]["targets"].append("claude")
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assert_fails("Claude Code: agents.json and agent-adapters.json roles differ")

    def test_cursor_manifest_addition_requires_documentation(self) -> None:
        path = self.tree / WS / "templates/cursor/manifest.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["agents"].append("unknown-agent.md")
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assert_fails("Agents lists must match")

    def test_cursor_rules_list_is_checked_in_both_directions(self) -> None:
        path = self.tree / WS / "docs/AGENT_RULES.md"
        original = path.read_text(encoding="utf-8")
        for replacement in ("", "- browser-qa\n- unknown-agent\n"):
            with self.subTest(replacement=replacement):
                modified = original.replace("- browser-qa\n", replacement, 1)
                path.write_text(modified, encoding="utf-8")
                self.assert_fails("AGENT_RULES.md Cursor list must match")


if __name__ == "__main__":
    unittest.main()
