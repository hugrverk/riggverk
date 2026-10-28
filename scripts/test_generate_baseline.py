#!/usr/bin/env python3
"""The history generators keep their committed output as an append-only baseline.

Each case copies the tracked tree of this working tree into a temporary repository with one
commit (what a squashed export looks like) and runs scripts/generate.py there.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
METADATA = "resources/default-workspace/metadata"
DIGESTS = f"{METADATA}/shipped-digests.json"
OWNERSHIP = f"{METADATA}/pre-manifest-ownership.json"
RULES_HISTORY = f"{METADATA}/rules-history"
GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


def run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, env=GIT_ENV, capture_output=True, text=True, check=False)


def run_git(cwd: Path, *args: str) -> str:
    result = run(cwd, "git", *args)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


class SquashedRepoTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        # The working tree as the generators see it: tracked files plus new, not-ignored ones
        # (release.sh prepare adds the release notes draft before it commits).
        listed = run_git(ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0")
        for rel in filter(None, listed):
            source = ROOT / rel
            if source.is_symlink() or source.is_file():
                target = self.repo / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target, follow_symlinks=False)
        run_git(self.repo, "init", "-q", "-b", "main")
        self.commit("initial import")

    def commit(self, message: str) -> None:
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "--allow-empty", "-m", message)

    def generate(self, command: str) -> subprocess.CompletedProcess[str]:
        return run(self.repo, sys.executable, "scripts/generate.py", command)

    def assertGenerate(self, command: str) -> None:
        result = self.generate(command)
        self.assertEqual(result.returncode, 0, f"{command}: {result.stdout}{result.stderr}")

    def outputs(self) -> dict[str, bytes]:
        listed = self.generate("paths").stdout.split()
        return {rel: (self.repo / rel).read_bytes() for rel in listed}

    def load(self, rel: str):
        return json.loads((self.repo / rel).read_text(encoding="utf-8"))

    def store(self, rel: str, value: object) -> None:
        text = json.dumps(value, indent=2, sort_keys=rel == DIGESTS) + "\n"
        (self.repo / rel).write_text(text, encoding="utf-8")

    def test_fresh_history_passes_check_and_write_changes_nothing(self) -> None:
        before = self.outputs()
        self.assertGreater(len(before), 20)
        self.assertGenerate("check")
        self.assertGenerate("write")
        self.assertEqual(self.outputs(), before)

    def test_baseline_entries_the_history_cannot_prove_survive_write(self) -> None:
        lost = "sha256:" + "0" * 64
        digests = self.load(DIGESTS)
        key = sorted(digests["sources"])[0]
        digests["sources"][key] = sorted([*digests["sources"][key], lost])
        digests["sources"]["skills/retired-test/SKILL.md"] = [lost]
        self.store(DIGESTS, digests)

        ownership = self.load(OWNERSHIP)
        ownership["artifacts"][0]["digests"] = sorted([*ownership["artifacts"][0]["digests"], lost])
        ownership["artifacts"].append(
            {"identity": "removed-skill:zz-test", "path_classes": ["runtime-skill"],
             "digests": [lost], "action": "remove"}
        )
        ownership["artifacts"].sort(key=lambda value: value["identity"])
        self.store(OWNERSHIP, ownership)
        base = b"a rules base from a squashed history\n"
        name = hashlib.sha256(base).hexdigest()
        (self.repo / RULES_HISTORY / "claude" / f"{name}.md").write_bytes(base)
        self.assertGenerate("write")

        after = self.load(DIGESTS)
        self.assertEqual(after, digests)
        self.assertEqual(self.load(OWNERSHIP), ownership)
        self.assertTrue((self.repo / RULES_HISTORY / "claude" / f"{name}.md").is_file())
        self.assertIn(f"sha256:{name}", self.load(f"{RULES_HISTORY}/index.json")["harnesses"]["claude"])
        self.assertGenerate("check")

    def test_a_new_shipped_version_is_added_to_the_baseline(self) -> None:
        before = self.load(DIGESTS)
        skill = sorted((self.repo / "resources/default-workspace/skills").rglob("SKILL.md"))[0]
        key = f"skills/{skill.parent.name}/SKILL.md"
        skill.write_text(skill.read_text(encoding="utf-8") + "\nA new shipped line.\n", encoding="utf-8")
        self.commit("edit a skill")
        self.assertGenerate("write")

        added = "sha256:" + hashlib.sha256(skill.read_bytes()).hexdigest()
        after = self.load(DIGESTS)
        self.assertIn(added, after["sources"][key])
        self.assertLessEqual(set(before["sources"][key]), set(after["sources"][key]))
        entry = next(a for a in self.load(OWNERSHIP)["artifacts"] if a["identity"] == f"skill:{skill.parent.name}")
        self.assertIn(added, entry["digests"])
        self.assertGenerate("check")


if __name__ == "__main__":
    unittest.main()
