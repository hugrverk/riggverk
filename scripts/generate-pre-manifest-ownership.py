#!/usr/bin/env python3
"""Generate and verify exact ownership metadata for the pre-manifest install."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_COMMIT = "2d85d94b6f2f1dc06f45f6ec52a22ae97e499588"
PREFIX = "resources/default-workspace/"
MANIFEST = ROOT / PREFIX / "metadata/pre-manifest-ownership.json"
WORKSPACE_MANIFEST = ROOT / "src-tauri/src/commands/default_workspace_manifest.rs"
BOOTSTRAP = ROOT / "src-tauri/src/managed_bootstrap.rs"


def git(*args: str) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def historical(rel: str) -> bytes:
    return git("show", f"{SOURCE_COMMIT}:{PREFIX}{rel}")


def last_historical_version(rel: str) -> bytes:
    path = f"{PREFIX}{rel}"
    commits = git("log", "--format=%H", SOURCE_COMMIT, "--", path).decode().splitlines()
    for commit in commits:
        try:
            return git("show", f"{commit}^:{path}")
        except RuntimeError:
            continue
    raise RuntimeError(f"no historical version found for {rel}")


def digest(raw: bytes) -> str:
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def rust_string_list(path: Path, start: str, end: str) -> list[str]:
    text = path.read_text(encoding="utf-8")
    section = text.split(start, 1)[1].split(end, 1)[0]
    return re.findall(r'"([^"]+)"', section)


def current_workspace_paths() -> list[str]:
    text = WORKSPACE_MANIFEST.read_text(encoding="utf-8")
    section = text.split("pub(super) fn categories()", 1)[1]
    return sorted(
        value
        for value in re.findall(r'"([^"]+)"', section)
        if "/" in value or value.endswith(".md") or value.endswith(".json")
    )


def removed_skill_names() -> list[str]:
    return rust_string_list(
        BOOTSTRAP, "pub const REMOVED_SKILL_NAMES", "];"
    )


def entry(
    identity: str, path_classes: list[str], raw: bytes, action: str
) -> dict[str, object]:
    return {
        "identity": identity,
        "path_classes": path_classes,
        "digests": [digest(raw)],
        "action": action,
    }


def generate() -> dict[str, object]:
    git("cat-file", "-e", f"{SOURCE_COMMIT}^{{commit}}")
    artifacts: list[dict[str, object]] = []

    for name in removed_skill_names():
        raw = historical(f"metadata/deprecated-skills/{name}/SKILL.md")
        artifacts.append(
            entry(
                f"removed-skill:{name}",
                [
                    "runtime-skill",
                    "runtime-deprecated-copy",
                    "harness-skill",
                    "codex-legacy-skill",
                ],
                raw,
                "remove",
            )
        )

    scout = last_historical_version("agents/scout.md")
    artifacts.append(
        entry(
            "legacy-agent:scout",
            ["runtime-agent", "opencode-agent"],
            scout,
            "remove",
        )
    )
    artifacts.append(
        entry(
            "legacy-metadata:deprecated-skills",
            ["runtime-metadata"],
            historical("metadata/deprecated-skills.json"),
            "remove",
        )
    )

    historical_paths = set(
        git("ls-tree", "-r", "--name-only", SOURCE_COMMIT, PREFIX)
        .decode()
        .splitlines()
    )
    for rel in current_workspace_paths():
        source_path = f"{PREFIX}{rel}"
        current = ROOT / source_path
        if source_path not in historical_paths or not current.is_file():
            continue
        old = historical(rel)
        if old != current.read_bytes():
            artifacts.append(
                entry(
                    f"workspace:file:{rel}",
                    ["workspace-doc"],
                    old,
                    "update",
                )
            )

    artifacts.sort(key=lambda value: str(value["identity"]))
    return {
        "migration_id": "pre-managed-state-2d85d94",
        "source_commit": SOURCE_COMMIT,
        "artifacts": artifacts,
    }


def encoded(value: dict[str, object]) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        expected = generate()
    except (RuntimeError, KeyError, IndexError) as error:
        raise SystemExit(f"FAIL: {error}") from error
    if args.check:
        actual = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if actual != expected:
            print("FAIL: pre-manifest ownership metadata is incomplete or stale", file=sys.stderr)
            raise SystemExit(1)
        print("pre-manifest ownership semantic coverage passed")
        return
    MANIFEST.write_text(encoded(expected), encoding="utf-8")
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(expected['artifacts'])} entries)")


if __name__ == "__main__":
    main()
