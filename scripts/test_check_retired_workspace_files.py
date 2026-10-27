#!/usr/bin/env python3
"""Tests for scripts/check-retired-workspace-files.py and scripts/retired_workspace_files.py.

The real tree must pass, and each rule must fail on a planted violation in a throwaway copy of
the Rust module and the bundle.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import retired_workspace_files as frozen  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "check_retired_workspace_files", SCRIPTS / "check-retired-workspace-files.py"
)
assert _spec is not None and _spec.loader is not None
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

FIRST = '    "README.md",\n'
RETIRED_HEAD = "const RETIRED_FROM_BUNDLE: &[&str] = &[\n"


class ParserTests(unittest.TestCase):
    def test_reads_the_marker_the_files_and_the_documented_retirements(self) -> None:
        text = (
            'pub(crate) const LEGACY_MARKER_REL: &str = ".m/workspace.json";\n'
            "pub(crate) const RETIRED_WORKSPACE_FILES: &[&str] = &[\n"
            '    "a.md",\n'
            '    // "commented-out.md",\n'
            '    "b/c.json", // trailing "note.md"\n'
            "];\n"
            "const RETIRED_FROM_BUNDLE: &[&str] = &[\n"
            '    "b/c.json",\n'
            "];\n"
        )
        listed = frozen.parse(text)
        self.assertEqual(listed.marker, ".m/workspace.json")
        self.assertEqual(listed.files, ("a.md", "b/c.json"))
        self.assertEqual(listed.retired_from_bundle, ("b/c.json",))
        self.assertEqual(listed.copy_paths(), (".m/workspace.json", "a.md", "b/c.json"))

    def test_a_missing_list_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            frozen.parse('const LEGACY_MARKER_REL: &str = "m";\n')

    def test_the_real_list_is_sorted_with_the_marker_first(self) -> None:
        paths = frozen.load(ROOT).copy_paths()
        self.assertEqual(list(paths), sorted(paths))


class CheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = Path(self._tmp.name)
        for rel in ("src-tauri/src/commands.rs", frozen.RUST_MODULE):
            (self.tree / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, self.tree / rel)
        shutil.copytree(ROOT / check.BUNDLE, self.tree / check.BUNDLE, symlinks=True)

    def failures(self) -> list[str]:
        return check.errors(self.tree)

    def edit_module(self, old: str, new: str) -> None:
        path = self.tree / frozen.RUST_MODULE
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def assertFails(self, needle: str) -> None:
        failures = self.failures()
        self.assertTrue(any(needle in failure for failure in failures), failures)

    def test_real_tree_passes(self) -> None:
        self.assertEqual(check.errors(ROOT), [])

    def test_copy_passes(self) -> None:
        self.assertEqual(self.failures(), [])

    def test_unsorted_list(self) -> None:
        self.edit_module(FIRST, '    "zzz.md",\n' + FIRST)
        self.assertFails("must be sorted")

    def test_duplicate_entry(self) -> None:
        self.edit_module(FIRST, FIRST + FIRST)
        self.assertFails("lists a path twice")

    def test_marker_in_the_list(self) -> None:
        self.edit_module(FIRST, '    ".agent-workspace/workspace.json",\n' + FIRST)
        self.assertFails("stays canonical")

    def test_state_and_user_data_are_never_listed(self) -> None:
        self.edit_module(FIRST, FIRST + '    "docs/context/notes.md",\n')
        self.assertFails("state or user data: docs/context/notes.md")

    def test_listed_file_missing_from_the_bundle(self) -> None:
        (self.tree / check.BUNDLE / "docs/START_HERE.md").unlink()
        self.assertFails("not in the bundle and not documented as retired: docs/START_HERE.md")

    def test_documented_retirement_of_a_file_the_bundle_still_holds(self) -> None:
        self.edit_module(RETIRED_HEAD, RETIRED_HEAD + '        "README.md",\n')
        self.assertFails("documented as retired from the bundle, but the bundle holds it: README.md")

    def test_documented_retirement_of_a_file_that_is_not_listed(self) -> None:
        self.edit_module(RETIRED_HEAD, RETIRED_HEAD + '        "nope.md",\n')
        self.assertFails("names a path that is not listed: nope.md")

    def test_tag_only_files_are_listed_and_documented_as_retired(self) -> None:
        listed = frozen.load(self.tree)
        self.assertIn("scripts/bootstrap.sh", listed.files)
        self.assertIn("scripts/bootstrap.sh", listed.retired_from_bundle)
        self.assertFalse((self.tree / check.BUNDLE / "scripts/bootstrap.sh").exists())

    def test_required_helper_asset_missing_from_the_bundle(self) -> None:
        (self.tree / check.BUNDLE / "scripts/merge-codex-config.py").write_text("")
        self.assertFails("required runtime asset missing or empty in the bundle: scripts/merge-codex-config.py")

    def test_old_manifest_must_stay_deleted(self) -> None:
        old = self.tree / check.OLD_MANIFEST
        old.write_text("// old\n")
        self.assertFails("must stay deleted")

    def test_old_names_must_not_come_back(self) -> None:
        extra = self.tree / "src-tauri/src/other.rs"
        extra.write_text("fn f() { default_workspace_files(); }\n")
        self.assertFails("src-tauri/src/other.rs still refers to default_workspace_files")


if __name__ == "__main__":
    unittest.main()
