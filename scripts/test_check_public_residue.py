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
# The pragma words too, so this file is not read as holding a pragma.
ALLOW, BEGIN, END = "residue-" "allow", "residue-" "allow-" "begin", "residue-" "allow-" "end"
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
            f"<!-- {BEGIN}: upgrade notes -->\n"
            f"The folder `{A}-{W}` moves.\n"
            f"<!-- {END} -->\n"
            f"after the block: {A}-{W}\n"
            f"seed: {A}-{W}  # {ALLOW}: seeds the earlier layout\n"
        )
        found = self.scan({"README.md": text})
        self.assertEqual(len(found), 1, found)
        self.assertTrue(found[0].startswith("README.md:4:"), found)

    def test_a_block_does_not_leak_into_the_next_file(self) -> None:
        files = {
            "a.md": f"<!-- {BEGIN}: x -->\n",
            "b.md": f"{A}-{W}\n",
        }
        found = self.scan(files)
        self.assertEqual(len(found), 2, found)
        self.assertTrue(any(hit.startswith("b.md:1:") for hit in found), found)

    def test_a_legacy_constant_is_a_whole_identifier(self) -> None:
        for text in (f"NOT_LEGACY_STATE = '{A}-{W}'", f"LEGACY_ = '{A}-{W}'", f"x = LEGACY_state + '{A}-{W}'"):
            with self.subTest(text=text):
                self.assertEqual(len(self.scan({"a.py": text + "\n"})), 1)
        self.assertEqual(self.scan({"a.py": f"LEGACY_STATE_2 = '{A}-{W}'\n"}), [])

    def test_a_block_without_its_end_fails(self) -> None:
        found = self.scan({"README.md": f"<!-- {BEGIN}: notes -->\nplain text\n"})
        self.assertEqual(len(found), 1, found)
        self.assertIn(f"no {END}", found[0])
        self.assertTrue(found[0].startswith("README.md:1:"), found)

    def test_a_pragma_inside_a_string_does_nothing(self) -> None:
        text = (
            f'BEGIN = "{BEGIN}"\n'
            f"folder = '{A}-{W}'\n"
            f'SKIP = "{ALLOW}"\n'
            f"other = '{A}-{W}'\n"
        )
        self.assertEqual(len(self.scan({"tool.py": text})), 2)

    def test_a_pragma_in_each_comment_syntax_counts(self) -> None:
        files = {
            "a.sh": f"echo {A}-{W}  # {ALLOW}: seed\n",
            "b.ts": f"const x = '{A}-{W}'; // {ALLOW}: fixture\n",
            "c.md": f"<!-- {BEGIN}: x -->\n{A}-{W}\n<!-- {END} -->\n",
            "d.css": f"/* {BEGIN} */\n.{A}-{W} {{}}\n/* {END} */\n",
        }
        self.assertEqual(self.scan(files), [])

    def test_swedish_in_a_skill_description_fails_but_not_in_the_body(self) -> None:
        skill = "resources/default-workspace/skills/demo/SKILL.md"
        found = self.scan({skill: "---\nname: demo\ndescription: Use when asked (\"kör demo\").\n---\n"})
        self.assertEqual(len(found), 1, found)
        self.assertTrue(found[0].startswith(f"{skill}:3:"), found)
        self.assertEqual(self.scan({skill: "---\nname: demo\ndescription: Use when asked.\n---\nSwedish: \"kör demo\".\n"}), [])
        self.assertEqual(self.scan({"docs/NOTES.md": "description: kör\n"}), [])

    def test_owner_specific_rules_text_fails_outside_the_history(self) -> None:
        for text in ("Prefer rtk for reads.", "Codex is cheap, so delegate.", "Never while a GPT computer-use agent runs."):
            with self.subTest(text=text):
                found = self.scan({"resources/default-workspace/templates/rules/claude.md": text + "\n"})
                self.assertEqual(len(found), 1, found)
        history = {"resources/default-workspace/metadata/rules-history/claude/x.md": "Prefer rtk for reads.\n"}
        self.assertEqual(self.scan(history), [])
        self.assertEqual(self.scan({"resources/default-workspace/skills/a/SKILL.md": "The artkit and smartkey words.\n"}), [])

    def test_a_model_id_in_skill_text_fails(self) -> None:
        found = self.scan({"resources/default-workspace/skills/a/SKILL.md": "critic=codex/gpt-6.1-terra\n"})
        self.assertEqual(len(found), 1, found)
        self.assertEqual(self.scan({"resources/default-workspace/skills/a/SKILL.md": "critic=codex/<model>\n"}), [])
        self.assertEqual(self.scan({"resources/default-workspace/docs/CODEX_CONFIG.md": "model gpt-6.1-terra\n"}), [])

    def test_a_real_looking_home_path_fails_and_placeholders_pass(self) -> None:
        users = "/Users/"  # split so this file holds no path of its own
        for text in (users + "jane/project", "C:\\" + "Users\\jane\\app", "/home/" + "jane/x"):
            with self.subTest(text=text):
                self.assertEqual(len(self.scan({"src/a.ts": text + "\n"})), 1)
        placeholders = users + "example/x /home/someone/y C:/Users/Example/z\n"
        self.assertEqual(self.scan({"src/a.ts": placeholders}), [])

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
