#!/usr/bin/env python3
"""The public residue guard fires on a planted retired name, honours its allowlist, and the tree is clean."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"

_spec = importlib.util.spec_from_file_location("check_public_residue", SCRIPTS / "check-public-residue.py")
assert _spec is not None and _spec.loader is not None
guard = importlib.util.module_from_spec(_spec)
sys.modules["check_public_residue"] = guard  # dataclasses look their module up while the class is built
_spec.loader.exec_module(guard)

# Built from fragments so this file does not itself hold the names the guard bans.
A, W = "agent", "workspace"
SPELLINGS = (
    f"{A}-{W}",
    f"{A}_{W}",
    f"{A.upper()}_{W.upper()}",
    f"{A.upper()}-{W.upper()}",
    f"{A.capitalize()}{W.capitalize()}",
    f"{A.capitalize()} {W.capitalize()}",
)


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class ResidueGuardTests(unittest.TestCase):
    def scan(self, files: dict[str, str]) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel, text in files.items():
                write(root, rel, text)
            return guard.scan(root)

    def test_a_planted_name_fails_in_every_spelling(self) -> None:
        for spelling in SPELLINGS:
            with self.subTest(spelling=spelling):
                found = self.scan({"src/app.ts": f"const folder = '{spelling}';\n"})
                self.assertEqual(len(found), 1, found)
                self.assertTrue(found[0].startswith("src/app.ts:1:"), found)

    def test_a_clean_tree_passes(self) -> None:
        self.assertEqual(self.scan({"src/app.ts": "const folder = 'riggverk';\n", "README.md": "# Riggverk\n"}), [])

    def test_a_file_name_is_checked_too(self) -> None:
        found = self.scan({f"docs/{A.upper()}_{W.upper()}_LEDGER.md": "# Ledger\n"})
        self.assertEqual(len(found), 1, found)
        self.assertIn("file name", found[0])

    def test_a_legacy_constant_may_name_it(self) -> None:
        line = f'pub const LEGACY_STATE_DIR: &str = ".{A}-{W}";\n'
        self.assertEqual(self.scan({"src-tauri/src/layout.rs": line}), [])
        self.assertEqual(len(self.scan({"src-tauri/src/layout.rs": line.replace("LEGACY_", "EARLIER_")})), 1)

    def test_the_previous_app_id_may_stay(self) -> None:
        self.assertEqual(self.scan({"src/x.rs": f'const X: &str = "ai.{A}{W}.app";\n'}), [])

    def test_history_and_release_notes_may_name_it(self) -> None:
        text = f"BEGIN {A.upper()}-{W.upper()} BASE\n"
        files = {
            "resources/default-workspace/metadata/rules-history/claude/x.md": text,
            "release-notes/2026.10.1.md": text,
            "src/generated/release-notes.json": text,
            "docs/RELEASE.md": text,
        }
        self.assertEqual(self.scan(files), [])

    def test_a_marked_block_and_a_marked_line_may_name_it(self) -> None:
        text = (
            "<!-- residue-allow-begin: upgrade notes -->\n"
            f"The folder `{A}-{W}` moves.\n"
            "<!-- residue-allow-end -->\n"
            f"after the block: {A}-{W}\n"
            f"seed: {A}-{W}  # residue-allow: seeds the earlier layout\n"
        )
        found = self.scan({"README.md": text})
        self.assertEqual(len(found), 1, found)
        self.assertTrue(found[0].startswith("README.md:4:"), found)

    def test_a_block_does_not_leak_into_the_next_file(self) -> None:
        files = {
            "a.md": "<!-- residue-allow-begin: x -->\n",
            "b.md": f"{A}-{W}\n",
        }
        self.assertEqual(len(self.scan(files)), 1)

    def test_the_allowlist_gives_a_reason_for_every_entry(self) -> None:
        for residue in guard.RESIDUES:
            for allowed in residue.allowed_paths:
                self.assertTrue(allowed.reason.strip(), allowed.spec)
            for _, reason in residue.allowed_lines:
                self.assertTrue(reason.strip())

    def test_the_repository_tree_is_clean(self) -> None:
        self.assertEqual(guard.scan(ROOT), [])


if __name__ == "__main__":
    unittest.main()
