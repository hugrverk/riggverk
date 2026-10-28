#!/usr/bin/env python3
"""Tests for scripts/generate.py and the shared history walker in scripts/generate_history.py.

Set GENERATE_SLOW=1 to also run the end-to-end case: a local clone, a skill edit, `write`,
`check` before and after `git commit` and after `git commit --amend` (slow: full history walks).
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import generate_history  # noqa: E402


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look their module up while the class is built
    spec.loader.exec_module(module)
    return module


generate = load("generate_command", "generate.py")
ownership = load("generate_pre_manifest_ownership", "generate-pre-manifest-ownership.py")

GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, env=GIT_ENV, capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def captured(function, *args, **kwargs) -> tuple[object, str]:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        value = function(*args, **kwargs)
    return value, buffer.getvalue()


class RegistryTests(unittest.TestCase):
    def test_every_generator_script_is_registered_once(self) -> None:
        on_disk = sorted(path.relative_to(ROOT).as_posix() for path in SCRIPTS.glob("generate-*.py"))
        registered = [generator.script for generator in generate.REGISTRY]
        self.assertEqual(sorted(registered), on_disk)
        names = [generator.name for generator in generate.REGISTRY]
        self.assertEqual(len(names), len(set(names)))

    def test_history_generators_run_last(self) -> None:
        flags = [generator.history for generator in generate.REGISTRY]
        self.assertIn(True, flags)
        first_history = flags.index(True)
        self.assertTrue(all(flags[first_history:]), "history generators hash the others' outputs")
        names = [generator.name for generator in generate.REGISTRY]
        self.assertLess(
            names.index("opencode-config"),
            names.index("agent-adapters"),
            "agent-adapters validates against the opencode.json snapshot",
        )
        self.assertEqual(
            {g.name for g in generate.REGISTRY if g.history},
            {"rules-history", "shipped-digests", "pre-manifest-ownership"},
        )

    def test_declared_outputs_exist(self) -> None:
        for generator in generate.REGISTRY:
            outputs = generator.outputs()
            self.assertTrue(outputs, generator.name)
            for rel in outputs:
                self.assertTrue((ROOT / rel).exists(), f"{generator.name}: {rel}")

    def test_select_keeps_registry_order(self) -> None:
        names = [g.name for g in generate.select(generate.REGISTRY, ["pre-manifest-ownership", "agent-rules"], False)]
        self.assertEqual(names, ["agent-rules", "pre-manifest-ownership"])
        names = [g.name for g in generate.select(generate.REGISTRY, None, True)]
        self.assertEqual(names, [g.name for g in generate.REGISTRY if not g.history])
        with self.assertRaises(SystemExit):
            generate.select(generate.REGISTRY, ["no-such-generator"], False)
        with self.assertRaises(SystemExit):
            generate.select(generate.REGISTRY, ["shipped-digests"], True)


STUBS = {
    "ok.py": "print('fine')\n",
    "stale.py": (
        "import sys\n"
        "print('stale: out/a.txt', file=sys.stderr)\n"
        "sys.exit(1)\n"
    ),
    "message.py": "raise SystemExit('FAIL: boom')\n",
    "crash.py": "raise RuntimeError('kaput')\n",
    "marker.py": (
        "import sys\n"
        "from pathlib import Path\n"
        "root = Path(__file__).resolve().parents[1]\n"
        "(root / 'out').mkdir(exist_ok=True)\n"
        "(root / 'out' / 'marker.txt').write_text(' '.join(sys.argv[1:]))\n"
    ),
}


class AggregateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        (self.root / "scripts").mkdir()
        for name, body in STUBS.items():
            (self.root / "scripts" / name).write_text(body, encoding="utf-8")

    def stub(self, name: str, history: bool = False):
        return generate.Generator(
            name=name.removesuffix(".py"),
            script=f"scripts/{name}",
            outputs=generate.fixed("out"),
            history=history,
        )

    def runner(self, generator, flag):
        return generate.run_generator(generator, flag, root=self.root)

    def test_check_runs_every_generator_and_reports_each_failure(self) -> None:
        stubs = [self.stub(n) for n in ("ok.py", "stale.py", "message.py", "crash.py", "marker.py")]
        argv = list(sys.argv)
        code, output = captured(generate.check, stubs, runner=self.runner)
        self.assertEqual(code, 1)
        self.assertEqual(sys.argv, argv)
        self.assertIn("ok    ok\n", output)
        self.assertIn("FAIL  stale\n    stale: out/a.txt\n", output)
        self.assertIn("FAIL  message\n    FAIL: boom\n", output)
        self.assertIn("RuntimeError: kaput", output)
        self.assertIn("ok    marker\n", output)
        self.assertIn("3 of 5 generators failed: stale, message, crash", output)
        self.assertIn("fix: python3 scripts/generate.py write", output)
        self.assertEqual((self.root / "out/marker.txt").read_text(), "--check")

    def test_check_passes_when_every_generator_passes(self) -> None:
        code, output = captured(generate.check, [self.stub("ok.py"), self.stub("marker.py")], runner=self.runner)
        self.assertEqual(code, 0)
        self.assertIn("PASS: 2 generators", output)
        self.assertNotIn("fine", output)

    def test_extra_check_runs_after_a_passing_check(self) -> None:
        extra = generate.Generator(
            name="ok", script="scripts/ok.py", outputs=generate.fixed("out"),
            extra_check=lambda: (1, "twin drifted"),
        )
        code, output = captured(generate.check, [extra], runner=self.runner)
        self.assertEqual(code, 1)
        self.assertIn("FAIL  ok\n    twin drifted\n", output)

    def test_write_stops_at_the_first_failure(self) -> None:
        stubs = [self.stub("ok.py"), self.stub("stale.py"), self.stub("marker.py")]
        code, output = captured(generate.write, stubs, runner=self.runner, root=self.root)
        self.assertEqual(code, 1)
        self.assertIn("FAIL  stale", output)
        self.assertFalse((self.root / "out/marker.txt").exists())

    def test_write_reports_changed_files_and_never_commits(self) -> None:
        code, output = captured(generate.write, [self.stub("marker.py")], runner=self.runner, root=self.root)
        self.assertEqual(code, 0)
        self.assertIn("changed 1 files:\n    out/marker.txt\n", output)
        self.assertIn("never commits", output)
        code, output = captured(generate.write, [self.stub("marker.py")], runner=self.runner, root=self.root)
        self.assertEqual(code, 0)
        self.assertIn("no changes", output)


class GitRepoCase(unittest.TestCase):
    prefix = "ws/"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        run_git(self.repo, "init", "-q", "-b", "main")

    def put(self, rel: str, text: str, commit: str | None = None) -> None:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        if commit:
            run_git(self.repo, "add", "--", rel)
            run_git(self.repo, "commit", "-q", "-m", commit)

    def blob_id(self, text: str) -> str:
        result = subprocess.run(
            ["git", "hash-object", "--stdin"], cwd=self.repo, input=text, text=True,
            capture_output=True, check=True,
        )
        return result.stdout.strip()

    def by_rel(self, root: Path | None = None) -> dict[str, frozenset[str]]:
        return generate_history.historical_blobs_by_rel(self.prefix, root=root or self.repo)

    def digests(self):
        tracked = (p[len(self.prefix):] for p in generate_history.tracked_files(self.prefix, self.repo))
        return ownership.HistoricalDigests(
            by_rel=self.by_rel(),
            tracked=tracked,
            read_blob=lambda sha: generate_history.blob(sha, self.repo),
            workspace=self.repo / self.prefix,
        )


class HistoryWalkerTests(GitRepoCase):
    def test_every_committed_version_is_found_at_any_location(self) -> None:
        self.put("old/ws/skills/a/SKILL.md", "v0\n", commit="old location")
        run_git(self.repo, "rm", "-q", "-r", "old")
        self.put("ws/skills/a/SKILL.md", "v1\n", commit="v1")
        self.put("ws/skills/a/SKILL.md", "v2\n", commit="v2")
        self.put("notws/skills/a/SKILL.md", "other\n", commit="unrelated prefix")
        found = self.by_rel()["skills/a/SKILL.md"]
        self.assertEqual(found, {self.blob_id("v0\n"), self.blob_id("v1\n"), self.blob_id("v2\n")})

    def test_tracked_files_include_staged_but_not_untracked_files(self) -> None:
        self.put("ws/a.md", "a\n", commit="a")
        self.put("ws/staged.md", "s\n")
        run_git(self.repo, "add", "--", "ws/staged.md")
        self.put("ws/untracked.md", "u\n")
        self.assertEqual(generate_history.tracked_files(self.prefix, self.repo), ["ws/a.md", "ws/staged.md"])

    def test_merge_head_history_counts_during_a_merge(self) -> None:
        self.put("ws/skills/a/SKILL.md", "v1\n", commit="v1")
        run_git(self.repo, "checkout", "-q", "-b", "side")
        self.put("ws/skills/a/SKILL.md", "side only\n", commit="side v2")
        self.put("ws/skills/a/SKILL.md", "side v3\n", commit="side v3")
        run_git(self.repo, "checkout", "-q", "main")
        self.put("ws/other.md", "main\n", commit="main")
        self.assertNotIn(self.blob_id("side only\n"), self.by_rel()["skills/a/SKILL.md"])
        run_git(self.repo, "merge", "-q", "--no-commit", "--no-ff", "side")
        self.assertEqual(len(generate_history.revisions(self.repo)), 2)
        self.assertIn(self.blob_id("side only\n"), self.by_rel()["skills/a/SKILL.md"])

    def test_shallow_clone_is_refused(self) -> None:
        self.put("ws/a.md", "1\n", commit="one")
        self.put("ws/a.md", "2\n", commit="two")
        shallow = self.base / "shallow"
        run_git(self.base, "clone", "-q", "--depth", "1", self.repo.as_uri(), str(shallow))
        with self.assertRaisesRegex(RuntimeError, "shallow clone"):
            self.by_rel(root=shallow)

    def test_skill_digests_are_the_same_before_and_after_commit(self) -> None:
        rel = "skills/a/SKILL.md"
        self.put(f"ws/{rel}", "v1\n", commit="v1")
        self.put(f"ws/{rel}", "v2\n")
        before = self.digests().for_rel(rel)
        expected = ownership.shipped_digest_variants(b"v1\n") | ownership.shipped_digest_variants(b"v2\n")
        self.assertEqual(before, expected)
        run_git(self.repo, "commit", "-q", "-am", "v2")
        self.assertEqual(self.digests().for_rel(rel), before)

    def test_untracked_working_tree_files_are_not_shipped(self) -> None:
        rel = "skills/new/SKILL.md"
        self.put("ws/README.md", "start\n", commit="start")
        self.put(f"ws/{rel}", "new\n")
        self.assertEqual(self.digests().for_rel(rel), set())
        run_git(self.repo, "add", "--", f"ws/{rel}")
        self.assertEqual(self.digests().for_rel(rel), ownership.shipped_digest_variants(b"new\n"))


class SkillDigestTests(unittest.TestCase):
    def test_history_and_tracked_working_tree_versions_are_both_approved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "skills/a").mkdir(parents=True)
            (workspace / "skills/a/SKILL.md").write_bytes(b"current\n")
            blobs = {"sha-old": b"old\n"}

            def digests(tracked: set[str]) -> set[str]:
                history = ownership.HistoricalDigests(
                    by_rel={"skills/a/SKILL.md": {"sha-old"}},
                    tracked=tracked,
                    read_blob=blobs.__getitem__,
                    workspace=workspace,
                )
                return history.for_rel("skills/a/SKILL.md")

            old = ownership.shipped_digest_variants(b"old\n")
            current = ownership.shipped_digest_variants(b"current\n")
            self.assertEqual(digests({"skills/a/SKILL.md"}), old | current)
            self.assertEqual(digests(set()), old)


class WorkspaceCopyEntryTests(unittest.TestCase):
    OLD = ownership.shipped_digest_variants(b"old\n")
    CURRENT = ownership.shipped_digest_variants(b"current\n")

    def test_a_file_the_bundle_holds_is_updated_without_its_current_version(self) -> None:
        current = ownership.digest(b"current\n")
        found = ownership.workspace_copy_entry("docs/a.md", self.OLD | self.CURRENT, current)
        self.assertEqual(found["identity"], "workspace:file:docs/a.md")
        self.assertEqual(found["action"], "update")
        self.assertEqual(found["digests"], sorted((self.OLD | self.CURRENT) - {current}))

    def test_a_file_the_bundle_dropped_is_removed_with_every_shipped_version(self) -> None:
        found = ownership.workspace_copy_entry("agents/gone.md", self.OLD, None)
        self.assertEqual(found["action"], "remove")
        self.assertEqual(found["digests"], sorted(self.OLD))

    def test_a_file_with_nothing_to_approve_has_no_entry(self) -> None:
        self.assertIsNone(ownership.workspace_copy_entry("docs/a.md", set(), None))
        only_current = {ownership.digest(b"current\n")}
        self.assertIsNone(ownership.workspace_copy_entry("docs/a.md", only_current, ownership.digest(b"current\n")))

    def test_the_frozen_list_is_the_marker_and_every_retired_file(self) -> None:
        paths = ownership.workspace_copy_paths()
        self.assertEqual(paths, sorted(paths))
        self.assertEqual(paths[0], ".agent-workspace/workspace.json")  # residue-allow: the earlier marker is the frozen list's first entry
        self.assertIn("README.md", paths)
        self.assertEqual(len(paths), len(set(paths)))


class RemovedSkillInvariantTests(unittest.TestCase):
    HISTORY = (
        "skills/kept/SKILL.md",
        "skills/group/moved-kept/SKILL.md",
        "skills/gone-registered/SKILL.md",
        "skills/group/gone-unregistered/SKILL.md",
        "metadata/deprecated-skills/gone-snapshot/SKILL.md",
        "skills/kept/README.md",
        "templates/skills/claude/adapter-only/SKILL.md",
        "skills/a/b/c/SKILL.md",
    )

    def test_removed_skills_must_be_registered(self) -> None:
        unregistered = ownership.unregistered_removed_skills(
            self.HISTORY, current={"kept", "moved-kept"}, removed={"gone-registered"}
        )
        self.assertEqual(unregistered, ["gone-snapshot", "gone-unregistered"])

    def test_registered_or_never_released_removals_pass(self) -> None:
        never_released = list(ownership.NEVER_RELEASED_SKILLS)
        history = [*self.HISTORY, *(f"skills/{name}/SKILL.md" for name in never_released)]
        self.assertEqual(
            ownership.unregistered_removed_skills(
                history,
                current={"kept", "moved-kept"},
                removed={"gone-registered", "gone-unregistered", "gone-snapshot"},
            ),
            [],
        )


@unittest.skipUnless(os.environ.get("GENERATE_SLOW") == "1", "set GENERATE_SLOW=1 for the end-to-end case")
class EndToEndTests(unittest.TestCase):
    def test_skill_edit_needs_no_regenerate_after_commit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            clone = Path(tmp) / "clone"
            head = run_git(ROOT, "rev-parse", "HEAD").strip()
            run_git(Path(tmp), "clone", "-q", "--no-checkout", str(ROOT), str(clone))
            run_git(clone, "checkout", "-q", "--detach", head)
            # Test the generators of this working tree, committed or not.
            shutil.copytree(SCRIPTS, clone / "scripts", dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__"))
            run_git(clone, "add", "-A", "--", "scripts")
            run_git(clone, "commit", "-q", "--allow-empty", "-m", "generators under test")
            skill = sorted((clone / "resources/default-workspace/skills").rglob("SKILL.md"))[0]
            skill.write_text(skill.read_text(encoding="utf-8") + "\nEnd-to-end test edit.\n", encoding="utf-8")

            def generate_cli(command: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [sys.executable, str(clone / "scripts/generate.py"), command],
                    cwd=clone, env=GIT_ENV, capture_output=True, text=True, check=False,
                )

            for step in ("write", "check"):
                result = generate_cli(step)
                self.assertEqual(result.returncode, 0, f"{step}: {result.stdout}{result.stderr}")
            run_git(clone, "commit", "-q", "-am", "edit a skill")
            result = generate_cli("check")
            self.assertEqual(result.returncode, 0, f"after commit: {result.stdout}{result.stderr}")
            run_git(clone, "commit", "-q", "--amend", "-m", "edit a skill, amended")
            result = generate_cli("check")
            self.assertEqual(result.returncode, 0, f"after amend: {result.stdout}{result.stderr}")


if __name__ == "__main__":
    unittest.main()
