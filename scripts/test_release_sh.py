#!/usr/bin/env python3
"""Checks scripts/release.sh --dry-run and its refusals in a throwaway repository.

The repository gets a bare local origin, a few merged pull requests, and stand-ins for gh, npm, cargo, codesign
and ditto, so nothing real is built, pushed or uploaded. A dry run must also leave the repository untouched.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COPIED = (
    "scripts/release.sh",
    "scripts/release_tools.py",
    "scripts/generate-release-notes.py",
    "package.json",
    "package-lock.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
)
# (file, pattern around the app version, how many matches), so the throwaway repo starts from a known version.
VERSION_LINES = (
    ("package.json", r'^(  "version": ")[^"]*(")', 1),
    ("src-tauri/tauri.conf.json", r'^(  "version": ")[^"]*(")', 1),
    ("src-tauri/Cargo.toml", r'^(version = ")[^"]*(")', 1),
    ("package-lock.json", r'("name": "riggverk",\s*"version": ")[^"]*(")', 2),
    ("src-tauri/Cargo.lock", r'(name = "riggverk"\nversion = ")[^"]*(")', 1),
)
GH_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$GH_STUB_LOG"
case "$1 $2" in
  "auth status") exit 0 ;;
  "release view")
    if [ -n "${GH_STUB_RELEASE_EXISTS:-}" ]; then echo "tag: $3"; exit 0; fi
    echo "release not found" >&2
    exit 1
    ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 3 ;;
esac
"""

today = datetime.date.today()
NEXT = f"{today.year}.{today.month}.1"


class ReleaseShTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.repo = base / "repo"
        self.origin = base / "origin.git"
        self.gh_log = base / "gh.log"
        bin_dir = base / "bin"
        bin_dir.mkdir()
        for name in ("npm", "cargo", "codesign", "ditto"):
            self.stub(bin_dir / name, "#!/usr/bin/env bash\nexit 0\n")
        self.stub(bin_dir / "gh", GH_STUB)
        (bin_dir / "python3").symlink_to(sys.executable)
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "GH_STUB_LOG": str(self.gh_log),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.invalid",
        }
        self.env.pop("CARGO_TARGET_DIR", None)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True, env=self.env)
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        for relative in COPIED:
            (self.repo / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / relative, self.repo / relative)
        self.set_versions("0.1.0")
        self.python("scripts/generate-release-notes.py", "--write")
        (self.repo / "node_modules").mkdir()
        # What npm ci records: the locked packages, as installed.
        shutil.copy(self.repo / "package-lock.json", self.repo / "node_modules/.package-lock.json")
        (self.repo / ".git/info/exclude").write_text("node_modules\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "root")
        self.merge(1, "feat/old", "feat(app): shipped earlier")
        self.git("tag", "v0.1.0-rc.1")
        self.git("tag", "app-v0.1.0")
        self.merge(2, "feat/new", "feat(app): add a thing")
        self.merge(3, "fix/bug", "fix(app): close the gap")
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "-q", "origin", "main", "--tags")

    @staticmethod
    def stub(path: Path, text: str) -> None:
        path.write_text(text)
        path.chmod(0o755)

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True, text=True
        ).stdout

    def python(self, *args: str) -> str:
        return subprocess.run(
            ["python3", *args], cwd=self.repo, env=self.env, check=True, capture_output=True, text=True
        ).stdout

    def merge(self, number: int, branch: str, title: str) -> None:
        self.git("switch", "-q", "-c", branch, "main")
        (self.repo / f"change-{number}.txt").write_text(title)
        self.git("add", f"change-{number}.txt")
        self.git("commit", "-q", "-m", f"work on {branch}")
        self.git("switch", "-q", "main")
        self.git("merge", "-q", "--no-ff", branch, "-m", f"Merge pull request #{number} from o/{branch}", "-m", title)

    def release(self, *args: str, **extra_env: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", "scripts/release.sh", *args],
            cwd=self.repo,
            env={**self.env, **extra_env},
            capture_output=True,
            text=True,
            check=False,
        )

    def snapshot(self) -> tuple[str, ...]:
        return (
            self.git("status", "--porcelain"),
            self.git("branch", "--list"),
            self.git("tag", "--list"),
            self.git("rev-parse", "HEAD"),
        )

    def gh_calls(self) -> str:
        return self.gh_log.read_text() if self.gh_log.exists() else ""

    def set_versions(self, version: str) -> None:
        for relative, pattern, count in VERSION_LINES:
            path = self.repo / relative
            path.write_text(re.sub(pattern, rf"\g<1>{version}\g<2>", path.read_text(), count=count, flags=re.MULTILINE))

    def merge_release_pr(self, version: str) -> None:
        """What a merged release PR leaves on main: bumped files, the notes and the bundle."""
        self.commit_release_branch(version)
        self.merge_release_branch(version)

    def commit_release_branch(self, version: str) -> None:
        self.set_versions(version)
        notes = self.python("scripts/release_tools.py", "draft-notes", "--version", version)
        (self.repo / "release-notes").mkdir()
        (self.repo / f"release-notes/{version}.md").write_text(notes)
        self.python("scripts/generate-release-notes.py", "--write")
        self.git("switch", "-q", "-c", f"release/v{version}", "main")
        self.git("add", ".")
        self.git("commit", "-q", "-m", f"chore(release): {version}")
        self.git("switch", "-q", "main")

    def merge_release_branch(self, version: str) -> None:
        self.git(
            "merge", "-q", "--no-ff", f"release/v{version}",
            "-m", f"Merge pull request #9 from o/release/v{version}", "-m", f"chore(release): {version}",
        )
        self.git("push", "-q", "origin", "main")

    # prepare

    def test_prepare_dry_run_plans_the_release_and_changes_nothing(self) -> None:
        before = self.snapshot()

        result = self.release("prepare", "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"next version:     {NEXT}", result.stdout)
        self.assertIn("previous release: none", result.stdout)
        self.assertIn("- Add a thing (#2)", result.stdout)
        self.assertIn("- Close the gap (#3)", result.stdout)
        self.assertIn(f"would create branch release/v{NEXT} from main", result.stdout)
        self.assertIn("would run ./scripts/release-check.sh", result.stdout)
        self.assertIn("nothing was changed", result.stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.repo / "release-notes").exists())
        self.assertNotIn("pr create", self.gh_calls())

    def test_prepare_counts_up_inside_the_month_from_the_previous_release(self) -> None:
        self.git("tag", f"v{today.year}.{today.month}.1")
        self.git("push", "-q", "origin", "--tags")
        self.merge(4, "fix/after", "fix(app): after the release")
        self.git("push", "-q", "origin", "main")

        result = self.release("prepare", "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"previous release: v{today.year}.{today.month}.1", result.stdout)
        self.assertIn(f"next version:     {today.year}.{today.month}.2", result.stdout)
        self.assertIn("- After the release (#4)", result.stdout)
        self.assertNotIn("Close the gap", result.stdout)

    def test_prepare_refuses_off_main_and_a_dry_run_still_reports_the_plan(self) -> None:
        self.git("switch", "-q", "-c", "feat/work")

        real = self.release("prepare")
        dry = self.release("prepare", "--dry-run")

        self.assertEqual(real.returncode, 1)
        self.assertIn("run this from main", real.stderr)
        self.assertNotIn("release/v", self.git("branch", "--list"))
        self.assertEqual(dry.returncode, 1)
        self.assertIn("run this from main", dry.stderr)
        self.assertIn(f"next version:     {NEXT}", dry.stdout)
        self.assertIn("1 check(s) failed", dry.stderr)

    def test_prepare_refuses_a_dirty_tree_and_a_main_that_is_not_origin_main(self) -> None:
        (self.repo / "scratch.txt").write_text("x")
        dirty = self.release("prepare")
        self.assertEqual(dirty.returncode, 1)
        self.assertIn("working tree is not clean", dirty.stderr)
        (self.repo / "scratch.txt").unlink()

        self.merge(4, "fix/unpushed", "fix(app): not pushed")
        ahead = self.release("prepare")
        self.assertEqual(ahead.returncode, 1)
        self.assertIn("main is not equal to origin/main", ahead.stderr)

    def test_prepare_refuses_a_version_that_is_already_prepared(self) -> None:
        notes = self.repo / "release-notes"
        notes.mkdir()
        (notes / f"{NEXT}.md").write_text("# draft\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "docs: stray notes")
        self.git("push", "-q", "origin", "main")

        result = self.release("prepare", "--dry-run")

        self.assertEqual(result.returncode, 1)
        self.assertIn("is prepared but not published", result.stderr)

    def test_unknown_options_and_commands_are_rejected(self) -> None:
        self.assertEqual(self.release("prepare", "--nope").returncode, 1)
        self.assertEqual(self.release("publish", "--nope").returncode, 1)
        self.assertEqual(self.release("ship").returncode, 2)

    # publish

    def test_publish_dry_run_needs_a_merged_release_pr(self) -> None:
        result = self.release("publish", "--dry-run")

        self.assertEqual(result.returncode, 1)
        self.assertIn("not a CalVer version", result.stderr)
        self.assertIn("is missing or empty", result.stderr)
        self.assertNotIn("release create", self.gh_calls())

    def test_publish_dry_run_lists_the_steps_for_a_merged_release(self) -> None:
        self.merge_release_pr(NEXT)
        before = self.snapshot()

        result = self.release("publish", "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"app version: {NEXT}", result.stdout)
        self.assertIn("main ends with the merge of the release PR", result.stdout)
        self.assertIn("npm run tauri build -- --bundles app", result.stdout)
        self.assertIn("codesign --force --deep --sign -", result.stdout)
        self.assertIn(
            f"gh release create v{NEXT} release/Riggverk-v{NEXT}-macOS.zip --title 'Riggverk {NEXT}' "
            f"--notes-file release-notes/{NEXT}.md --verify-tag",
            result.stdout,
        )
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn("release create", self.gh_calls())
        self.assertNotIn(f"v{NEXT}", self.git("ls-remote", "--tags", "origin"))

    def test_publish_refuses_an_existing_tag_or_release(self) -> None:
        self.merge_release_pr(NEXT)

        released = self.release("publish", "--dry-run", GH_STUB_RELEASE_EXISTS="1")
        self.assertEqual(released.returncode, 1)
        self.assertIn(f"GitHub release v{NEXT} already exists", released.stderr)

        self.git("tag", f"v{NEXT}")
        tagged = self.release("publish", "--dry-run")
        self.assertEqual(tagged.returncode, 1)
        self.assertIn(f"tag v{NEXT} already exists", tagged.stderr)

    def test_publish_refuses_when_main_moved_past_the_release_pr(self) -> None:
        self.merge_release_pr(NEXT)
        self.merge(10, "fix/late", "fix(app): merged after the release PR")
        self.git("push", "-q", "origin", "main")

        refused = self.release("publish", "--dry-run")
        allowed = self.release("publish", "--dry-run", "--allow-newer")

        self.assertEqual(refused.returncode, 1)
        self.assertIn("main does not end with the release PR", refused.stderr)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_publish_refuses_a_pr_merged_between_the_release_commit_and_its_merge(self) -> None:
        self.commit_release_branch(NEXT)
        self.merge(10, "fix/meanwhile", "fix(app): merged while the release PR was open")
        self.merge_release_branch(NEXT)

        refused = self.release("publish", "--dry-run")
        allowed = self.release("publish", "--dry-run", "--allow-newer")

        self.assertEqual(refused.returncode, 1)
        self.assertIn("main has changes merged after the release commit", refused.stderr)
        self.assertIn("Merge pull request #10", refused.stderr)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_publish_refuses_a_release_branch_updated_from_main(self) -> None:
        self.commit_release_branch(NEXT)
        self.merge(10, "fix/meanwhile", "fix(app): merged while the release PR was open")
        self.git("switch", "-q", f"release/v{NEXT}")
        self.git("merge", "-q", "--no-ff", "main", "-m", "Merge remote-tracking branch 'origin/main' into HEAD")
        self.git("switch", "-q", "main")
        self.merge_release_branch(NEXT)

        refused = self.release("publish", "--dry-run")

        self.assertEqual(refused.returncode, 1)
        self.assertIn("main has changes merged after the release commit", refused.stderr)

    def test_publish_refuses_a_node_modules_that_is_not_the_lock(self) -> None:
        self.merge_release_pr(NEXT)
        hidden = self.repo / "node_modules/.package-lock.json"
        locked = json.loads(hidden.read_text())
        name = next(name for name, entry in locked["packages"].items() if name and not entry.get("optional"))
        locked["packages"][name]["version"] = "0.0.0-stale"
        hidden.write_text(json.dumps(locked))

        stale = self.release("publish", "--dry-run")
        hidden.unlink()
        missing = self.release("publish", "--dry-run")

        self.assertEqual(stale.returncode, 1)
        self.assertIn(f"{name} is 0.0.0-stale", stale.stderr)
        self.assertIn("node_modules is not what package-lock.json locks", stale.stderr)
        self.assertEqual(missing.returncode, 1)
        self.assertIn("node_modules has no .package-lock.json", missing.stderr)

    def test_publish_refuses_stale_bundled_notes(self) -> None:
        self.merge_release_pr(NEXT)
        notes = self.repo / f"release-notes/{NEXT}.md"
        notes.write_text(notes.read_text().replace("Add a thing", "Add another thing"))
        self.git("add", ".")
        self.git("commit", "-q", "-m", "docs(release): edit the notes only")
        self.git("push", "-q", "origin", "main")

        result = self.release("publish", "--dry-run", "--allow-newer")

        self.assertEqual(result.returncode, 1)
        self.assertIn("bundled what's new does not match", result.stderr)


if __name__ == "__main__":
    unittest.main()
