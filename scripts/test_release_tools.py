#!/usr/bin/env python3
"""Unit checks for the release tooling: CalVer versions, notes drafting, version bumps and the notes bundle."""

from __future__ import annotations

import base64
import contextlib
import datetime
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tools = load_module("release_tools", "release_tools.py")
generator = load_module("generate_release_notes", "generate-release-notes.py")

# Never the version in the tree, so a bump always changes something (the tree holds the release after prepare).
FAR_VERSION = "2099.1.1"
NON_CALVER_TAGS = ["app-v0.1.0", "v0.1.0-alpha", "v0.1.0-rc.1", "v2026.10.1-rc.1", "v2026.010.1", "v2026.13.1", "v2026.10.0"]


def day(text: str) -> datetime.date:
    return datetime.date.fromisoformat(text)


class NextVersionTests(unittest.TestCase):
    def test_first_release_of_the_month_starts_at_one(self) -> None:
        self.assertEqual(tools.next_version([], day("2026-10-18")), "2026.10.1")
        self.assertEqual(tools.next_version(["v2026.9.4"], day("2026-10-01")), "2026.10.1")

    def test_later_release_in_the_same_month_increments(self) -> None:
        self.assertEqual(tools.next_version(["v2026.10.1"], day("2026-10-18")), "2026.10.2")
        self.assertEqual(tools.next_version(["v2026.10.1", "v2026.10.2"], day("2026-10-30")), "2026.10.3")

    def test_counter_compares_numerically(self) -> None:
        tags = ["v2026.10.9", "v2026.10.10", "v2026.10.2"]
        self.assertEqual(tools.next_version(tags, day("2026-10-31")), "2026.10.11")
        self.assertEqual(tools.latest_tag(["v2026.9.3", "v2026.10.1"]), "v2026.10.1")

    def test_month_rolls_over_and_resets_the_counter(self) -> None:
        self.assertEqual(tools.next_version(["v2026.10.3"], day("2026-11-02")), "2026.11.1")

    def test_year_rolls_over_without_a_leading_zero(self) -> None:
        self.assertEqual(tools.next_version(["v2026.12.2"], day("2027-01-05")), "2027.1.1")

    def test_ignores_tags_that_are_not_calver(self) -> None:
        self.assertEqual(tools.next_version(NON_CALVER_TAGS, day("2026-10-18")), "2026.10.1")
        self.assertEqual(tools.next_version(NON_CALVER_TAGS + ["v2026.10.4"], day("2026-10-18")), "2026.10.5")
        self.assertIsNone(tools.latest_tag(NON_CALVER_TAGS))

    def test_a_tag_from_a_later_month_is_an_error(self) -> None:
        with self.assertRaises(tools.ReleaseError):
            tools.next_version(["v2026.11.1"], day("2026-10-18"))

    def test_versions_are_valid_semver(self) -> None:
        for version in ("2026.10.1", "2027.1.1", "2026.12.12"):
            self.assertIsNotNone(tools.parse_version(version))
        for version in ("0.1.0", "2026.10", "2026.01.1", "2026.10.01", "v2026.10.1", "2026.10.1-rc.1"):
            self.assertIsNone(tools.parse_version(version))

    def test_check_newer_requires_a_higher_calver_version(self) -> None:
        tags = ["v2026.10.2", "v0.1.0-rc.1"]
        tools.check_newer(tags, "2026.10.3")
        tools.check_newer(tags, "2026.11.1")
        for version in ("2026.10.2", "2026.10.1", "0.1.0"):
            with self.assertRaises(tools.ReleaseError, msg=version):
                tools.check_newer(tags, version)


class DraftNotesTests(unittest.TestCase):
    def test_groups_feat_and_fix_and_strips_prefixes(self) -> None:
        notes = tools.draft_notes(
            "2026.10.1",
            [
                (12, "feat(harness): manage the rules block"),
                (11, "fix(shell): type the boot lines below the traffic lights"),
                (10, "feat!: drop the legacy flag"),
                (9, "refactor(skills): install one shared SKILL.md"),
                (8, "docs: explain the release flow"),
                (7, "Retire Brain Setup"),
            ],
        )
        sections = notes.split("\n## ")
        self.assertTrue(sections[0].startswith("# Riggverk 2026.10.1"))
        by_title = {section.split("\n", 1)[0]: section for section in sections[1:]}
        self.assertEqual(list(by_title), ["New", "Fixes", "Other", "Install"])
        self.assertIn("- Manage the rules block (#12)", by_title["New"])
        self.assertIn("- Drop the legacy flag (#10)", by_title["New"])
        self.assertIn("- Type the boot lines below the traffic lights (#11)", by_title["Fixes"])
        for line in ("- Install one shared SKILL.md (#9)", "- Explain the release flow (#8)", "- Retire Brain Setup (#7)"):
            self.assertIn(line, by_title["Other"])
        for prefix in ("feat(", "feat!", "fix(", "refactor(", "docs:"):
            self.assertNotIn(prefix, notes)

    def test_sections_without_entries_are_left_out(self) -> None:
        notes = tools.draft_notes("2026.10.2", [(5, "fix(app): close the gap")])
        self.assertNotIn("## New", notes)
        self.assertNotIn("## Other", notes)
        self.assertIn("## Fixes", notes)

    def test_the_release_pr_itself_is_not_listed(self) -> None:
        notes = tools.draft_notes("2026.10.2", [(30, "chore(release): 2026.10.1"), (29, "feat(app): add a thing")])
        self.assertNotIn("2026.10.1", notes)
        self.assertIn("- Add a thing (#29)", notes)

    def test_nothing_to_release_is_an_error(self) -> None:
        with self.assertRaises(tools.ReleaseError):
            tools.draft_notes("2026.10.2", [(30, "chore(release): 2026.10.1")])
        with self.assertRaises(tools.ReleaseError):
            tools.draft_notes("2026.10.2", [])

    def test_the_install_section_carries_the_gatekeeper_hint_once(self) -> None:
        notes = tools.draft_notes("2026.10.1", [(1, "feat(app): add a thing")])
        self.assertEqual(notes.count("Open Anyway"), 1)
        self.assertIn("Riggverk-v2026.10.1-macOS.zip", notes)
        self.assertIn("Riggverk-v2026.10.1-macOS.dmg", notes)
        self.assertIn("SHA256SUMS", notes)

    def test_pr_entries_read_merge_and_squash_commits(self) -> None:
        def record(subject: str, body: str = "") -> str:
            return f"abc123\x1f{subject}\x1f{body}\x1e\n"

        log = "".join(
            [
                record("Merge pull request #41 from hugrverk/feat/x", "feat(harness): manage rules\n\nlonger text"),
                record("fix(app): squash merged one (#40)"),
                record("Merge branch 'main' into feat/y"),
                record("Direct push without a pull request"),
                record("Merge pull request #39 from hugrverk/feat/z", ""),
                record("Merge pull request #41 from hugrverk/feat/x", "feat(harness): duplicate"),
            ]
        )
        self.assertEqual(
            tools.pr_entries(log),
            [(41, "feat(harness): manage rules"), (40, "fix(app): squash merged one")],
        )

    def test_draft_from_a_real_first_parent_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env = {
                **os.environ,
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@example.invalid",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@example.invalid",
            }

            def git(*args: str) -> None:
                subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)

            def merge(number: int, branch: str, title: str) -> None:
                git("switch", "-c", branch, "main")
                (repo / f"{number}.txt").write_text(title)
                git("add", f"{number}.txt")
                git("commit", "-m", f"commit inside {branch}")
                git("switch", "main")
                git("merge", "--no-ff", branch, "-m", f"Merge pull request #{number} from o/{branch}", "-m", title)

            git("init", "-b", "main")
            git("commit", "--allow-empty", "-m", "root")
            merge(1, "feat/old", "feat(app): shipped before the tag")
            git("tag", "v2026.9.1")
            merge(2, "feat/new", "feat(app): add a thing")
            merge(3, "fix/bug", "fix(app): close the gap")
            log = tools.git_log("v2026.9.1", "HEAD", cwd=repo)
            self.assertEqual(
                tools.pr_entries(log),
                [(3, "fix(app): close the gap"), (2, "feat(app): add a thing")],
            )
            self.assertEqual(len(tools.pr_entries(tools.git_log(None, "HEAD", cwd=repo))), 3)


class VersionBumpTests(unittest.TestCase):
    FILES = (
        tools.PACKAGE_JSON,
        tools.PACKAGE_LOCK,
        tools.TAURI_CONF,
        tools.CARGO_TOML,
        tools.CARGO_LOCK,
    )

    def copy_tree(self, tmp: str) -> Path:
        root = Path(tmp)
        for relative in self.FILES:
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / relative, root / relative)
        return root

    def test_the_repository_versions_agree(self) -> None:
        self.assertTrue(tools.check_versions())

    def test_set_version_changes_only_the_version_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self.copy_tree(tmp)
            current = tools.check_versions(root=root)
            tools.set_version(FAR_VERSION, root)
            for relative in (tools.PACKAGE_JSON, tools.TAURI_CONF, tools.CARGO_TOML):
                before = (ROOT / relative).read_text(encoding="utf-8").splitlines()
                after = (root / relative).read_text(encoding="utf-8").splitlines()
                changed = [(old, new) for old, new in zip(before, after) if old != new]
                self.assertEqual(len(before), len(after), relative)
                self.assertEqual(len(changed), 1, relative)
                self.assertIn(current, changed[0][0])
                self.assertIn(FAR_VERSION, changed[0][1])
            versions = tools.read_versions(root)
            self.assertEqual(versions[tools.PACKAGE_JSON], FAR_VERSION)
            self.assertEqual(versions[tools.TAURI_CONF], FAR_VERSION)
            self.assertEqual(versions[tools.CARGO_TOML], FAR_VERSION)

    def test_check_versions_flags_files_that_disagree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self.copy_tree(tmp)
            tools.set_version(FAR_VERSION, root)
            with self.assertRaises(tools.ReleaseError) as raised:
                tools.check_versions(root=root)
            self.assertIn("differs", str(raised.exception))
            self.assertIn(tools.CARGO_LOCK, str(raised.exception))

    def test_set_version_rejects_a_version_that_is_not_calver(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self.copy_tree(tmp)
            with self.assertRaises(tools.ReleaseError):
                tools.set_version("1.2.3", root)


class NotesBundleTests(unittest.TestCase):
    NOTES = (
        "# Riggverk 2026.10.1\n\n"
        "## New\n\n- Manage the rules block (#41)\n- Show which skill copies each harness loads\n  across two lines (#34)\n\n"
        "## Fixes\n\n<!-- a comment -->\n- Close the gap\n\n"
        "## Install\n\nUnzip it. Open Anyway.\n"
    )

    def test_parse_notes_keeps_sections_and_drops_install_and_pr_numbers(self) -> None:
        release = generator.parse_notes("2026.10.1", self.NOTES)
        self.assertEqual(
            release,
            {
                "version": "2026.10.1",
                "sections": [
                    {"title": "New", "items": ["Manage the rules block", "Show which skill copies each harness loads across two lines"]},
                    {"title": "Fixes", "items": ["Close the gap"]},
                ],
            },
        )

    def test_every_parenthesized_pr_reference_is_dropped(self) -> None:
        notes = (
            "# Riggverk 2026.10.1\n\n## New\n\n"
            "- Several at once (#40, #41)\n- A range (#40–#44)\n- Before a colon (#42):\n"
            "- Wrapped (#1, #2,\n  #3)\n- Issue #5 in prose and (a note) stay\n"
        )
        self.assertEqual(
            generator.parse_notes("2026.10.1", notes)["sections"][0]["items"],
            ["Several at once", "A range", "Before a colon:", "Wrapped", "Issue #5 in prose and (a note) stay"],
        )

    def test_a_heading_for_another_version_is_refused(self) -> None:
        with self.assertRaises(generator.NotesError):
            generator.parse_notes("2026.10.1", "# Riggverk 2026.10.10\n\n## New\n\n- x\n")
        with self.assertRaises(generator.NotesError):
            generator.parse_notes("2026.10.1", "## New\n\n- x\n")

    def test_notes_without_items_are_refused(self) -> None:
        with self.assertRaises(generator.NotesError):
            generator.parse_notes("2026.10.1", "# Riggverk 2026.10.1\n\n## Install\n\nUnzip it.\n")

    def test_prose_lines_become_items(self) -> None:
        release = generator.parse_notes("2026.10.1", "# Riggverk 2026.10.1\n\nA small release.\n\n## Fixes\n\n- x\n")
        self.assertEqual(release["sections"][0], {"title": "", "items": ["A small release."]})

    def test_bundle_is_newest_first_and_only_reads_calver_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            notes_dir = Path(tmp)
            for version in ("2026.9.2", "2026.10.1", "2026.10.10", "2026.10.2"):
                (notes_dir / f"{version}.md").write_text(f"# Riggverk {version}\n\n## New\n\n- Thing {version}\n")
            versions = [release["version"] for release in json.loads(generator.build_bundle(notes_dir))["releases"]]
            self.assertEqual(versions, ["2026.10.10", "2026.10.2", "2026.10.1", "2026.9.2"])
            (notes_dir / "draft.md").write_text("# Riggverk\n")
            with self.assertRaises(generator.NotesError):
                generator.build_bundle(notes_dir)

    def run_generator(self, write: bool, notes_dir: Path, output: Path) -> tuple[int, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            code = generator.run(write, notes_dir, output)
        return code, stderr.getvalue()

    def test_check_fails_until_the_bundle_is_written_and_again_after_an_edit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            notes_dir = Path(tmp) / "release-notes"
            notes_dir.mkdir()
            output = Path(tmp) / "out" / "release-notes.json"
            (notes_dir / "2026.10.1.md").write_text(self.NOTES)
            code, message = self.run_generator(False, notes_dir, output)
            self.assertEqual(code, 1)
            self.assertIn("--write", message)
            self.assertEqual(self.run_generator(True, notes_dir, output)[0], 0)
            self.assertEqual(self.run_generator(False, notes_dir, output)[0], 0)
            (notes_dir / "2026.10.1.md").write_text(self.NOTES.replace("Close the gap", "Close the other gap"))
            self.assertEqual(self.run_generator(False, notes_dir, output)[0], 1)

    def test_the_committed_bundle_matches_release_notes(self) -> None:
        self.assertEqual(
            generator.OUTPUT.read_text(encoding="utf-8"),
            generator.build_bundle(),
            "run: python3 scripts/generate-release-notes.py --write",
        )


ON = {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Qga2V5",
    "endpoints": ["https://github.com/hugrverk/riggverk/releases/latest/download/latest.json"],
    "requireSignedVersion": True,
}


class UpdaterTests(unittest.TestCase):
    def config(self, updater: object | None) -> str | None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
            if updater is None:
                conf.pop("plugins", None)
            else:
                conf.setdefault("plugins", {})["updater"] = updater
            (root / "src-tauri").mkdir()
            (root / "src-tauri/tauri.conf.json").write_text(json.dumps(conf), encoding="utf-8")
            return tools.updater_config(root)

    def test_the_shipped_config_turns_updates_on_for_the_release_repo(self) -> None:
        self.assertEqual(tools.updater_config(), "hugrverk/riggverk")

    def test_a_complete_strict_config_names_the_release_repo(self) -> None:
        self.assertEqual(self.config(ON), "hugrverk/riggverk")
        self.assertIsNone(self.config(None))

    def test_an_incomplete_or_weakened_config_is_refused(self) -> None:
        for change in (
            {"pubkey": ""},
            {"endpoints": []},
            {"endpoints": ["http://github.com/hugrverk/riggverk/releases/latest/download/latest.json"]},
            {"endpoints": ["https://example.com/latest.json"]},
            {"requireSignedVersion": False},
            {"allowDowngrades": True},
            {"dangerousAcceptInvalidCerts": True},
            {"allow-downgrades": True},
            {"dangerous-accept-invalid-certs": True},
        ):
            with self.subTest(change=change), self.assertRaises(tools.ReleaseError):
                self.config({**ON, **change})

    def test_an_updater_in_the_macos_config_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src-tauri").mkdir()
            (root / "src-tauri/tauri.conf.json").write_text(json.dumps({"plugins": {}}), encoding="utf-8")
            (root / "src-tauri/tauri.macos.conf.json").write_text(
                json.dumps({"plugins": {"updater": ON}}), encoding="utf-8"
            )
            with self.assertRaises(tools.ReleaseError):
                tools.updater_config(root)

    def test_the_manifest_points_every_mac_at_the_universal_archive(self) -> None:
        notes = (
            "# Riggverk 2026.11.7\n\n## New\n\n- A thing (#1)\n\n## Other\n\n<!-- chores -->\n- Bump (#2)\n\n"
            "## Install\n\nOpen the disk image. Open Anyway.\n"
        )
        data = tools.updater_manifest(
            "2026.11.7", "hugrverk/riggverk", "Riggverk-v2026.11.7-macOS.app.tar.gz", "c2lnbmF0dXJl\n", notes,
            "2026-11-08T12:00:00Z",
        )
        url = "https://github.com/hugrverk/riggverk/releases/download/v2026.11.7/Riggverk-v2026.11.7-macOS.app.tar.gz"
        self.assertEqual(data["version"], "2026.11.7")
        self.assertEqual(data["pub_date"], "2026-11-08T12:00:00Z")
        self.assertEqual(
            data["platforms"],
            {
                "darwin-aarch64": {"signature": "c2lnbmF0dXJl", "url": url},
                "darwin-x86_64": {"signature": "c2lnbmF0dXJl", "url": url},
            },
        )
        self.assertIn("- A thing (#1)", data["notes"])
        self.assertNotIn("Install", data["notes"])
        self.assertNotIn("<!--", data["notes"])
        self.assertTrue(data["notes"].startswith("## New"))

    def test_the_manifest_refuses_a_bad_version_or_signature(self) -> None:
        with self.assertRaises(tools.ReleaseError):
            tools.updater_manifest("v2026.11.7", "a/b", "x.tar.gz", "sig", "", "2026-11-08T12:00:00Z")
        with self.assertRaises(tools.ReleaseError):
            tools.updater_manifest("2026.11.7", "a/b", "x.tar.gz", "line one\nline two", "", "2026-11-08T12:00:00Z")

    def test_the_manifest_points_linux_at_the_appimage(self) -> None:
        data = tools.updater_manifest(
            "2026.11.7", "hugrverk/riggverk", "Riggverk-v2026.11.7-macOS.app.tar.gz", "bWFj", "", "2026-11-08T12:00:00Z",
            "Riggverk-v2026.11.7-linux-x86_64.AppImage", "bGludXg=\n",
        )
        linux = {
            "signature": "bGludXg=",
            "url": "https://github.com/hugrverk/riggverk/releases/download/v2026.11.7/Riggverk-v2026.11.7-linux-x86_64.AppImage",
        }
        self.assertEqual(data["platforms"]["linux-x86_64"], linux)
        self.assertEqual(data["platforms"]["linux-x86_64-appimage"], linux)
        self.assertEqual(data["platforms"]["darwin-aarch64"]["signature"], "bWFj")
        self.assertNotIn("linux-x86_64-deb", data["platforms"])
        with self.assertRaises(tools.ReleaseError):
            tools.updater_manifest("2026.11.7", "a/b", "x.tar.gz", "sig", "", "2026-11-08T12:00:00Z", "x.AppImage")

    def test_the_linux_stamp_ties_the_packages_to_their_version_and_commit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            names = tools.linux_assets("2026.11.7")
            for name in names:
                (folder / name).write_text(name)
            tools.write_linux_stamp(folder, "2026.11.7", "abc123")
            tools.check_linux_stamp(folder, "2026.11.7", "abc123")
            stamp = json.loads((folder / "linux-build.json").read_text())
            self.assertEqual(sorted(stamp["files"]), sorted(names))

            for version, commit in (("2026.11.8", "abc123"), ("2026.11.7", "def456")):
                with self.subTest(version=version, commit=commit), self.assertRaises(tools.ReleaseError):
                    tools.check_linux_stamp(folder, version, commit)
            (folder / names[1]).write_text("changed")
            with self.assertRaisesRegex(tools.ReleaseError, "changed after the build"):
                tools.check_linux_stamp(folder, "2026.11.7", "abc123")
            (folder / names[1]).unlink()
            with self.assertRaisesRegex(tools.ReleaseError, "missing"):
                tools.write_linux_stamp(folder, "2026.11.7", "abc123")
            (folder / "linux-build.json").unlink()
            with self.assertRaisesRegex(tools.ReleaseError, "build-linux"):
                tools.check_linux_stamp(folder, "2026.11.7", "abc123")

    def test_the_signature_must_come_from_the_configured_key(self) -> None:
        def minisign(algorithm: bytes, key_id: bytes, rest: int) -> str:
            line = base64.b64encode(algorithm + key_id + bytes(rest)).decode()
            return base64.b64encode(f"untrusted comment: test\n{line}\n".encode()).decode()

        pubkey = minisign(b"Ed", b"KEYID-01", 32)
        tools.check_signature_key(minisign(b"ED", b"KEYID-01", 64), pubkey)
        with self.assertRaises(tools.ReleaseError):
            tools.check_signature_key(minisign(b"ED", b"KEYID-02", 64), pubkey)
        with self.assertRaises(tools.ReleaseError):
            tools.check_signature_key("not base64!", pubkey)


if __name__ == "__main__":
    unittest.main()
