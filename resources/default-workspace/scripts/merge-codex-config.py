#!/usr/bin/env python3
"""Merge bundled Codex managed config sections into an installed config.toml."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tomllib
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = SCRIPT_DIR.parent
MANAGED_KEYS_PATH = WORKSPACE_ROOT / "metadata" / "codex-managed-keys.json"


def fail(message: str) -> None:
    print(f"merge-codex-config.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_managed_keys() -> tuple[list[str], list[str], list[str]]:
    if not MANAGED_KEYS_PATH.is_file():
        fail(f"managed keys metadata not found: {MANAGED_KEYS_PATH}")
    data = json.loads(MANAGED_KEYS_PATH.read_text(encoding="utf-8"))
    top_level = list(data.get("top_level_keys") or [])
    profiles = list(data.get("managed_profiles") or [])
    fields = list(data.get("managed_profile_fields") or [])
    if not top_level or not profiles or not fields:
        fail("managed keys metadata incomplete")
    return top_level, profiles, fields


def load_toml(path: Path) -> dict[str, Any]:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        fail(f"invalid TOML in {path}: {exc}")
    except OSError as exc:
        fail(f"unable to read {path}: {exc}")


def extract_managed(config: dict[str, Any]) -> dict[str, Any]:
    top_level, profiles, fields = load_managed_keys()
    extracted: dict[str, Any] = {}
    for key in top_level:
        if key in config:
            extracted[key] = config[key]
    source_profiles = config.get("profiles")
    if isinstance(source_profiles, dict):
        managed_profiles: dict[str, Any] = {}
        for name in profiles:
            profile = source_profiles.get(name)
            if not isinstance(profile, dict):
                continue
            managed_profiles[name] = {
                field: profile[field] for field in fields if field in profile
            }
        if managed_profiles:
            extracted["profiles"] = managed_profiles
    return extracted


def merge_managed(installed: dict[str, Any], managed: dict[str, Any]) -> dict[str, Any]:
    top_level, profiles, fields = load_managed_keys()
    merged = json.loads(json.dumps(installed))
    for key in top_level:
        if key in managed:
            merged[key] = managed[key]
    managed_profiles = managed.get("profiles")
    if isinstance(managed_profiles, dict):
        target_profiles = merged.setdefault("profiles", {})
        if not isinstance(target_profiles, dict):
            target_profiles = {}
            merged["profiles"] = target_profiles
        for name in profiles:
            managed_profile = managed_profiles.get(name)
            if not isinstance(managed_profile, dict):
                continue
            target_profile = target_profiles.setdefault(name, {})
            if not isinstance(target_profile, dict):
                target_profile = {}
                target_profiles[name] = target_profile
            for field in fields:
                if field in managed_profile:
                    target_profile[field] = managed_profile[field]
    return merged


def managed_keys_match(installed: dict[str, Any], managed: dict[str, Any]) -> bool:
    return extract_managed(installed) == extract_managed(managed)


def format_toml_string(value: str) -> str:
    if "\n" in value:
        return '"""\n' + value + '\n"""'
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def format_toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return format_toml_string(value)
    if isinstance(value, list):
        items = ", ".join(format_toml_value(item) for item in value)
        return f"[{items}]"
    fail(f"unsupported TOML value type: {type(value)!r}")


def dump_toml_table(name: str, table: dict[str, Any], lines: list[str]) -> None:
    lines.append(f"[{name}]")
    nested: dict[str, dict[str, Any]] = {}
    for key, value in table.items():
        if isinstance(value, dict):
            nested[key] = value
            continue
        lines.append(f"{key} = {format_toml_value(value)}")
    for key, value in nested.items():
        dump_toml_table(f"{name}.{key}", value, lines)
    lines.append("")


def dump_toml(config: dict[str, Any]) -> str:
    lines: list[str] = []
    nested_roots: dict[str, dict[str, Any]] = {}
    for key, value in config.items():
        if isinstance(value, dict):
            nested_roots[key] = value
            continue
        lines.append(f"{key} = {format_toml_value(value)}")
        lines.append("")
    for key, value in nested_roots.items():
        if key == "profiles" and isinstance(value, dict):
            for profile_name, profile_value in value.items():
                if isinstance(profile_value, dict):
                    dump_toml_table(f"profiles.{profile_name}", profile_value, lines)
            continue
        if key == "mcp_servers" and isinstance(value, dict):
            for server_name, server_value in value.items():
                if isinstance(server_value, dict):
                    dump_toml_table(f"mcp_servers.{server_name}", server_value, lines)
            continue
        dump_toml_table(key, value, lines)
    return "\n".join(lines).rstrip() + "\n"


def write_toml(path: Path, config: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dump_toml(config), encoding="utf-8")


def apply_merge(target: Path, managed: dict[str, Any], backup_dir: Path | None) -> None:
    if target.is_file():
        installed = load_toml(target)
        if managed_keys_match(installed, managed):
            return
        merged = merge_managed(installed, managed)
        if backup_dir is not None:
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup_dir / target.name)
        write_toml(target, merged)
        return
    write_toml(target, managed)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", type=Path, help="Installed config.toml path")
    parser.add_argument("managed", nargs="?", type=Path, help="Bundled managed config path")
    parser.add_argument("--managed-match", action="store_true", help="Exit 0 when managed sections match")
    parser.add_argument("--merge", action="store_true", help="Print merged TOML to stdout")
    parser.add_argument("--apply", action="store_true", help="Merge managed sections into target")
    parser.add_argument("--output", type=Path, help="Write merged TOML to this path")
    parser.add_argument("--backup-dir", type=Path, help="Backup directory used with --apply")
    args = parser.parse_args()

    if args.target is None or args.managed is None:
        parser.error("target and managed paths are required")

    managed_value = load_toml(args.managed)

    if args.managed_match:
        if not args.target.is_file():
            raise SystemExit(1)
        installed_value = load_toml(args.target)
        raise SystemExit(0 if managed_keys_match(installed_value, managed_value) else 1)

    if args.merge or args.output:
        if args.target.is_file():
            installed_value = load_toml(args.target)
            merged = merge_managed(installed_value, managed_value)
        else:
            merged = json.loads(json.dumps(managed_value))
        payload = dump_toml(merged)
        if args.output:
            args.output.write_text(payload, encoding="utf-8")
        else:
            sys.stdout.write(payload)
        return

    if args.apply:
        apply_merge(args.target, managed_value, args.backup_dir)
        return

    parser.error("one of --managed-match, --merge, or --apply is required")


if __name__ == "__main__":
    main()
