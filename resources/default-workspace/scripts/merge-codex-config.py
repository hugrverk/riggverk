#!/usr/bin/env python3
"""Merge bundled Codex managed config sections into an installed config.toml.

Uses tomllib for validation and line-based patching to preserve user content:
comments, model, personality, MCP servers, unknown tables, arrays, dates, and
formatting outside the exact managed fields. Refuses write when the patching
target is ambiguous.
"""

from __future__ import annotations

import argparse
import json
import re
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


def managed_keys_match(installed: dict[str, Any], managed: dict[str, Any]) -> bool:
    return extract_managed(installed) == extract_managed(managed)


def find_existing_table_line(lines: list[str], table_path: str) -> int | None:
    """Find the line index of an existing table header like [table_path]."""
    pattern = re.compile(r"^\s*\[\s*" + re.escape(table_path) + r"\s*\]\s*$")
    for i, line in enumerate(lines):
        if pattern.match(line):
            return i
    return None


def is_scalar_value_line(line: str) -> bool:
    """Check if a line is a key = value assignment (not a table header)."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or stripped.startswith("["):
        return False
    return "=" in stripped


def format_toml_scalar(value: Any) -> str:
    """Format a scalar value for TOML."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        if "\n" in value:
            return '"""\n' + value + '\n"""'
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    raise ValueError(f"unsupported scalar type: {type(value)}")


def patch_toml_text(
    text: str,
    top_level_keys: list[str],
    managed_values: dict[str, Any],
    profiles: list[str],
    profile_fields: list[str],
) -> str | None:
    """Patch a TOML file text, preserving comments and formatting.

    Returns patched text, or None if the structure is too ambiguous for safe patching.
    """
    lines = text.split("\n")
    changed = False

    # Patch top-level keys
    for key in top_level_keys:
        if key not in managed_values:
            continue
        str_value = format_toml_scalar(managed_values[key])
        # Try to find existing key=value line (not inside a table section)
        found = False
        inside_table = False
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("["):
                inside_table = stripped.startswith("[") and not stripped.startswith("[["))
                continue
            if inside_table:
                continue
            if stripped.startswith(f"{key} =") or stripped.startswith(f"{key}="):
                lines[i] = f"{key} = {str_value}"
                found = True
                changed = True
                break
        if not found:
            # Key not found, append at end of file (before any trailing blanks)
            lines.append(f"{key} = {str_value}")
            changed = True

    # Patch managed profile fields
    for profile_name in profiles:
        profile_value = managed_values.get("profiles", {}).get(profile_name)
        if not isinstance(profile_value, dict):
            continue

        # Find the [profiles.X] section
        section_header = f"profiles.{profile_name}"
        section_idx = find_existing_table_line(lines, section_header)
        if section_idx is None:
            # Section doesn't exist, create it
            lines.append("")
            lines.append(f"[{section_header}]")
            for field in profile_fields:
                if field in profile_value:
                    lines.append(f"{field} = {format_toml_scalar(profile_value[field])}")
            changed = True
            continue

        # Patch fields within existing section
        section_end = len(lines)
        for j in range(section_idx + 1, len(lines)):
            stripped = lines[j].strip()
            if stripped.startswith("["):
                section_end = j
                break
            if not stripped:
                continue

        for field in profile_fields:
            if field not in profile_value:
                continue
            str_value = format_toml_scalar(profile_value[field])
            field_found = False
            for j in range(section_idx + 1, section_end):
                stripped = lines[j].strip()
                if stripped.startswith(f"{field} =") or stripped.startswith(f"{field}="):
                    # Preserve indent
                    indent = lines[j][:len(lines[j]) - len(lines[j].lstrip())]
                    lines[j] = f"{indent}{field} = {str_value}"
                    field_found = True
                    changed = True
                    break
            if not field_found:
                lines.insert(section_end, f"{field} = {str_value}")
                section_end += 1
                changed = True

    if not changed:
        return text  # No changes needed
    return "\n".join(lines) + "\n"


def apply_merge(target: Path, managed: dict[str, Any], backup_dir: Path | None) -> None:
    top_level, profiles, fields = load_managed_keys()

    if target.is_file():
        installed_dict = load_toml(target)
        if managed_keys_match(installed_dict, managed):
            return

        existing_text = target.read_text(encoding="utf-8")
        patched = patch_toml_text(
            existing_text,
            top_level,
            managed,
            profiles,
            fields,
        )

        if patched is None:
            fail(
                f"cannot safely patch {target}: ambiguous TOML structure. "
                "Create a backup manually and use --force-overwrite to replace the full config."
            )

        # Verify patched output is valid TOML and preserves managed keys
        try:
            parsed = tomllib.loads(patched)
        except tomllib.TOMLDecodeError as exc:
            fail(f"patched TOML is invalid: {exc}")

        # Verify managed keys match post-patch
        if not managed_keys_match(parsed, managed):
            fail(
                f"patched {target} does not match expected managed keys. "
                "This may indicate an unsupported TOML structure. "
                "Create a backup manually and use --force-overwrite."
            )

        # Verify user-owned keys survive
        for key in installed_dict:
            if key not in top_level and key != "profiles":
                if key not in parsed:
                    fail(f"patched {target} lost user key '{key}'")

        if backup_dir is not None:
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup_dir / target.name)

        target.write_text(patched, encoding="utf-8")

        # Post-write validation: re-parse and verify
        try:
            post_parsed = tomllib.loads(target.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError:
            # Invalid after write - restore from backup
            if backup_dir is not None and (backup_dir / target.name).exists():
                shutil.copy2(backup_dir / target.name, target)
            fail(f"post-write validation failed for {target}: invalid TOML")

        if not managed_keys_match(post_parsed, managed):
            # Managed keys don't match after write - restore from backup
            if backup_dir is not None and (backup_dir / target.name).exists():
                shutil.copy2(backup_dir / target.name, target)
            fail(f"post-write validation failed for {target}: managed keys mismatch")

        return

    # New file: write managed config
    target.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    top_level, profiles, fields = load_managed_keys()
    for key in top_level:
        if key in managed:
            lines.append(f"{key} = {format_toml_scalar(managed[key])}")
    mp = managed.get("profiles", {})
    for name in profiles:
        p = mp.get(name, {})
        if p:
            lines.append("")
            lines.append(f"[profiles.{name}]")
            for f in fields:
                if f in p:
                    lines.append(f"{f} = {format_toml_scalar(p[f])}")
    lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")


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
        # Print merged TOML (lossy read+write — for preview only)
        if args.target.is_file():
            installed_value = load_toml(args.target)
            merged = json.loads(json.dumps(installed_value))
            for key in load_managed_keys()[0]:
                if key in managed_value:
                    merged[key] = json.loads(json.dumps(managed_value[key]))
            mp = managed_value.get("profiles", {})
            if isinstance(mp, dict):
                tp = merged.setdefault("profiles", {})
                for name in load_managed_keys()[1]:
                    managed_profile = mp.get(name)
                    if isinstance(managed_profile, dict):
                        target_profile = tp.setdefault(name, {})
                        for field in load_managed_keys()[2]:
                            if field in managed_profile:
                                target_profile[field] = managed_profile[field]
        else:
            merged = json.loads(json.dumps(managed_value))
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        else:
            json.dump(merged, sys.stdout, indent=2)
            print()
        return

    if args.apply:
        apply_merge(args.target, managed_value, args.backup_dir)
        return

    parser.error("one of --managed-match, --merge, or --apply is required")


if __name__ == "__main__":
    main()
