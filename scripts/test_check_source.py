#!/usr/bin/env python3
"""Tests for scripts/check-source.py.

The real tree must pass; every rule must fire on its own sample; and the structural checks
must fail on planted violations in small throwaway trees built from the real files.
"""

from __future__ import annotations

import importlib.util
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

_spec = importlib.util.spec_from_file_location("check_source", SCRIPTS / "check-source.py")
assert _spec is not None and _spec.loader is not None
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)


def probe_path(rule: Rule) -> str:
    spec = rule.files[0]
    if spec.endswith("/"):
        return spec + "probe.txt"
    return spec.replace("*", "probe")


class RuleTableTests(unittest.TestCase):
    def test_every_sample_matches_its_own_pattern(self) -> None:
        for rule in sg.RULES:
            with self.subTest(rule=rule.id):
                self.assertIsNotNone(re.search(rule.pattern, rule.sample))

    def test_rule_ids_are_unique(self) -> None:
        ids = [rule.id for rule in sg.RULES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_each_rule_fires_on_its_sample(self) -> None:
        for rule in sg.RULES:
            with self.subTest(rule=rule.id), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                probe = root / probe_path(rule)
                probe.parent.mkdir(parents=True, exist_ok=True)
                probe.write_text("unrelated text\n", encoding="utf-8")
                before = check(root, [rule])
                probe.write_text(f"unrelated text\n{rule.sample}\n", encoding="utf-8")
                after = check(root, [rule])
                if rule.kind == "forbid":
                    self.assertEqual(before, [])
                    self.assertEqual(len(after), 1)
                    self.assertTrue(after[0].startswith(f"{rule.id}:"), after)
                else:
                    self.assertTrue(before and before[0].startswith(f"{rule.id}:"), before)
                    self.assertEqual(after, [])


class SourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = Path(self._tmp.name)

    def copy(self, *rels: str) -> None:
        for rel in rels:
            dest = self.tree / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, dest)

    def write(self, rel: str, text: str) -> None:
        path = self.tree / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def edit(self, rel: str, old: str, new: str) -> None:
        path = self.tree / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_real_tree_passes(self) -> None:
        self.assertEqual(sg.run(ROOT, list(sg.GROUPS)), [])

    def test_main_window_size(self) -> None:
        self.copy("src-tauri/tauri.conf.json")
        self.assertEqual(sg.tauri_conf(self.tree), [])
        self.edit("src-tauri/tauri.conf.json", '"width": 1280', '"width": 1440')
        self.assertIn("1280x800", sg.tauri_conf(self.tree)[0])

    def test_main_window_starts_hidden(self) -> None:
        self.copy("src-tauri/tauri.conf.json")
        self.edit("src-tauri/tauri.conf.json", '"visible": false,', "")
        self.assertIn("hidden", sg.tauri_conf(self.tree)[0])

    def test_macos_window_repeats_the_main_window(self) -> None:
        self.copy("src-tauri/tauri.conf.json")
        self.copy("src-tauri/tauri.macos.conf.json")
        self.assertEqual(sg.tauri_conf(self.tree), [])
        self.edit("src-tauri/tauri.macos.conf.json", '"minWidth": 980', '"minWidth": 900')
        self.assertIn("must repeat", sg.tauri_conf(self.tree)[0])

    def test_startup_order(self) -> None:
        self.copy("src-tauri/src/lib.rs")
        self.assertEqual(sg.startup_order(self.tree), [])
        self.edit("src-tauri/src/lib.rs", "app_data_migration::run_at_startup()?;", "")
        self.assertIn("must be the first call", sg.startup_order(self.tree)[0])

    def test_shell_command_string_in_rust_and_bundled_scripts(self) -> None:
        self.write("src-tauri/src/run.rs", 'Command::new("bash").args(["-lc", script]);\n')
        self.write("resources/default-workspace/scripts/x.sh", "zsh -c 'ls'\n")
        failures = check(self.tree, sg.FORBIDDEN[:1])
        self.assertIn("resources/default-workspace/scripts/x.sh:1:", failures[0])
        self.write("src-tauri/src/run.rs", "bash -lc \"$cmd\"\n")
        self.assertIn("src-tauri/src/run.rs:1:", check(self.tree, sg.FORBIDDEN[:1])[0])

    def test_the_checker_and_its_tests_are_exempt(self) -> None:
        self.copy("scripts/check-source.py", "scripts/test_check_source.py")
        self.write("src/ok.ts", "export {};\n")
        scan = [rule for rule in sg.FORBIDDEN if rule.files == sg.SCAN_SCOPE]
        self.assertEqual(check(self.tree, scan), [])

    def test_previous_app_data_dir_only_in_release_notes(self) -> None:
        rule = next(rule for rule in sg.IDENTITY if rule.id == "legacy-app-data-dir")
        self.write("docs/RELEASE.md", "moved from ai.agentworkspace.app\n")
        self.write("README.md", "Riggverk\n")
        self.assertEqual(check(self.tree, [rule]), [])
        self.write("docs/MAINTAINING.md", "data lives in ai.agentworkspace.app\n")
        self.assertIn("docs/MAINTAINING.md:1:", check(self.tree, [rule])[0])

    def test_deleting_a_pinned_rust_regression_test_fails(self) -> None:
        self.copy("src-tauri/src/agent_targets.rs")
        rules = [rule for rule in sg.REQUIRE if rule.files == ("src-tauri/src/agent_targets.rs",)]
        self.assertEqual(check(self.tree, rules), [])
        self.edit(
            "src-tauri/src/agent_targets.rs",
            "fn bundled_config_targets_exclude_cursor_setup(",
            "fn renamed(",
        )
        failures = check(self.tree, rules)
        self.assertEqual(len(failures), 1)
        self.assertIn("rust-test-bundled_config_targets_exclude_cursor_setup", failures[0])

    def test_mock_backend_imported_outside_main(self) -> None:
        self.copy("src/main.tsx", "src/App.tsx")
        rules = [rule for rule in sg.UI if rule.id.startswith("mock-backend")]
        self.assertEqual(check(self.tree, rules), [])
        self.edit("src/App.tsx", "\n", '\nimport "./dev/mockBackend";\n')
        self.assertIn("src/App.tsx", check(self.tree, rules)[0])

    def test_license_holder_and_identity_markers(self) -> None:
        self.copy("LICENSE", "NOTICE.md", "README.md")
        rules = [rule for rule in sg.IDENTITY if rule.files[0] in ("LICENSE", "NOTICE.md")]
        self.assertEqual(check(self.tree, rules), [])
        self.write("LICENSE", f"Copyright {sg._HOLDER}\n")
        self.write("NOTICE.md", "no attribution\n")
        failures = check(self.tree, rules)
        self.assertEqual([failure.split(":")[0] for failure in failures], ["license-holder", "notice-attribution"])


if __name__ == "__main__":
    unittest.main()
