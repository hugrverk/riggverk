#!/usr/bin/env python3
"""Helpers for scripts/release.sh: CalVer versions, release notes drafting and version bumps.

Versions are CalVer YYYY.M.N (valid semver): the year, the month without a leading zero, and the release
counter inside that month, starting at 1. Tags are v<version>; any other tag is ignored.

Usage (tags are read from stdin, one per line):
  git tag --list | python3 scripts/release_tools.py next-version [--today YYYY-MM-DD]
  git tag --list | python3 scripts/release_tools.py latest-tag
  git tag --list | python3 scripts/release_tools.py check-newer VERSION
  python3 scripts/release_tools.py draft-notes --version VERSION [--base REV] [--head REV]
  python3 scripts/release_tools.py set-version VERSION
  python3 scripts/release_tools.py check-versions [--expect VERSION]
  python3 scripts/release_tools.py check-node-modules
  python3 scripts/release_tools.py updater-config
  python3 scripts/release_tools.py updater-manifest --version V --repo OWNER/REPO --asset NAME --signature-file SIG \
      --notes-file F [--pub-date RFC3339]
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CALVER = r"(\d{4})\.([1-9]|1[0-2])\.([1-9]\d*)"
VERSION_RE = re.compile(rf"^{CALVER}$")
TAG_RE = re.compile(rf"^v{CALVER}$")

TAURI_CONF = "src-tauri/tauri.conf.json"
CARGO_TOML = "src-tauri/Cargo.toml"
CARGO_LOCK = "src-tauri/Cargo.lock"
PACKAGE_JSON = "package.json"
PACKAGE_LOCK = "package-lock.json"
CRATE_NAME = "riggverk"

INSTALL_NOTE = (
    "Open `Riggverk-v{version}-macOS.dmg`, drag Riggverk to Applications and open it from there (or unzip "
    "`Riggverk-v{version}-macOS.zip` and move `Riggverk.app` to `/Applications`). One app runs on Apple silicon "
    "and Intel Macs. Riggverk is ad hoc signed and not notarized, so macOS stops the first launch: open System "
    "Settings, Privacy & Security, and choose Open Anyway next to the message about Riggverk. `SHA256SUMS` lists "
    "the checksums of both downloads (`shasum -a 256 -c SHA256SUMS --ignore-missing`)."
)
OTHER_COMMENT = (
    "<!-- Chores, refactors and docs. Delete this section to keep them out of the notes and the in-app what's new. -->"
)


class ReleaseError(Exception):
    pass


def parse_version(text: str) -> tuple[int, int, int] | None:
    match = VERSION_RE.match(text)
    return (int(match[1]), int(match[2]), int(match[3])) if match else None


def release_tags(tags: list[str]) -> list[tuple[tuple[int, int, int], str]]:
    """The CalVer tags among `tags`, oldest first. Other tags (v0.1.0-rc.1, app-v0.1.0, ...) are ignored."""
    found = []
    for tag in tags:
        tag = tag.strip()
        match = TAG_RE.match(tag)
        if match:
            found.append(((int(match[1]), int(match[2]), int(match[3])), tag))
    return sorted(found)


def latest_tag(tags: list[str]) -> str | None:
    found = release_tags(tags)
    return found[-1][1] if found else None


def next_version(tags: list[str], today: datetime.date) -> str:
    found = release_tags(tags)
    if not found:
        return f"{today.year}.{today.month}.1"
    (year, month, counter), tag = found[-1]
    if (year, month) > (today.year, today.month):
        raise ReleaseError(f"{tag} is newer than today's month ({today.year}.{today.month}); check the clock")
    if (year, month) == (today.year, today.month):
        return f"{year}.{month}.{counter + 1}"
    return f"{today.year}.{today.month}.1"


def check_newer(tags: list[str], version: str) -> None:
    parsed = parse_version(version)
    if parsed is None:
        raise ReleaseError(f"{version} is not a CalVer version (YYYY.M.N)")
    found = release_tags(tags)
    if found and parsed <= found[-1][0]:
        raise ReleaseError(f"{version} is not newer than the latest release {found[-1][1]}")


# ── Release notes drafting ──

CONVENTIONAL = re.compile(r"^(?P<type>[A-Za-z]+)(?:\([^)]*\))?!?:\s*(?P<text>\S.*)$")
MERGE_SUBJECT = re.compile(r"^Merge pull request #(?P<number>\d+) from \S+")
SQUASH_SUBJECT = re.compile(r"^(?P<title>.+?)\s*\(#(?P<number>\d+)\)$")
SECTION_BY_TYPE = {"feat": "New", "fix": "Fixes"}
SECTION_ORDER = ("New", "Fixes", "Other")


def pr_entries(log: str) -> list[tuple[int, str]]:
    """(number, title) per merged PR in `git log --first-parent --format=%H%x1f%s%x1f%b%x1e` output."""
    entries: list[tuple[int, str]] = []
    seen: set[int] = set()
    for record in log.split("\x1e"):
        fields = record.strip("\n").split("\x1f")
        if len(fields) != 3:
            continue
        _, subject, body = fields
        merge = MERGE_SUBJECT.match(subject)
        squash = SQUASH_SUBJECT.match(subject)
        if merge:
            number = int(merge["number"])
            title = next((line.strip() for line in body.splitlines() if line.strip()), "")
        elif squash:
            number = int(squash["number"])
            title = squash["title"].strip()
        else:
            continue
        if title and number not in seen:
            seen.add(number)
            entries.append((number, title))
    return entries


def classify(title: str) -> tuple[str, str] | None:
    """(section, text) of a PR title, or None for the release PR itself."""
    if re.match(r"chore\(release\)", title):
        return None
    match = CONVENTIONAL.match(title)
    if match:
        text = match["text"].strip()
        section = SECTION_BY_TYPE.get(match["type"].lower(), "Other")
    else:
        text, section = title.strip(), "Other"
    return section, text[:1].upper() + text[1:]


def draft_notes(version: str, entries: list[tuple[int, str]]) -> str:
    grouped: dict[str, list[str]] = {name: [] for name in SECTION_ORDER}
    for number, title in entries:
        classified = classify(title)
        if classified:
            grouped[classified[0]].append(f"- {classified[1]} (#{number})")
    if not any(grouped.values()):
        raise ReleaseError("no merged pull requests since the previous release")
    parts = [f"# Riggverk {version}"]
    for name in SECTION_ORDER:
        if grouped[name]:
            note = OTHER_COMMENT + "\n\n" if name == "Other" else ""
            parts.append(f"## {name}\n\n{note}" + "\n".join(grouped[name]))
    parts.append("## Install\n\n" + INSTALL_NOTE.format(version=version))
    return "\n\n".join(parts) + "\n"


def git_log(base: str | None, head: str, cwd: Path = ROOT) -> str:
    revision = f"{base}..{head}" if base else head
    result = subprocess.run(
        ["git", "log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", revision],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReleaseError(f"git log {revision} failed: {result.stderr.strip()}")
    return result.stdout


# ── Version bump and consistency ──


def replace_once(path: Path, pattern: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ReleaseError(f"{path.name}: no version line found")
    path.write_text(updated, encoding="utf-8")


def set_version(version: str, root: Path = ROOT) -> None:
    """Writes the version into package.json, tauri.conf.json and Cargo.toml. Lock files follow from the tools."""
    if parse_version(version) is None:
        raise ReleaseError(f"{version} is not a CalVer version (YYYY.M.N)")
    json_line = rf'^(  "version": ")[^"]*(")'
    replace_once(root / PACKAGE_JSON, json_line, rf"\g<1>{version}\g<2>")
    replace_once(root / TAURI_CONF, json_line, rf"\g<1>{version}\g<2>")
    cargo = root / CARGO_TOML
    text = cargo.read_text(encoding="utf-8")
    start = text.find("[package]\n")
    if start == -1:
        raise ReleaseError("Cargo.toml: no [package] table found")
    end = text.find("\n[", start + 1)
    end = len(text) if end == -1 else end
    table, count = re.subn(r'^version = "[^"]*"$', f'version = "{version}"', text[start:end], count=1, flags=re.MULTILINE)
    if count != 1:
        raise ReleaseError("Cargo.toml: no package version line found")
    cargo.write_text(text[:start] + table + text[end:], encoding="utf-8")


def read_versions(root: Path = ROOT) -> dict[str, str]:
    package_lock = json.loads((root / PACKAGE_LOCK).read_text(encoding="utf-8"))
    cargo_lock = tomllib.loads((root / CARGO_LOCK).read_text(encoding="utf-8"))
    crate = [pkg for pkg in cargo_lock.get("package", []) if pkg.get("name") == CRATE_NAME]
    return {
        PACKAGE_JSON: json.loads((root / PACKAGE_JSON).read_text(encoding="utf-8")).get("version", ""),
        PACKAGE_LOCK: package_lock.get("version", ""),
        f"{PACKAGE_LOCK} packages['']": package_lock.get("packages", {}).get("", {}).get("version", ""),
        TAURI_CONF: json.loads((root / TAURI_CONF).read_text(encoding="utf-8")).get("version", ""),
        CARGO_TOML: tomllib.loads((root / CARGO_TOML).read_text(encoding="utf-8")).get("package", {}).get("version", ""),
        CARGO_LOCK: crate[0].get("version", "") if len(crate) == 1 else "",
    }


def check_versions(expect: str | None = None, root: Path = ROOT) -> str:
    versions = read_versions(root)
    distinct = set(versions.values())
    if len(distinct) != 1 or "" in distinct:
        listing = ", ".join(f"{name}={value or 'missing'}" for name, value in versions.items())
        raise ReleaseError(f"app version differs between files: {listing}")
    version = distinct.pop()
    if expect is not None and version != expect:
        raise ReleaseError(f"app version is {version}, expected {expect}")
    return version


def check_node_modules(root: Path = ROOT) -> None:
    """Refuse a node_modules that is not what package-lock.json locks.

    npm records what it installed in node_modules/.package-lock.json. Every locked package must be there at
    its locked version, except optional ones npm skips on this platform, and nothing else may be.
    """
    hidden_path = root / "node_modules" / ".package-lock.json"
    if not hidden_path.is_file():
        raise ReleaseError("node_modules has no .package-lock.json; run npm ci")
    locked = {
        name: entry
        for name, entry in json.loads((root / PACKAGE_LOCK).read_text(encoding="utf-8")).get("packages", {}).items()
        if name
    }
    installed = {
        name: entry
        for name, entry in json.loads(hidden_path.read_text(encoding="utf-8")).get("packages", {}).items()
        if name
    }
    problems = []
    for name, entry in sorted(locked.items()):
        if name not in installed:
            if not (entry.get("optional") or entry.get("devOptional")):
                problems.append(f"{name} is missing")
        elif installed[name].get("version") != entry.get("version"):
            problems.append(f"{name} is {installed[name].get('version')}, locked {entry.get('version')}")
    problems.extend(f"{name} is not in the lock" for name in sorted(set(installed) - set(locked)))
    if problems:
        shown = "; ".join(problems[:5]) + (f"; and {len(problems) - 5} more" if len(problems) > 5 else "")
        raise ReleaseError(f"node_modules does not match package-lock.json ({shown}); run npm ci")


# ── app updates ──

UPDATER_ENDPOINT_RE = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases/latest/download/latest\.json$")
# The universal app serves both architectures; the updater looks for darwin-<arch>.
UPDATER_PLATFORMS = ("darwin-aarch64", "darwin-x86_64")


def updater_config(root: Path = ROOT) -> str | None:
    """`owner/repo` whose releases carry latest.json when tauri.conf.json turns updates on, else None.

    Updates are on with a `plugins.updater` block; it must then be complete and strict, as the app reads it
    (src-tauri/src/app_update.rs): a pubkey, the GitHub latest.json endpoint, `requireSignedVersion`, no downgrades
    and no `dangerous*` switch. Anything else is an error, never a weaker updater.
    """
    conf = json.loads((root / TAURI_CONF).read_text(encoding="utf-8"))
    updater = conf.get("plugins", {}).get("updater")
    if updater is None:
        return None
    if not isinstance(updater, dict) or not str(updater.get("pubkey", "")).strip():
        raise ReleaseError("plugins.updater in tauri.conf.json has no pubkey")
    endpoints = updater.get("endpoints")
    if not isinstance(endpoints, list) or len(endpoints) != 1 or not isinstance(endpoints[0], str):
        raise ReleaseError("plugins.updater must list exactly one endpoint, the latest.json of the GitHub releases")
    match = UPDATER_ENDPOINT_RE.match(endpoints[0])
    if not match:
        raise ReleaseError(
            "the plugins.updater endpoint must be https://github.com/OWNER/REPO/releases/latest/download/latest.json"
        )
    if updater.get("requireSignedVersion") is not True:
        raise ReleaseError("plugins.updater must set requireSignedVersion to true")
    for key in ("allowDowngrades", "dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts",
                "dangerousAcceptInvalidHostnames"):
        if updater.get(key) is True:
            raise ReleaseError(f"plugins.updater must not set {key}")
    return match[1]


def update_notes(notes: str) -> str:
    """The release notes the app shows in its update review: without the title (the review names the version),
    the Install section and HTML comments."""
    notes = re.sub(r"\A# [^\n]*\n+", "", notes)
    notes = re.sub(r"<!--.*?-->\n?", "", notes, flags=re.S)
    notes = re.sub(r"(?ms)^## Install\b.*?(?=^## |\Z)", "", notes)
    return re.sub(r"\n{3,}", "\n\n", notes).strip() + "\n"


def updater_manifest(version: str, repo: str, asset: str, signature: str, notes: str, pub_date: str) -> dict:
    """latest.json for the updater: one universal archive for every macOS architecture."""
    if parse_version(version) is None:
        raise ReleaseError(f"{version} is not a CalVer version (YYYY.M.N)")
    signature = signature.strip()
    if not signature or "\n" in signature:
        raise ReleaseError("the updater signature must be the one-line contents of the .sig file")
    url = f"https://github.com/{repo}/releases/download/v{version}/{asset}"
    platform = {"signature": signature, "url": url}
    return {
        "version": version,
        "notes": update_notes(notes),
        "pub_date": pub_date,
        "platforms": {name: dict(platform) for name in UPDATER_PLATFORMS},
    }


# ── CLI ──


def read_tags() -> list[str]:
    return [line for line in sys.stdin.read().splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    next_cmd = sub.add_parser("next-version")
    next_cmd.add_argument("--today", help="YYYY-MM-DD; default: today's local date")
    sub.add_parser("latest-tag")
    newer = sub.add_parser("check-newer")
    newer.add_argument("version")
    draft = sub.add_parser("draft-notes")
    draft.add_argument("--version", required=True)
    draft.add_argument("--base", help="exclusive start revision (the previous release tag); default: all history")
    draft.add_argument("--head", default="HEAD")
    setter = sub.add_parser("set-version")
    setter.add_argument("version")
    checker = sub.add_parser("check-versions")
    checker.add_argument("--expect")
    sub.add_parser("check-node-modules")
    sub.add_parser("updater-config")
    manifest = sub.add_parser("updater-manifest")
    manifest.add_argument("--version", required=True)
    manifest.add_argument("--repo", required=True)
    manifest.add_argument("--asset", required=True)
    manifest.add_argument("--signature-file", required=True)
    manifest.add_argument("--notes-file", required=True)
    manifest.add_argument("--pub-date")
    args = parser.parse_args()

    try:
        if args.command == "next-version":
            today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()
            print(next_version(read_tags(), today))
        elif args.command == "latest-tag":
            print(latest_tag(read_tags()) or "")
        elif args.command == "check-newer":
            check_newer(read_tags(), args.version)
        elif args.command == "draft-notes":
            if parse_version(args.version) is None:
                raise ReleaseError(f"{args.version} is not a CalVer version (YYYY.M.N)")
            sys.stdout.write(draft_notes(args.version, pr_entries(git_log(args.base, args.head))))
        elif args.command == "set-version":
            set_version(args.version)
        elif args.command == "check-node-modules":
            check_node_modules()
        elif args.command == "updater-config":
            repo = updater_config()
            print(f"on {repo}" if repo else "off")
        elif args.command == "updater-manifest":
            pub_date = args.pub_date or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            data = updater_manifest(
                args.version,
                args.repo,
                args.asset,
                Path(args.signature_file).read_text(encoding="utf-8"),
                Path(args.notes_file).read_text(encoding="utf-8"),
                pub_date,
            )
            print(json.dumps(data, indent=2))
        else:
            print(check_versions(args.expect))
    except (ReleaseError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
