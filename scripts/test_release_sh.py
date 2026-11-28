#!/usr/bin/env python3
"""Checks scripts/release.sh --dry-run and its refusals in a throwaway repository.

The repository gets a bare local origin, a few merged pull requests, and stand-ins for gh, npm, cargo, rustup,
codesign, ditto, hdiutil, lipo, security (the Keychain), uname, podman and scripts/linux-build.sh, so nothing real is
built, pushed, uploaded or read from the Keychain. A dry run must also leave the repository untouched.
"""

from __future__ import annotations

import datetime
import hashlib
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
# GitHub releases are folders in $GH_STUB_RELEASES, one per tag, holding the uploaded files. Attestations are lines
# "<sha256 of the file> <commit the workflow ran at>" in $GH_STUB_ATTESTATIONS, all from the release build workflow.
GH_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$GH_STUB_LOG"
[ -z "${TAURI_SIGNING_PRIVATE_KEY+set}${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ] || echo "gh saw the signing key" >>"$GH_STUB_LOG"
release="$GH_STUB_RELEASES/${3:-}"
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo "o/riggverk" ;;
  "attestation verify")
    file="$3"
    shift 3
    repo="" workflow="" digest="" hosted=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo) repo="$2"; shift ;;
        --signer-workflow) workflow="$2"; shift ;;
        --source-digest) digest="$2"; shift ;;
        --deny-self-hosted-runners) hosted=1 ;;
      esac
      shift
    done
    [ "$repo" = "o/riggverk" ] && [ -n "$hosted" ] || exit 1
    [ "$workflow" = "o/riggverk/.github/workflows/linux-release-build.yml" ] || exit 1
    sum="$(shasum -a 256 "$file" | cut -d' ' -f1)"
    grep -qxF "$sum $digest" "$GH_STUB_ATTESTATIONS" 2>/dev/null || exit 1
    ;;
  "release view")
    if [ -n "${GH_STUB_RELEASE_EXISTS:-}" ] || [ -d "$release" ]; then echo "tag: $3"; exit 0; fi
    echo "release not found" >&2
    exit 1
    ;;
  "release create")
    mkdir -p "$release"
    shift 3
    for arg in "$@"; do
      if [ -f "$arg" ]; then cp "$arg" "$release/"; fi
    done
    ;;
  "release delete")
    [ -d "$release" ] || { echo "release not found" >&2; exit 1; }
    rm -rf "$release"
    ;;
  "release download")
    [ -d "$release" ] || { echo "release not found" >&2; exit 1; }
    shift 3
    out=.
    patterns=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) out="$2"; shift ;;
        --pattern) patterns+=("$2"); shift ;;
      esac
      shift
    done
    mkdir -p "$out"
    for pattern in "${patterns[@]}"; do
      if [ -f "$release/$pattern" ]; then cp "$release/$pattern" "$out/"; fi
    done
    ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 3 ;;
esac
"""

# The build: records which signing variables it was given. It makes no app, so a real publish stops right after it.
NPM_STUB = """#!/usr/bin/env bash
printf '%s|%s|%s\\n' "$*" "${TAURI_SIGNING_PRIVATE_KEY-unset}" "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-unset}" >>"$NPM_STUB_LOG"
"""

RUSTUP_STUB = """#!/usr/bin/env bash
printf '%s\\n' aarch64-apple-darwin ${RUSTUP_STUB_TARGETS-x86_64-apple-darwin}
"""

# The Keychain: `security find-generic-password -s ITEM -w` prints a stand-in secret for the items named in
# SECURITY_STUB_ITEMS and fails like a missing item otherwise.
SECURITY_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$SECURITY_STUB_LOG"
[ "$1 $2" = "find-generic-password -s" ] || { echo "security stub: unexpected call: $*" >&2; exit 3; }
case " ${SECURITY_STUB_ITEMS-} " in
  *" $3 "*) printf 'stub-secret-%s\\n' "$3" ;;
  *) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44 ;;
esac
"""
KEYCHAIN_ITEMS = "riggverk-updater-key riggverk-updater-password"

# build-linux runs on Linux x86_64 only; the tests run on macOS too.
UNAME_STUB = """#!/usr/bin/env bash
case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) exit 1 ;; esac
"""

# The container build: the three packages under the bundler's names in --out, for the version tauri.conf.json says.
LINUX_BUILD_STUB = """#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "--out" ]
version="$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
mkdir -p "$2"
for name in "Riggverk_${version}_amd64.AppImage" "Riggverk_${version}_amd64.deb" "Riggverk-${version}-1.x86_64.rpm"; do
  printf 'package %s\\n' "$name" >"$2/$name"
done
echo "linux-build stub ran" >>"$LINUX_BUILD_STUB_LOG"
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
        self.gh_releases = base / "releases"
        self.gh_releases.mkdir()
        self.gh_attestations = base / "attestations"
        bin_dir = base / "bin"
        bin_dir.mkdir()
        for name in ("cargo", "codesign", "ditto", "hdiutil", "lipo", "podman"):
            self.stub(bin_dir / name, "#!/usr/bin/env bash\nexit 0\n")
        self.stub(bin_dir / "npm", NPM_STUB)
        self.npm_log = base / "npm.log"
        self.stub(bin_dir / "rustup", RUSTUP_STUB)
        self.stub(bin_dir / "gh", GH_STUB)
        self.stub(bin_dir / "security", SECURITY_STUB)
        self.security_log = base / "security.log"
        self.stub(bin_dir / "uname", UNAME_STUB)
        self.linux_build_log = base / "linux-build.log"
        # publish finds Linux packages of HEAD in release/linux unless a test turns this off.
        self.linux_packages = True
        # Throwaway SSH keys: the builder is listed in scripts/linux-build-signers, the outsider is not.
        self.signing_key = base / "builder"
        self.outsider_key = base / "outsider"
        for key in (self.signing_key, self.outsider_key):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", key.name, "-f", str(key)], check=True)
        (bin_dir / "python3").symlink_to(sys.executable)
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "GH_STUB_LOG": str(self.gh_log),
            "GH_STUB_RELEASES": str(self.gh_releases),
            "GH_STUB_ATTESTATIONS": str(self.gh_attestations),
            "SECURITY_STUB_LOG": str(self.security_log),
            "NPM_STUB_LOG": str(self.npm_log),
            "LINUX_BUILD_STUB_LOG": str(self.linux_build_log),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.invalid",
        }
        self.env.pop("CARGO_TARGET_DIR", None)
        for name in ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"):
            self.env.pop(name, None)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True, env=self.env)
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        for relative in COPIED:
            (self.repo / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / relative, self.repo / relative)
        # Start with updates off whatever the repository ships; turn_updates_on() switches them on.
        conf_path = self.repo / "src-tauri/tauri.conf.json"
        conf = json.loads(conf_path.read_text())
        conf.pop("plugins", None)
        conf_path.write_text(json.dumps(conf, indent=2) + "\n")
        self.stub(self.repo / "scripts/linux-build.sh", LINUX_BUILD_STUB)
        builder = (base / "builder.pub").read_text().split()
        (self.repo / "scripts/linux-build-signers").write_text(
            f'builder namespaces="riggverk-linux-build" {builder[0]} {builder[1]}\n'
        )
        self.set_versions("0.1.0")
        self.python("scripts/generate-release-notes.py", "--write")
        (self.repo / "node_modules").mkdir()
        # What npm ci records: the locked packages, as installed.
        shutil.copy(self.repo / "package-lock.json", self.repo / "node_modules/.package-lock.json")
        (self.repo / ".git/info/exclude").write_text("node_modules\nrelease/\n")
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
        if args[0] == "publish" and self.linux_packages:
            self.add_linux_packages()
        return subprocess.run(
            ["bash", "scripts/release.sh", *args],
            cwd=self.repo,
            env={**self.env, **extra_env},
            capture_output=True,
            text=True,
            check=False,
        )

    def add_linux_packages(self, commit: str = "HEAD", key: Path | None = None) -> None:
        """What build-linux leaves in release/linux for the current version, stamped with `commit` and signed."""
        version = json.loads((self.repo / "src-tauri/tauri.conf.json").read_text())["version"]
        if not re.match(r"^\d{4}\.", version):
            return
        linux = self.repo / "release/linux"
        linux.mkdir(parents=True, exist_ok=True)
        for name in (
            f"Riggverk-v{version}-linux-x86_64.AppImage",
            f"Riggverk-v{version}-linux-amd64.deb",
            f"Riggverk-v{version}-linux-x86_64.rpm",
        ):
            (linux / name).write_text(f"package {name}\n")
        self.python(
            "scripts/release_tools.py", "linux-stamp", "write", "--dir", "release/linux", "--version", version,
            "--commit", self.git("rev-parse", commit).strip(),
        )
        self.sign_stamp(key or self.signing_key)

    def sign_stamp(self, key: Path) -> None:
        stamp = self.repo / "release/linux/linux-build.json"
        Path(f"{stamp}.sig").unlink(missing_ok=True)
        subprocess.run(
            ["ssh-keygen", "-Y", "sign", "-q", "-f", str(key), "-n", "riggverk-linux-build", str(stamp)], check=True
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
        self.assertIn("npm run tauri build -- --target universal-apple-darwin --bundles app,dmg", result.stdout)
        self.assertIn("codesign --verify --deep --strict", result.stdout)
        self.assertNotIn("codesign --force", result.stdout)
        self.assertIn(f"release/Riggverk-v{NEXT}-macOS.dmg, then hdiutil verify", result.stdout)
        self.assertIn(f"release/linux holds the AppImage, deb and rpm of {NEXT}, built from HEAD", result.stdout)
        self.assertIn(
            f"gh release create v{NEXT} release/Riggverk-v{NEXT}-macOS.dmg release/Riggverk-v{NEXT}-macOS.zip "
            f"release/linux/Riggverk-v{NEXT}-linux-x86_64.AppImage release/linux/Riggverk-v{NEXT}-linux-amd64.deb "
            f"release/linux/Riggverk-v{NEXT}-linux-x86_64.rpm "
            f"release/SHA256SUMS --title 'Riggverk {NEXT}' --notes-file release-notes/{NEXT}.md --verify-tag",
            result.stdout,
        )
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn("release create", self.gh_calls())
        self.assertNotIn(f"v{NEXT}", self.git("ls-remote", "--tags", "origin"))

    def test_publish_needs_both_rust_targets_for_the_universal_build(self) -> None:
        self.merge_release_pr(NEXT)

        result = self.release("publish", "--dry-run", RUSTUP_STUB_TARGETS="")

        self.assertEqual(result.returncode, 1)
        self.assertIn("rustup target add x86_64-apple-darwin", result.stderr)

    def turn_updates_on(self) -> None:
        conf_path = self.repo / "src-tauri/tauri.conf.json"
        conf = json.loads(conf_path.read_text())
        conf.setdefault("plugins", {})["updater"] = {
            "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Qga2V5",
            "endpoints": ["https://github.com/o/r/releases/latest/download/latest.json"],
            "requireSignedVersion": True,
        }
        conf_path.write_text(json.dumps(conf, indent=2) + "\n")

    def assert_no_secret(self, result: subprocess.CompletedProcess) -> None:
        self.assertNotIn("stub-secret", result.stdout + result.stderr)
        self.assertNotIn("not-a-real-key", result.stdout + result.stderr)

    def test_publish_without_the_updater_config_leaves_updates_off_and_reads_no_keychain(self) -> None:
        self.merge_release_pr(NEXT)

        result = self.release("publish", "--dry-run", SECURITY_STUB_ITEMS=KEYCHAIN_ITEMS)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updates: off", result.stdout)
        self.assertNotIn("latest.json", result.stdout)
        self.assertNotIn("--draft", result.stdout)
        self.assertFalse(self.security_log.exists())

    def test_publish_with_updates_on_signs_writes_latest_json_and_releases_through_a_draft(self) -> None:
        self.turn_updates_on()
        self.merge_release_pr(NEXT)

        result = self.release("publish", "--dry-run", SECURITY_STUB_ITEMS=KEYCHAIN_ITEMS)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("updates: on (signing key: in the Keychain; latest.json for o/r)", result.stdout)
        self.assertIn("in that build's environment only", result.stdout)
        self.assertIn(f"release/Riggverk-v{NEXT}-macOS.app.tar.gz (+ .sig)", result.stdout)
        self.assertIn("--draft, check the assets, then gh release edit", result.stdout)
        self.assertIn("release/latest.json", result.stdout)
        self.assertIn(
            f"signer sign --app-version {NEXT} release/linux/Riggverk-v{NEXT}-linux-x86_64.AppImage", result.stdout
        )
        self.assertIn("and the AppImage for linux-x86_64", result.stdout)
        self.assertIn(f"release/linux/Riggverk-v{NEXT}-linux-x86_64.AppImage.sig release/SHA256SUMS", result.stdout)
        self.assertEqual(
            self.security_log.read_text().splitlines(),
            ["find-generic-password -s riggverk-updater-key -w", "find-generic-password -s riggverk-updater-password -w"],
        )
        self.assert_no_secret(result)

    def test_the_updater_config_without_both_keychain_items_is_refused(self) -> None:
        self.turn_updates_on()
        self.merge_release_pr(NEXT)

        for items, missing in (("", "riggverk-updater-key"), ("riggverk-updater-key", "riggverk-updater-password")):
            with self.subTest(missing=missing):
                result = self.release("publish", "--dry-run", SECURITY_STUB_ITEMS=items)

                self.assertEqual(result.returncode, 1)
                self.assertIn(f"the Keychain item {missing} is missing or unreadable", result.stderr)
                self.assertNotIn("latest.json for", result.stdout)
                self.assert_no_secret(result)

    def test_a_signing_key_exported_in_the_shell_is_refused(self) -> None:
        self.turn_updates_on()
        self.merge_release_pr(NEXT)

        for name in ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"):
            with self.subTest(name=name):
                result = self.release(
                    "publish", "--dry-run", SECURITY_STUB_ITEMS=KEYCHAIN_ITEMS, **{name: "not-a-real-key"}
                )

                self.assertEqual(result.returncode, 1)
                self.assertIn("is set in this shell", result.stderr)
                self.assert_no_secret(result)

    def test_xtrace_never_shows_a_keychain_secret(self) -> None:
        self.turn_updates_on()
        self.merge_release_pr(NEXT)
        self.add_linux_packages()

        result = subprocess.run(
            ["bash", "-x", "scripts/release.sh", "publish", "--dry-run"],
            cwd=self.repo,
            env={**self.env, "SECURITY_STUB_ITEMS": KEYCHAIN_ITEMS},
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("find-generic-password -s riggverk-updater-key -w", result.stderr)
        self.assert_no_secret(result)

    def test_publish_passes_the_keychain_secrets_to_the_tauri_build_alone(self) -> None:
        self.turn_updates_on()
        self.merge_release_pr(NEXT)
        self.add_linux_packages()

        # A real run (under xtrace) up to the build, which makes no app here, so it stops before tagging.
        result = subprocess.run(
            ["bash", "-x", "scripts/release.sh", "publish"],
            cwd=self.repo,
            env={**self.env, "SECURITY_STUB_ITEMS": KEYCHAIN_ITEMS},
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("the build did not produce", result.stderr)
        build_calls = self.npm_log.read_text().splitlines()
        self.assertEqual(len(build_calls), 1)
        self.assertTrue(build_calls[0].startswith("run tauri build -- --target universal-apple-darwin"), build_calls[0])
        self.assertIn("createUpdaterArtifacts", build_calls[0])
        self.assertTrue(
            build_calls[0].endswith("|stub-secret-riggverk-updater-key|stub-secret-riggverk-updater-password"),
            build_calls[0],
        )
        self.assertNotIn("gh saw the signing key", self.gh_calls())
        self.assertNotIn(f"v{NEXT}", self.git("tag", "--list"))
        self.assert_no_secret(result)

    def test_publish_without_updates_gives_the_build_no_signing_key(self) -> None:
        self.merge_release_pr(NEXT)

        result = self.release("publish", SECURITY_STUB_ITEMS=KEYCHAIN_ITEMS)

        self.assertEqual(result.returncode, 1)
        self.assertIn("the build did not produce", result.stderr)
        build_call = self.npm_log.read_text()
        self.assertNotIn("createUpdaterArtifacts", build_call)
        self.assertTrue(build_call.endswith("|unset|unset\n"), build_call)
        self.assertFalse(self.security_log.exists())

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


    # Linux packages

    def test_publish_refuses_without_linux_packages_unless_told_to_skip_them(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)

        refused = self.release("publish", "--dry-run")
        skipped = self.release("publish", "--dry-run", "--no-linux")

        self.assertEqual(refused.returncode, 1)
        self.assertIn(f"GitHub has no build candidate linux-candidate-v{NEXT}", refused.stderr)
        self.assertIn("run ./scripts/release.sh build-linux on Linux", refused.stderr)
        self.assertNotIn("release download", self.gh_calls())
        self.assertEqual(skipped.returncode, 0, skipped.stderr)
        self.assertIn("Linux: skipped (--no-linux)", skipped.stdout)
        self.assertNotIn("release/linux/", skipped.stdout)

    def test_publish_refuses_linux_packages_of_another_commit_or_changed_since(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        self.add_linux_packages("HEAD^")

        other_commit = self.release("publish", "--dry-run")
        self.add_linux_packages()
        (self.repo / f"release/linux/Riggverk-v{NEXT}-linux-amd64.deb").write_text("tampered\n")
        changed = self.release("publish", "--dry-run")

        self.assertEqual(other_commit.returncode, 1)
        self.assertIn("were built from", other_commit.stderr)
        self.assertEqual(changed.returncode, 1)
        self.assertIn("changed after the build", changed.stderr)

    def test_build_linux_dry_run_plans_the_build_and_changes_nothing(self) -> None:
        self.merge_release_pr(NEXT)
        before = self.snapshot()

        result = self.release("build-linux", "--dry-run", "--key", str(self.signing_key))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"app version: {NEXT}", result.stdout)
        self.assertIn("scripts/linux-build.sh", result.stdout)
        self.assertIn(f"release/linux/linux-build.json", result.stdout)
        self.assertIn("ssh-keygen -Y sign -n riggverk-linux-build", result.stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.linux_build_log.exists())
        self.assertFalse((self.repo / "release").exists())

    def test_build_linux_leaves_stamped_packages_that_publish_takes(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)

        built = self.release("build-linux", "--key", str(self.signing_key))
        published = self.release("publish", "--dry-run")

        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertEqual(self.linux_build_log.read_text(), "linux-build stub ran\n")
        stamp = json.loads((self.repo / "release/linux/linux-build.json").read_text())
        self.assertEqual(stamp["version"], NEXT)
        self.assertEqual(stamp["commit"], self.git("rev-parse", "HEAD").strip())
        self.assertEqual(
            sorted(stamp["files"]),
            sorted(
                [
                    f"Riggverk-v{NEXT}-linux-amd64.deb",
                    f"Riggverk-v{NEXT}-linux-x86_64.AppImage",
                    f"Riggverk-v{NEXT}-linux-x86_64.rpm",
                ]
            ),
        )
        self.assertIn("signed by builder", built.stdout)
        self.assertEqual(published.returncode, 0, published.stderr)
        self.assertIn("built from HEAD", published.stdout)
        self.assertIn("linux-build.json is signed by builder", published.stdout)

    def test_build_linux_keeps_the_verified_build_when_signing_fails(self) -> None:
        self.merge_release_pr(NEXT)
        self.add_linux_packages()
        signature = self.repo / "release/linux/linux-build.json.sig"
        previous = signature.read_bytes()

        Path(f"{self.outsider_key}.pub").unlink()
        result = self.release("build-linux", "--key", str(self.outsider_key))

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("does not verify against", result.stderr)
        self.assertEqual(signature.read_bytes(), previous)

    def test_publish_refuses_linux_packages_without_a_signature_from_a_listed_key(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        deb = self.repo / f"release/linux/Riggverk-v{NEXT}-linux-amd64.deb"
        stamp = self.repo / "release/linux/linux-build.json"

        self.add_linux_packages(key=self.outsider_key)
        outsider = self.release("publish", "--dry-run")
        self.add_linux_packages()
        Path(f"{stamp}.sig").unlink()
        unsigned = self.release("publish", "--dry-run")
        # Replaced on the way: a new package and a stamp rewritten to match it, under the builder's old signature.
        self.add_linux_packages()
        deb.write_text("replaced\n")
        signature = Path(f"{stamp}.sig").read_bytes()
        self.python(
            "scripts/release_tools.py", "linux-stamp", "write", "--dir", "release/linux", "--version", NEXT,
            "--commit", self.git("rev-parse", "HEAD").strip(),
        )
        Path(f"{stamp}.sig").write_bytes(signature)
        replaced = self.release("publish", "--dry-run")

        for result in (outsider, replaced):
            self.assertEqual(result.returncode, 1)
            self.assertIn("no valid signature from a key in scripts/linux-build-signers", result.stderr)
            self.assertNotIn("is signed by", result.stdout)
        self.assertEqual(unsigned.returncode, 1)
        self.assertIn("no attestation from .github/workflows/linux-release-build.yml for this commit", unsigned.stderr)
        self.assertNotIn("are attested by", unsigned.stdout)

    # The build candidate on GitHub

    def upload_candidate(self, commit: str = "HEAD") -> Path:
        """What build-linux uploads: release/linux of `commit`, moved to the stub's draft linux-candidate-v<version>."""
        self.add_linux_packages(commit)
        candidate = self.gh_releases / f"linux-candidate-v{NEXT}"
        shutil.move(self.repo / "release/linux", candidate)
        return candidate

    def test_build_linux_uploads_the_candidate_and_a_rebuild_replaces_it(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        candidate = self.gh_releases / f"linux-candidate-v{NEXT}"
        commit = self.git("rev-parse", "HEAD").strip()

        first = self.release("build-linux", "--key", str(self.signing_key))
        (candidate / "left-over").write_text("from the first upload\n")
        second = self.release("build-linux", "--key", str(self.signing_key))

        for result in (first, second):
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"uploaded linux-candidate-v{NEXT} (draft prerelease of {commit})", result.stdout)
        self.assertEqual(
            sorted(path.name for path in candidate.iterdir()),
            sorted(path.name for path in (self.repo / "release/linux").iterdir()),
        )
        self.assertEqual(len(list(candidate.iterdir())), 5)
        calls = self.gh_calls()
        self.assertIn(f"--draft --prerelease --target {commit}", calls)
        self.assertEqual(calls.count(f"release delete linux-candidate-v{NEXT} --yes"), 1)
        self.assertIn(f"deleted the previous linux-candidate-v{NEXT}", second.stdout)

    def test_publish_dry_run_checks_the_candidate_and_keeps_it(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        candidate = self.upload_candidate()
        before = sorted(path.name for path in candidate.iterdir())

        result = self.release("publish", "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"downloaded the build candidate linux-candidate-v{NEXT}", result.stdout)
        self.assertIn("its linux-build.json is signed by builder", result.stdout)
        self.assertIn(f"would take the build candidate linux-candidate-v{NEXT} as release/linux", result.stdout)
        self.assertIn(f"would delete the build candidate linux-candidate-v{NEXT}, if there is one", result.stdout)
        self.assertNotIn("release delete", self.gh_calls())
        self.assertEqual(sorted(path.name for path in candidate.iterdir()), before)
        self.assertFalse((self.repo / "release").exists())

    def test_publish_takes_only_the_five_files_of_the_candidate(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        candidate = self.upload_candidate()
        (candidate / "extra.sh").write_text("not asked for\n")

        # A real run up to the build, which makes no app here, so it stops before the release and the delete.
        result = self.release("publish")

        self.assertEqual(result.returncode, 1)
        self.assertIn("the build did not produce", result.stderr)
        self.assertEqual(
            sorted(path.name for path in (self.repo / "release/linux").iterdir()),
            sorted(
                [
                    f"Riggverk-v{NEXT}-linux-amd64.deb",
                    f"Riggverk-v{NEXT}-linux-x86_64.AppImage",
                    f"Riggverk-v{NEXT}-linux-x86_64.rpm",
                    "linux-build.json",
                    "linux-build.json.sig",
                ]
            ),
        )
        self.assertNotIn("release delete", self.gh_calls())
        self.assertTrue(candidate.is_dir())

    def test_publish_refuses_a_candidate_of_another_commit_or_with_a_replaced_file(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)

        self.upload_candidate("HEAD^")
        other_commit = self.release("publish", "--dry-run")
        shutil.rmtree(self.gh_releases / f"linux-candidate-v{NEXT}")
        # Replaced on the way: a new deb and a stamp rewritten to match it, under the builder's old signature.
        candidate = self.upload_candidate()
        (candidate / f"Riggverk-v{NEXT}-linux-amd64.deb").write_text("replaced\n")
        signature = (candidate / "linux-build.json.sig").read_bytes()
        self.python(
            "scripts/release_tools.py", "linux-stamp", "write", "--dir", str(candidate), "--version", NEXT,
            "--commit", self.git("rev-parse", "HEAD").strip(),
        )
        (candidate / "linux-build.json.sig").write_bytes(signature)
        replaced = self.release("publish", "--dry-run")
        replaced_real = self.release("publish")

        self.assertEqual(other_commit.returncode, 1)
        self.assertIn("were built from", other_commit.stderr)
        self.assertIn(
            "run the workflow .github/workflows/linux-release-build.yml or ./scripts/release.sh build-linux again on this "
            "commit",
            other_commit.stderr,
        )
        for result in (replaced, replaced_real):
            self.assertEqual(result.returncode, 1)
            self.assertIn("no valid signature from a key in scripts/linux-build-signers", result.stderr)
        # Nothing refused is left behind to shadow a rebuilt candidate, and the candidate stays.
        self.assertFalse((self.repo / "release/linux").exists())
        self.assertFalse((self.repo / "release/linux-candidate").exists())
        self.assertTrue(candidate.is_dir())
        self.assertFalse(self.npm_log.exists())

    def test_a_hand_copied_release_linux_takes_precedence_over_the_candidate(self) -> None:
        self.merge_release_pr(NEXT)
        # A candidate publish would refuse; release/linux (added by self.release) is used instead.
        self.upload_candidate("HEAD^")

        result = self.release("publish", "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("checked: release/linux holds the AppImage", result.stdout)
        self.assertNotIn("release download", self.gh_calls())
        self.assertNotIn("downloaded the build candidate", result.stdout)

    # The CI build: no SSH signature, an attestation instead

    def upload_ci_candidate(self, attested_at: str = "HEAD") -> Path:
        """What the release build workflow uploads: the packages and their stamp, attested at `attested_at`."""
        candidate = self.upload_candidate()
        (candidate / "linux-build.json.sig").unlink()
        commit = self.git("rev-parse", attested_at).strip()
        self.gh_attestations.write_text(
            "".join(
                f"{hashlib.sha256(path.read_bytes()).hexdigest()} {commit}\n"
                for path in sorted(candidate.iterdir())
                if path.name != "linux-build.json"
            )
        )
        return candidate

    def test_build_linux_for_ci_stamps_the_packages_and_signs_and_uploads_nothing(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        out = Path(self._tmp.name) / "ci-out"

        # The workflow checks out a detached commit and has neither gh nor an SSH key.
        self.git("switch", "-q", "--detach")
        result = self.release("build-linux", "--ci", str(out), HOME=str(Path(self._tmp.name) / "no-home"))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            sorted(path.name for path in out.iterdir()),
            sorted(
                [
                    f"Riggverk-v{NEXT}-linux-amd64.deb",
                    f"Riggverk-v{NEXT}-linux-x86_64.AppImage",
                    f"Riggverk-v{NEXT}-linux-x86_64.rpm",
                    "linux-build.json",
                ]
            ),
        )
        stamp = json.loads((out / "linux-build.json").read_text())
        self.assertEqual((stamp["version"], stamp["commit"]), (NEXT, self.git("rev-parse", "HEAD").strip()))
        self.assertFalse(self.gh_log.exists())
        self.assertFalse((self.repo / "release").exists())

    def test_build_linux_for_ci_refuses_a_version_that_is_already_released(self) -> None:
        # main before the release pull request is merged still holds the version that is out.
        self.merge_release_pr(NEXT)
        self.git("tag", f"v{NEXT}")
        self.git("push", "-q", "origin", f"v{NEXT}")
        out = Path(self._tmp.name) / "ci-out"

        self.git("switch", "-q", "--detach")
        result = self.release("build-linux", "--ci", str(out), HOME=str(Path(self._tmp.name) / "no-home"))

        self.assertEqual(result.returncode, 1)
        self.assertIn(f"v{NEXT} is already released", result.stderr)
        self.assertFalse(self.linux_build_log.exists())
        self.assertFalse(out.exists() and any(out.iterdir()))

    def test_build_linux_for_ci_refuses_a_folder_that_holds_something(self) -> None:
        self.merge_release_pr(NEXT)
        out = Path(self._tmp.name) / "ci-out"
        out.mkdir()
        (out / "left-over").write_text("from an earlier step\n")

        result = self.release("build-linux", "--ci", str(out))

        self.assertEqual(result.returncode, 1)
        self.assertIn("is not empty", result.stderr)
        self.assertFalse(self.linux_build_log.exists())

    def test_publish_takes_an_attested_candidate_that_has_no_signature(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        self.upload_ci_candidate()
        commit = self.git("rev-parse", "HEAD").strip()

        result = self.release("publish", "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"downloaded the build candidate linux-candidate-v{NEXT}", result.stdout)
        self.assertIn("its packages are attested by .github/workflows/linux-release-build.yml, run at HEAD", result.stdout)
        self.assertNotIn("is signed by", result.stdout)
        calls = self.gh_calls()
        self.assertEqual(calls.count("attestation verify"), 3)
        self.assertIn(
            "--repo o/riggverk --signer-workflow o/riggverk/.github/workflows/linux-release-build.yml "
            f"--source-digest {commit} --deny-self-hosted-runners",
            calls,
        )

    def test_publish_refuses_an_unsigned_candidate_attested_at_another_commit_or_changed_since(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)

        # Built by the workflow, but at the commit before: the stamp was rewritten to name HEAD.
        self.upload_ci_candidate(attested_at="HEAD^")
        other_commit = self.release("publish", "--dry-run")
        shutil.rmtree(self.gh_releases / f"linux-candidate-v{NEXT}")
        # Replaced after the build: a new deb and a stamp rewritten to match it.
        candidate = self.upload_ci_candidate()
        (candidate / f"Riggverk-v{NEXT}-linux-amd64.deb").write_text("replaced\n")
        self.python(
            "scripts/release_tools.py", "linux-stamp", "write", "--dir", str(candidate), "--version", NEXT,
            "--commit", self.git("rev-parse", "HEAD").strip(),
        )
        replaced = self.release("publish", "--dry-run")
        replaced_real = self.release("publish")

        for result in (other_commit, replaced, replaced_real):
            self.assertEqual(result.returncode, 1)
            self.assertIn("no attestation from .github/workflows/linux-release-build.yml for this commit", result.stderr)
            self.assertNotIn("are attested by", result.stdout)
        self.assertFalse((self.repo / "release/linux").exists())
        self.assertFalse((self.repo / "release/linux-candidate").exists())
        self.assertFalse(self.npm_log.exists())

    def test_an_attestation_does_not_rescue_a_stamp_signature_that_fails(self) -> None:
        self.linux_packages = False
        self.merge_release_pr(NEXT)
        candidate = self.upload_ci_candidate()
        (candidate / "linux-build.json.sig").write_text("not a signature\n")

        result = self.release("publish", "--dry-run")

        self.assertEqual(result.returncode, 1)
        self.assertIn("no valid signature from a key in scripts/linux-build-signers", result.stderr)
        self.assertNotIn("attestation verify", self.gh_calls())

    def test_build_linux_refuses_a_key_publish_would_not_accept(self) -> None:
        self.merge_release_pr(NEXT)

        outsider = self.release("build-linux", "--dry-run", "--key", str(self.outsider_key))
        missing = self.release("build-linux", "--dry-run", "--key", str(self.repo / "no-such-key"))

        self.assertEqual(outsider.returncode, 1)
        self.assertIn("outsider.pub is not in scripts/linux-build-signers", outsider.stderr)
        self.assertEqual(missing.returncode, 1)
        self.assertIn("no SSH key to sign the packages with", missing.stderr)

    def test_build_linux_needs_the_release_on_main(self) -> None:
        result = self.release("build-linux", "--dry-run", "--key", str(self.signing_key))

        self.assertEqual(result.returncode, 1)
        self.assertIn("is missing or empty", result.stderr)
        self.assertEqual(self.release("build-linux", "--nope").returncode, 1)


if __name__ == "__main__":
    unittest.main()
