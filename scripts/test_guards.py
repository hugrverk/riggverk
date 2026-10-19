#!/usr/bin/env python3
"""Tests for the rule engine in scripts/guards.py, on throwaway trees."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from guards import Rule, check, iter_files  # noqa: E402

GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def forbid(pattern: str, *files: str, **extra) -> Rule:
    return Rule("no-token", "forbid", pattern, files, "token must not appear", pattern, **extra)


def require(pattern: str, *files: str) -> Rule:
    return Rule("has-marker", "require", pattern, files, "marker must appear", pattern)


class GuardsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_forbid_reports_the_file_and_line(self) -> None:
        self.write("src/a.ts", "ok\nFORBIDDEN_TOKEN here\n")
        failures = check(self.root, [forbid("FORBIDDEN_TOKEN", "src/")])
        self.assertEqual(len(failures), 1)
        self.assertIn("no-token", failures[0])
        self.assertIn("src/a.ts:2:", failures[0])

    def test_forbid_passes_without_a_match(self) -> None:
        self.write("src/a.ts", "ok\n")
        self.assertEqual(check(self.root, [forbid("FORBIDDEN_TOKEN", "src/")]), [])

    def test_require_fails_when_missing_and_passes_in_any_scoped_file(self) -> None:
        self.write("src/a.ts", "nothing\n")
        self.assertIn("has-marker", check(self.root, [require("MARKER", "src/a.ts", "src/b.ts")])[0])
        self.write("src/b.ts", "MARKER\n")
        self.assertEqual(check(self.root, [require("MARKER", "src/a.ts", "src/b.ts")]), [])

    def test_a_rule_whose_files_are_missing_fails(self) -> None:
        self.write("src/a.ts", "ok\n")
        for rule in (forbid("X", "src/gone.ts"), require("X", "lib/")):
            with self.subTest(rule=rule.kind):
                self.assertIn("no file matches", check(self.root, [rule])[0])

    def test_exclude_and_globs(self) -> None:
        self.write("src/main.tsx", "FORBIDDEN_TOKEN\n")
        self.write("src/dev/mock.ts", "FORBIDDEN_TOKEN\n")
        self.write("src/view.tsx", "fine\n")
        rule = forbid("FORBIDDEN_TOKEN", "src/", exclude=("src/main.tsx", "src/dev/*"))
        self.assertEqual(check(self.root, [rule]), [])
        self.write("src/view.tsx", "FORBIDDEN_TOKEN\n")
        self.assertIn("src/view.tsx:1:", check(self.root, [rule])[0])
        self.assertIn("src/dev/mock.ts:1:", check(self.root, [forbid("FORBIDDEN_TOKEN", "src/dev/*.ts")])[0])
        self.assertIn("no file matches", check(self.root, [forbid("FORBIDDEN_TOKEN", "src/*.css")])[0])

    def test_allow_exempts_a_full_match_only(self) -> None:
        rule = forbid(r"/(Users|home)/[A-Za-z0-9._-]+", "t/", allow=r"/(Users|home)/(example|you)")
        self.write("t/a.json", '{"p": "/Users/example/x", "q": "/home/you"}\n')
        self.assertEqual(check(self.root, [rule]), [])
        self.write("t/a.json", '{"p": "/Users/example/x", "q": "/Users/examples"}\n')
        self.assertEqual(len(check(self.root, [rule])), 1)

    def test_whole_file_rule_sees_matches_across_lines(self) -> None:
        rule = Rule("pair", "forbid", r"(?s)\A(?=.*ALPHA)(?=.*OMEGA)", ("f.rs",), "pair", "ALPHA\nOMEGA", whole_file=True)
        self.write("f.rs", "ALPHA\n")
        self.assertEqual(check(self.root, [rule]), [])
        self.write("f.rs", "OMEGA\nmiddle\nALPHA\n")
        self.assertEqual(len(check(self.root, [rule])), 1)

    def test_binary_files_are_not_searched(self) -> None:
        (self.root / "bin").mkdir()
        (self.root / "bin/blob").write_bytes(b"\0FORBIDDEN_TOKEN")
        self.assertEqual(check(self.root, [forbid("FORBIDDEN_TOKEN", "bin/")]), [])

    def test_walk_skips_build_output_dirs(self) -> None:
        for rel in ("src/target/x.rs", "node_modules/p/i.js", "dist/a.js", "src/keep.rs"):
            self.write(rel, "x\n")
        self.assertEqual(iter_files(self.root), ["src/keep.rs"])

    def test_git_scope_includes_untracked_files_and_skips_ignored_ones(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.root, env=GIT_ENV, check=True)
        self.write(".gitignore", "ignored/\n")
        self.write("tracked.txt", "FORBIDDEN_TOKEN\n")
        subprocess.run(["git", "add", "tracked.txt", ".gitignore"], cwd=self.root, env=GIT_ENV, check=True)
        self.write("untracked.txt", "FORBIDDEN_TOKEN\n")
        self.write("ignored/secret.txt", "FORBIDDEN_TOKEN\n")
        files = iter_files(self.root)
        self.assertIn("tracked.txt", files)
        self.assertIn("untracked.txt", files)
        self.assertNotIn("ignored/secret.txt", files)
        failure = check(self.root, [forbid("FORBIDDEN_TOKEN", "*")])[0]
        self.assertIn("untracked.txt:1:", failure)
        self.assertNotIn("ignored/", failure)


if __name__ == "__main__":
    unittest.main()
