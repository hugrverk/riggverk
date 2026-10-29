#!/usr/bin/env python3
"""Generate THIRD_PARTY_NOTICES.md from locked Cargo and installed npm metadata."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "THIRD_PARTY_NOTICES.md"
Package = tuple[str, str, str, str]


def license_name(package: dict) -> str:
    value = package.get("license")
    if isinstance(value, dict):
        value = value.get("type")
    if isinstance(value, str) and value.strip():
        return value.strip()
    legacy = package.get("licenses", [])
    names = sorted({item["type"] for item in legacy if isinstance(item, dict) and item.get("type")})
    if names:
        return " OR ".join(names)
    return "See package license file" if package.get("license_file") else "Not declared"


def repository_url(value: str | dict | None) -> str:
    if isinstance(value, dict):
        value = value.get("url")
    if not isinstance(value, str):
        return "Not declared"
    value = value.removeprefix("git+")
    if value.startswith("github:"):
        value = "https://github.com/" + value[len("github:"):]
    if value.startswith("git@") and ":" in value:
        host, path = value[4:].split(":", 1)
        value = f"https://{host}/{path}"
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        value = "https://github.com/" + value
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https", "git", "ssh"} or not parts.hostname:
        return "Not declared"
    # Keep repository addresses, never local paths, user info, queries or fragments.
    return urlunsplit(("https", parts.hostname, parts.path.removesuffix(".git"), "", ""))


def package_row(package: dict) -> Package:
    return (
        package["name"],
        package["version"],
        license_name(package),
        repository_url(package.get("repository")),
    )


def rust_packages() -> set[Package]:
    command = [
        "cargo", "metadata", "--format-version", "1", "--locked",
        "--manifest-path", "src-tauri/Cargo.toml",
    ]
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=300)
    except FileNotFoundError as exc:
        raise RuntimeError("Cargo is required to generate third-party notices.") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("cargo metadata timed out; make the locked crates available and retry.") from exc
    if result.returncode:
        raise RuntimeError(
            "cargo metadata failed; ensure the locked crates are available. "
            "Run cargo metadata --format-version 1 --locked --manifest-path "
            "src-tauri/Cargo.toml for diagnostics."
        )
    metadata = json.loads(result.stdout)
    members = set(metadata["workspace_members"])
    return {package_row(package) for package in metadata["packages"] if package["id"] not in members}


def read_manifest(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read {path.relative_to(ROOT)}; run npm ci and retry.") from exc


def resolve_npm(name: str, directory: Path) -> Path | None:
    if not re.fullmatch(r"(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+", name) or name in {".", ".."}:
        raise RuntimeError("Invalid dependency name in npm metadata.")
    while True:
        candidate = directory / "node_modules" / name / "package.json"
        if candidate.is_file():
            return candidate
        if directory == ROOT:
            return None
        directory = directory.parent


def npm_packages() -> set[Package]:
    root_manifest = ROOT / "package.json"
    pending = [(ROOT, read_manifest(root_manifest))]
    visited = {root_manifest.resolve()}
    packages: set[Package] = set()
    while pending:
        directory, package = pending.pop()
        dependencies = dict.fromkeys(package.get("dependencies", {}), False)
        dependencies.update(dict.fromkeys(package.get("optionalDependencies", {}), True))
        peer_metadata = package.get("peerDependenciesMeta", {})
        for name in package.get("peerDependencies", {}):
            dependencies.setdefault(name, peer_metadata.get(name, {}).get("optional", False))
        for name, optional in sorted(dependencies.items()):
            manifest = resolve_npm(name, directory)
            if manifest is None:
                if optional:
                    continue
                raise RuntimeError(f"Missing production npm dependency {name}; run npm ci.")
            identity = manifest.resolve()
            if identity in visited:
                continue
            visited.add(identity)
            dependency = read_manifest(manifest)
            packages.add(package_row(dependency))
            pending.append((manifest.parent, dependency))
    return packages


def table(packages: set[Package]) -> str:
    lines = ["| Name | Version | License | Repository |", "| --- | --- | --- | --- |"]
    for package in sorted(packages):
        cells = [" ".join(value.split()).replace("|", r"\|") for value in package]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def generate() -> str:
    rust = rust_packages()
    npm = npm_packages()
    return (
        "# Third-party notices\n\n"
        "Generated by `python3 scripts/third-party-notices.py`; do not edit by hand.\n"
        "Check with `python3 scripts/third-party-notices.py --check`.\n\n"
        "This inventory records package-declared license metadata. Full license terms\n"
        "remain with the upstream packages. See [NOTICE.md](NOTICE.md) for bundled\n"
        "skills.\n\n"
        "## Rust dependencies\n\n"
        "The locked Cargo dependency graph, including build and target-specific crates,\n"
        "excluding workspace members.\n\n"
        + table(rust)
        + "\n## npm production dependencies\n\n"
        "Installed direct and transitive dependencies, optional dependencies and peers.\n"
        "Development-only dependencies are excluded; run `npm ci` before generating.\n\n"
        + table(npm)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the committed notices are stale")
    args = parser.parse_args()
    try:
        content = generate().encode("utf-8")
        if args.check:
            if not OUTPUT.is_file() or OUTPUT.read_bytes() != content:
                print("FAIL: THIRD_PARTY_NOTICES.md is stale; run python3 scripts/third-party-notices.py.")
                return 1
            print("THIRD_PARTY_NOTICES.md is current")
        else:
            OUTPUT.write_bytes(content)
            print("Wrote THIRD_PARTY_NOTICES.md")
    except RuntimeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        # Do not expose captured Cargo output or package data, which may contain private paths.
        print("FAIL: Could not generate notices. Check Cargo metadata and run npm ci.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
