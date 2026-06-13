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


def load_managed_keys() -> tuple[list[str], list[str], list[str], list[str]]:
    """Return (top_level, legacy_profile_values, legacy_profiles, legacy_fields).

    Legacy entries describe the pre-0.134 profile scheme this app used to
    write; they are removed on update when still in app-shipped shape.
    """
    if not MANAGED_KEYS_PATH.is_file():
        fail(f"managed keys metadata not found: {MANAGED_KEYS_PATH}")
    data = json.loads(MANAGED_KEYS_PATH.read_text(encoding="utf-8"))
    top_level = list(data.get("top_level_keys") or [])
    legacy_values = list(data.get("legacy_top_level_profile_values") or [])
    legacy_profiles = list(data.get("legacy_profiles") or [])
    legacy_fields = list(data.get("legacy_profile_fields") or [])
    if not top_level or not legacy_values or not legacy_profiles or not legacy_fields:
        fail("managed keys metadata incomplete")
    return top_level, legacy_values, legacy_profiles, legacy_fields


def load_toml(path: Path) -> dict[str, Any]:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        fail(f"invalid TOML in {path}: {exc}")
    except OSError as exc:
        fail(f"unable to read {path}: {exc}")


def is_app_shaped_legacy_profile(profile: Any, legacy_fields: list[str]) -> bool:
    """True when a [profiles.X] table only carries app-shipped field names."""
    if not isinstance(profile, dict) or not profile:
        return False
    return all(key in legacy_fields for key in profile)


def extract_managed(config: dict[str, Any]) -> dict[str, Any]:
    top_level, legacy_values, legacy_profiles, legacy_fields = load_managed_keys()
    extracted: dict[str, Any] = {}
    for key in top_level:
        if key in config:
            extracted[key] = config[key]
    # Legacy markers: their presence means an update is needed (the template
    # carries none of them), and the patcher removes them.
    legacy_selector = config.get("profile")
    if isinstance(legacy_selector, str) and legacy_selector in legacy_values:
        extracted["profile"] = legacy_selector
    source_profiles = config.get("profiles")
    if isinstance(source_profiles, dict):
        markers: dict[str, Any] = {}
        for name in legacy_profiles:
            profile = source_profiles.get(name)
            if is_app_shaped_legacy_profile(profile, legacy_fields):
                markers[name] = dict(profile)
        if markers:
            extracted["profiles"] = markers
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


def find_inline_comment_start(value_region: str) -> int | None:
    """Return index of inline comment # outside quoted TOML strings."""
    in_triple = False
    in_double = False
    escape = False
    i = 0
    while i < len(value_region):
        if in_triple:
            if value_region.startswith('"""', i):
                in_triple = False
                i += 3
                continue
            i += 1
            continue
        if in_double:
            if escape:
                escape = False
            elif value_region[i] == "\\":
                escape = True
            elif value_region[i] == '"':
                in_double = False
            i += 1
            continue
        if value_region.startswith('"""', i):
            in_triple = True
            i += 3
            continue
        if value_region[i] == '"':
            in_double = True
            i += 1
            continue
        if value_region[i] == "#":
            return i
        i += 1
    return None


def split_managed_scalar_assignment(line: str, key: str) -> tuple[str, str | None] | None:
    """Split a managed scalar assignment into (indent+key+value, inline_comment_suffix).

    Returns None when the line is ambiguous or not a matching assignment.
    """
    if not is_scalar_value_line(line):
        return None
    indent_len = len(line) - len(line.lstrip(" "))
    indent = line[:indent_len]
    stripped = line[indent_len:]
    if not (stripped.startswith(f"{key} =") or stripped.startswith(f"{key}=")):
        return None
    eq_idx = stripped.find("=")
    if eq_idx < 0:
        return None
    value_region = stripped[eq_idx + 1 :]
    if '"""' in value_region:
        opens = value_region.count('"""')
        if opens % 2 == 1:
            return None
    comment_idx = find_inline_comment_start(value_region)
    if comment_idx is not None:
        suffix_start = comment_idx
        while suffix_start > 0 and value_region[suffix_start - 1] in " \t":
            suffix_start -= 1
        value_part = value_region[:suffix_start].rstrip()
        comment_suffix = value_region[suffix_start:]
        if "#" not in comment_suffix:
            return None
    else:
        value_part = value_region.rstrip()
        comment_suffix = None
    if not value_part:
        return None
    assignment_prefix = f"{indent}{key} = "
    return (assignment_prefix, comment_suffix)


def patch_managed_scalar_line(line: str, key: str, new_value: str) -> str | None:
    split = split_managed_scalar_assignment(line, key)
    if split is None:
        return None
    prefix, comment_suffix = split
    if comment_suffix is None:
        return f"{prefix}{new_value}"
    return f"{prefix}{new_value}{comment_suffix}"


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
    legacy_values: list[str],
    legacy_profiles: list[str],
    legacy_fields: list[str],
) -> str | None:
    """Patch a TOML file text, preserving comments and formatting.

    Returns patched text, or None if the structure is too ambiguous for safe patching.
    """
    lines = text.splitlines()
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
                inside_table = True
                continue
            if inside_table:
                continue
            if stripped.startswith(f"{key} =") or stripped.startswith(f"{key}="):
                patched_line = patch_managed_scalar_line(lines[i], key, str_value)
                if patched_line is None:
                    return None
                lines[i] = patched_line
                found = True
                changed = True
                break
        if not found:
            insert_idx = next(
                (i for i, line in enumerate(lines) if line.strip().startswith("[")),
                len(lines),
            )
            lines.insert(insert_idx, f"{key} = {str_value}")
            changed = True

    # Remove the legacy pre-0.134 profile scheme this app used to write.
    # Only app-shipped content is removed: the `profile = "safe"` selector
    # (fatal to current Codex) and [profiles.X] tables whose fields are all
    # app-shipped names. User-customized tables are preserved.
    pruned: list[str] = []
    inside_table: str | None = None
    section_buffer: list[str] = []

    def flush_section() -> None:
        nonlocal changed
        if inside_table in legacy_profiles:
            fields_in_section = [
                line.strip().split("=", 1)[0].strip()
                for line in section_buffer[1:]
                if is_scalar_value_line(line)
            ]
            has_fields = bool(fields_in_section)
            if has_fields and all(f in legacy_fields for f in fields_in_section):
                changed = True
                return
        pruned.extend(section_buffer)

    for line in lines:
        stripped = line.strip()
        header = re.match(r"^\[\s*profiles\.([A-Za-z0-9_-]+)\s*\]$", stripped)
        if stripped.startswith("["):
            if inside_table is not None:
                flush_section()
            inside_table = header.group(1) if header else ""
            section_buffer = [line]
            continue
        if inside_table is not None:
            section_buffer.append(line)
            continue
        selector = re.match(r"^profile\s*=\s*\"([^\"]*)\"\s*(#.*)?$", stripped)
        if selector and selector.group(1) in legacy_values:
            changed = True
            continue
        pruned.append(line)
    if inside_table is not None:
        flush_section()
    lines = pruned

    if not changed:
        return text  # No changes needed
    return "\n".join(lines) + "\n"


def validate_backup_dir(backup_dir: Path | None, target: Path) -> None:
    """Validate backup_dir when target exists and --apply is requested."""
    if backup_dir is None:
        fail(
            f"--backup-dir is required when applying to existing file: {target}. "
            "Refusing to mutate existing config without a backup."
        )
    if not backup_dir.is_absolute():
        fail(f"backup_dir must be an absolute path: {backup_dir}")
    if backup_dir == target.parent:
        fail(f"backup_dir must not be the target parent directory: {backup_dir}")
    resolved = backup_dir.resolve()
    if resolved == Path("/").resolve():
        fail(f"backup_dir must not be filesystem root: {backup_dir}")


def render_rollback_managed_projection(target: Path, backup: Path) -> str:
    """Render managed fields from backup into target while preserving unrelated formatting."""
    if not target.is_file():
        fail(f"rollback target missing: {target}")
    if not backup.is_file():
        fail(f"rollback backup missing: {backup}")

    managed = extract_managed(load_toml(backup))
    installed_dict = load_toml(target)
    existing_text = target.read_text(encoding="utf-8")
    top_level, legacy_values, legacy_profiles, legacy_fields = load_managed_keys()
    patched = patch_toml_text(
        existing_text, top_level, managed, legacy_values, legacy_profiles, legacy_fields
    )
    if patched is None:
        fail(
            f"cannot safely rollback {target}: ambiguous TOML structure. "
            "Resolve conflicts manually before retrying rollback."
        )

    try:
        parsed = tomllib.loads(patched)
    except tomllib.TOMLDecodeError as exc:
        fail(f"rollback patched TOML is invalid: {exc}")
    if not managed_keys_match(parsed, managed):
        fail(f"rollback patched {target} does not match backup managed keys")
    for key in installed_dict:
        if key not in top_level and key not in ("profiles", "profile"):
            if key not in parsed:
                fail(f"rollback patched {target} lost user key '{key}'")

    return patched + ("\n" if not patched.endswith("\n") else "")


def apply_merge(target: Path, managed: dict[str, Any], backup_dir: Path | None) -> None:
    top_level, legacy_values, legacy_profiles, legacy_fields = load_managed_keys()

    if not target.is_file():
        # New file: write managed config
        target.parent.mkdir(parents=True, exist_ok=True)
        new_lines = []
        for key in top_level:
            if key in managed:
                new_lines.append(f"{key} = {format_toml_scalar(managed[key])}")
        new_lines.append("")
        target.write_text("\n".join(new_lines), encoding="utf-8")
        return

    # Existing file: backup is mandatory
    validate_backup_dir(backup_dir, target)

    installed_dict = load_toml(target)
    if managed_keys_match(installed_dict, managed):
        return

    existing_text = target.read_text(encoding="utf-8")
    patched = patch_toml_text(
        existing_text, top_level, managed, legacy_values, legacy_profiles, legacy_fields
    )
    if patched is None:
        fail(
            f"cannot safely patch {target}: ambiguous TOML structure. "
            "Create a backup manually and use --force-overwrite to replace the full config."
        )

    # Verify patched output
    try:
        parsed = tomllib.loads(patched)
    except tomllib.TOMLDecodeError as exc:
        fail(f"patched TOML is invalid: {exc}")
    if not managed_keys_match(parsed, managed):
        fail(f"patched {target} does not match expected managed keys")
    for key in installed_dict:
        if key not in top_level and key not in ("profiles", "profile"):
            if key not in parsed:
                fail(f"patched {target} lost user key '{key}'")

    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / target.name
    shutil.copy2(target, backup_path)
    if not backup_path.is_file():
        fail(f"backup creation failed: {backup_path}")

    # Write through staged file
    staged = target.with_suffix(target.suffix + ".tmp")
    try:
        staged.write_text(patched, encoding="utf-8")
    except OSError as exc:
        if staged.exists():
            staged.unlink()
        fail(f"staged write failed for {staged}: {exc}")

    # Validate staged file
    try:
        post_parsed = tomllib.loads(staged.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        staged.unlink()
        shutil.copy2(backup_path, target)
        fail(f"staged validation failed for {target}: invalid TOML, restored from backup")
    if not managed_keys_match(post_parsed, managed):
        staged.unlink()
        shutil.copy2(backup_path, target)
        fail(f"staged validation failed for {target}: managed keys mismatch, restored from backup")
    for key in installed_dict:
        if key not in top_level and key not in ("profiles", "profile"):
            if key not in post_parsed:
                staged.unlink()
                shutil.copy2(backup_path, target)
                fail(f"staged validation failed for {target}: lost user key '{key}', restored from backup")

    # Atomic replace
    staged.replace(target)
    if not target.is_file():
        shutil.copy2(backup_path, target)
        fail(f"atomic replace failed for {target}, restored from backup")

    # Final verification
    try:
        final_parsed = tomllib.loads(target.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        shutil.copy2(backup_path, target)
        fail(f"final validation failed for {target}: invalid TOML, restored from backup")
    if not managed_keys_match(final_parsed, managed):
        shutil.copy2(backup_path, target)
        fail(f"final validation failed for {target}: managed keys mismatch, restored from backup")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", type=Path, help="Installed config.toml path")
    parser.add_argument("managed", nargs="?", type=Path, help="Bundled managed config path")
    parser.add_argument("--managed-match", action="store_true", help="Exit 0 when managed sections match")
    parser.add_argument("--merge", action="store_true", help="Print merged TOML to stdout")
    parser.add_argument("--apply", action="store_true", help="Merge managed sections into target")
    parser.add_argument(
        "--render-rollback-managed",
        action="store_true",
        help="Render rollback result to stdout without mutating the target",
    )
    parser.add_argument("--output", type=Path, help="Write merged TOML to this path")
    parser.add_argument("--backup-dir", type=Path, help="Backup directory used with --apply")
    args = parser.parse_args()

    if args.target is None or args.managed is None:
        parser.error("target and managed paths are required")

    if args.render_rollback_managed:
        if args.managed_match or args.merge or args.apply or args.output or args.backup_dir:
            parser.error("--render-rollback-managed cannot be combined with other modes")
        rendered = render_rollback_managed_projection(args.target, args.managed)
        sys.stdout.write(rendered)
        return

    managed_value = load_toml(args.managed)

    if args.managed_match:
        if not args.target.is_file():
            raise SystemExit(1)
        installed_value = load_toml(args.target)
        raise SystemExit(0 if managed_keys_match(installed_value, managed_value) else 1)

    if args.merge:
        if args.output is None:
            parser.error("--merge requires --output <path> to prevent sensitive config disclosure")
        # Merge managed values into installed config (lossy read+write — preview only)
        if args.target.is_file():
            installed_value = load_toml(args.target)
            merged = json.loads(json.dumps(installed_value))
            top_level, legacy_values, legacy_profiles, legacy_fields = load_managed_keys()
            for key in top_level:
                if key in managed_value:
                    merged[key] = json.loads(json.dumps(managed_value[key]))
            if isinstance(merged.get("profile"), str) and merged["profile"] in legacy_values:
                del merged["profile"]
            tp = merged.get("profiles")
            if isinstance(tp, dict):
                for name in legacy_profiles:
                    if is_app_shaped_legacy_profile(tp.get(name), legacy_fields):
                        del tp[name]
                if not tp:
                    del merged["profiles"]
        else:
            merged = json.loads(json.dumps(managed_value))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        return

    if args.output:
        parser.error("--output requires --merge (use --merge --output <path>)")

    if args.apply:
        apply_merge(args.target, managed_value, args.backup_dir)
        return

    parser.error("one of --managed-match, --merge, or --apply is required")


if __name__ == "__main__":
    main()
