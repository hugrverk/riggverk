#!/usr/bin/env python3
"""Tests for scripts/check-bundle-content.py.

The real tree must pass; every rule must fire on its own sample; and each group must fail on a
planted violation in a throwaway copy of the bundle.
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from guards import Rule, check  # noqa: E402

_spec = importlib.util.spec_from_file_location("check_bundle_content", SCRIPTS / "check-bundle-content.py")
assert _spec is not None and _spec.loader is not None
bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bc)

WS = Path(bc.BUNDLE)


def probe_path(rule: Rule) -> str:
    spec = rule.files[0]
    if spec.endswith("/"):
        return spec + "probe.txt"
    return spec.replace("*", "probe")


class RuleTableTests(unittest.TestCase):
    def test_every_sample_matches_its_own_pattern(self) -> None:
        for rule in bc.RULES:
            with self.subTest(rule=rule.id):
                match = re.search(rule.pattern, rule.sample)
                self.assertIsNotNone(match)
                if rule.allow:
                    self.assertIsNone(re.fullmatch(rule.allow, match.group(0)))

    def test_rule_ids_are_unique(self) -> None:
        ids = [rule.id for rule in bc.RULES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_each_rule_fires_on_its_sample(self) -> None:
        for rule in bc.RULES:
            with self.subTest(rule=rule.id), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                probe = root / probe_path(rule)
                probe.parent.mkdir(parents=True, exist_ok=True)
                probe.write_text("unrelated text\n", encoding="utf-8")
                files = bc.bundle_files(root)
                before = check(root, [rule], files)
                probe.write_text(f"unrelated text\n{rule.sample}\n", encoding="utf-8")
                after = check(root, [rule], files)
                if rule.kind == "forbid":
                    self.assertEqual(before, [])
                    self.assertEqual(len(after), 1)
                    self.assertTrue(after[0].startswith(f"{rule.id}:"), after)
                else:
                    self.assertTrue(before and before[0].startswith(f"{rule.id}:"), before)
                    self.assertEqual(after, [])


class BundleTests(unittest.TestCase):
    def test_real_tree_passes(self) -> None:
        self.assertEqual(bc.run(ROOT, list(bc.GROUPS)), [])

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = Path(self._tmp.name)
        shutil.copytree(ROOT / WS, self.tree / WS, symlinks=True)
        frozen_list = self.tree / bc.FROZEN_LIST_RS
        frozen_list.parent.mkdir(parents=True)
        shutil.copy2(ROOT / bc.FROZEN_LIST_RS, frozen_list)

    def failures(self, group: str) -> list[str]:
        return bc.run(self.tree, [group])

    def edit(self, rel: str, old: str, new: str) -> None:
        path = self.tree / WS / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def assertFails(self, group: str, needle: str) -> None:
        failures = self.failures(group)
        self.assertTrue(any(needle in failure for failure in failures), failures)

    def test_copy_passes(self) -> None:
        self.assertEqual(bc.run(self.tree, list(bc.GROUPS)), [])

    def test_hardcoded_home_directory(self) -> None:
        (self.tree / WS / "templates/leaked-home.json").write_text('{"path": "/Users/someone-else/project"}\n')
        self.assertFails("playwright", "hardcoded")

    def test_neutral_home_directory_is_allowed(self) -> None:
        (self.tree / WS / "templates/example-home.json").write_text('{"path": "/Users/example/project"}\n')
        self.assertEqual(self.failures("playwright"), [])

    def test_token_in_codex_template(self) -> None:
        self.edit("templates/codex/README.md", "\n", "\napi key sk-" + "abcdefghijklmnop1234\n")
        self.assertFails("codex", "credential-like literal: resources/default-workspace/templates/codex/README.md")

    def test_codex_defaults(self) -> None:
        self.edit("templates/codex/config.toml", 'approval_policy = "on-request"', 'approval_policy = "never"')
        path = self.tree / WS / "templates/codex/config.toml"
        path.write_text(path.read_text(encoding="utf-8") + '\n[profiles.safe]\nmodel = "x"\n', encoding="utf-8")
        failures = self.failures("codex")
        self.assertTrue(any("approval_policy" in failure for failure in failures), failures)
        self.assertTrue(any("[profiles.*]" in failure for failure in failures), failures)

    def test_missing_codex_template(self) -> None:
        (self.tree / WS / "templates/codex/mcp/playwright.toml").unlink()
        self.assertFails("codex", "missing Codex template")

    def test_symlink_in_bundle(self) -> None:
        (self.tree / WS / "docs/link.md").symlink_to("START_HERE.md")
        self.assertFails("symlinks", "symlink in the bundled workspace: resources/default-workspace/docs/link.md")

    def test_missing_agent_file(self) -> None:
        (self.tree / WS / "agents/inspector.md").unlink()
        self.assertFails("agents", "missing=['inspector.md']")

    def test_agent_model_frontmatter_and_second_primary(self) -> None:
        self.edit("agents/inspector.md", "mode: subagent", "mode: primary\nmodel: some/model")
        failures = self.failures("agents")
        self.assertTrue(any("model frontmatter" in failure for failure in failures), failures)
        self.assertTrue(any("exactly one bundled agent must be mode: primary" in failure for failure in failures), failures)

    def test_default_agent_must_be_the_primary(self) -> None:
        self.edit("templates/opencode.json", '"default_agent": "architect"', '"default_agent": "inspector"')
        self.assertFails("agents", "default_agent 'inspector'")

    def test_opencode_and_tui_defaults(self) -> None:
        self.edit("templates/opencode.json", '"snapshot": true', '"snapshot": false')
        self.assertFails("opencode-defaults", "snapshot must be True")
        self.edit("templates/tui.json", '"mouse": true', '"mouse": false')
        self.assertFails("tui-defaults", "mouse must be True")

    def test_small_model_must_match_the_docs(self) -> None:
        config = json.loads((self.tree / WS / "templates/opencode.json").read_text(encoding="utf-8"))
        self.edit("templates/opencode.json", f'"small_model": "{config["small_model"]}"', '"small_model": "other/model"')
        self.assertFails("opencode-defaults", "differs from the documented")

    def test_invalid_json(self) -> None:
        (self.tree / WS / "templates/broken.json").write_text('{"a": NaN}\n')
        self.assertFails("json", "not strict JSON: resources/default-workspace/templates/broken.json")

    def test_empty_listed_file_and_missing_doc(self) -> None:
        (self.tree / WS / "README.md").write_text("")
        (self.tree / WS / "docs/START_HERE.md").unlink()
        failures = self.failures("nonempty")
        self.assertTrue(any(failure.endswith("resources/default-workspace/README.md") for failure in failures), failures)
        self.assertTrue(any(failure.endswith("docs/START_HERE.md") for failure in failures), failures)

    def test_hand_written_opencode_header(self) -> None:
        (self.tree / WS / "templates/opencode/agents/architect.header.yaml").write_text("mode: primary\n")
        self.assertFails("opencode-headers", "architect.header.yaml")

    def test_private_context_file_dir_and_name(self) -> None:
        (self.tree / WS / "docs/USER_CONTEXT.md").write_text("notes\n")
        (self.tree / WS / "private-context").mkdir()
        self.edit("docs/CONCEPTS.md", "\n", f"\nThanks {bc.PRIVATE_NAMES[0]}.\n")
        failures = self.failures("boundary")
        self.assertTrue(any("private context file" in failure for failure in failures), failures)
        self.assertTrue(any("private context directory" in failure for failure in failures), failures)
        self.assertTrue(any(failure.startswith("[boundary] private-names:") for failure in failures), failures)

    def test_ignored_files_on_disk_are_scanned(self) -> None:
        # The app bundles the directory as it is on disk, so a gitignored file still ships.
        cache = self.tree / WS / "scripts/__pycache__"
        cache.mkdir()
        (cache / "notes.txt").write_text("PLAYWRIGHT_BROWSERS_PATH=0\n")
        self.assertFails("playwright", "playwright-browsers-path")

    def test_cursor_user_rules_wording(self) -> None:
        self.edit("templates/cursor/user-rules.md", bc.USER_RULES_PHRASES[1], "Use subagents freely")
        self.assertFails("cursor-user-rules", "cursor-user-rules-2")


if __name__ == "__main__":
    unittest.main()
