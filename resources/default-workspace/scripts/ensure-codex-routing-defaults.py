#!/usr/bin/env python3
"""Ensure Agent Workspace-managed Codex routing defaults in config.toml.

This script patches only the explicit model/routing/approval defaults listed in
MANAGED_PATHS. It never prints full config contents so private user settings and
credential-bearing MCP entries do not leak through previews or failures.
"""

from __future__ import annotations

import argparse
import ast
import shutil
import sys
from pathlib import Path
from typing import Any

MISSING = object()

MANAGED_PATHS: tuple[tuple[str, ...], ...] = (
    ("model",),
    ("model_reasoning_effort",),
    ("approval_policy",),
    ("approvals_reviewer",),
    ("sandbox_mode",),
    ("apps", "_default", "approvals_reviewer"),
    ("apps", "_default", "default_tools_approval_mode"),
)


def strip_inline_comment(text: str) -> str:
    in_double = False
    escape = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_double:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_double = False
        else:
            if ch == '"':
                in_double = True
            elif ch == "#":
                return text[:i].rstrip()
        i += 1
    return text.rstrip()


def split_top_level(text: str) -> list[str]:
    """Split a TOML array/inline-table body on commas outside strings and brackets."""
    parts: list[str] = []
    depth = 0
    in_double = False
    escape = False
    start = 0
    for i, ch in enumerate(text):
        if in_double:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_double = False
        elif ch == '"':
            in_double = True
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return [part.strip() for part in parts if part.strip()]


def parse_compat_value(raw: str) -> Any:
    value = strip_inline_comment(raw).strip()
    if not value:
        raise ValueError("empty TOML value")
    if value.startswith('"""'):
        end = value.find('"""', 3)
        if end < 0:
            raise ValueError("unterminated multiline string")
        return value[3:end]
    if value.startswith('"'):
        try:
            return ast.literal_eval(value)
        except (SyntaxError, ValueError) as exc:
            raise ValueError(f"invalid string value: {exc}") from exc
    if value == "true":
        return True
    if value == "false":
        return False
    if value.startswith("[") and value.endswith("]"):
        return [parse_compat_value(item) for item in split_top_level(value[1:-1])]
    if value.startswith("{") and value.endswith("}"):
        table: dict[str, Any] = {}
        for item in split_top_level(value[1:-1]):
            if "=" not in item:
                raise ValueError(f"invalid inline table entry: {item!r}")
            key, raw_item = item.split("=", 1)
            assign_compat_value(table, key.strip(), parse_compat_value(raw_item))
        return table
    try:
        return int(value, 10)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def split_dotted_key(key: str) -> list[str]:
    parts = [part.strip().strip('"') for part in key.split(".")]
    if not parts or any(not part for part in parts):
        raise ValueError(f"invalid dotted key: {key!r}")
    return parts


def table_at(root: dict[str, Any], parts: list[str]) -> dict[str, Any]:
    current: Any = root
    for part in parts:
        if isinstance(current, list):
            if not current or not isinstance(current[-1], dict):
                current.append({})
            current = current[-1]
        if not isinstance(current, dict):
            raise ValueError(f"TOML table prefix is not a table: {'.'.join(parts)}")
        current = current.setdefault(part, {})
    if not isinstance(current, dict):
        raise ValueError(f"TOML table is not a table: {'.'.join(parts)}")
    return current


def assign_compat_value(current: dict[str, Any], dotted_key: str, value: Any) -> None:
    parts = split_dotted_key(dotted_key)
    table = table_at(current, parts[:-1]) if len(parts) > 1 else current
    table[parts[-1]] = value


def parse_minimal_toml(text: str) -> dict[str, Any]:
    root: dict[str, Any] = {}
    current = root
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("[[") and stripped.endswith("]]" ):
            parts = split_dotted_key(stripped[2:-2].strip())
            parent = table_at(root, parts[:-1]) if len(parts) > 1 else root
            array = parent.setdefault(parts[-1], [])
            if not isinstance(array, list):
                raise ValueError(f"TOML array table conflicts with existing value: {'.'.join(parts)}")
            item: dict[str, Any] = {}
            array.append(item)
            current = item
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current = table_at(root, split_dotted_key(stripped[1:-1].strip()))
            continue
        if "=" not in stripped:
            raise ValueError(f"invalid TOML line: {stripped!r}")
        key, raw_value = stripped.split("=", 1)
        assign_compat_value(current, key.strip(), parse_compat_value(raw_value))
    return root


try:
    import tomllib  # type: ignore[no-redef]
except ModuleNotFoundError:
    class tomllib:  # type: ignore[no-redef]
        TOMLDecodeError = ValueError

        @staticmethod
        def loads(text: str) -> dict[str, Any]:
            return parse_minimal_toml(text)


def fail(message: str) -> None:
    print(f"ensure-codex-routing-defaults.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def display_path(path: tuple[str, ...]) -> str:
    return ".".join(path)


def load_toml(path: Path) -> dict[str, Any]:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        fail(f"invalid TOML in {path}: {exc}")
    except OSError as exc:
        fail(f"unable to read {path}: {exc}")


def get_path(config: dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = config
    for part in path:
        if not isinstance(current, dict) or part not in current:
            return MISSING
        current = current[part]
    return current


def ensure_scalar(path: tuple[str, ...], value: Any) -> Any:
    if isinstance(value, (str, bool, int, float)):
        return value
    fail(f"managed path {display_path(path)!r} must be a scalar value")


def managed_values(managed: dict[str, Any]) -> dict[tuple[str, ...], Any]:
    values: dict[tuple[str, ...], Any] = {}
    for path in MANAGED_PATHS:
        value = get_path(managed, path)
        if value is not MISSING:
            values[path] = ensure_scalar(path, value)
    if not values:
        fail("managed source does not contain any routing defaults")
    return values


def differing_paths(installed: dict[str, Any], managed: dict[str, Any]) -> list[tuple[str, ...]]:
    desired = managed_values(managed)
    diffs: list[tuple[str, ...]] = []
    for path, expected in desired.items():
        if get_path(installed, path) != expected:
            diffs.append(path)
    return diffs


def managed_match(installed: dict[str, Any], managed: dict[str, Any]) -> bool:
    return not differing_paths(installed, managed)


def format_toml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    raise ValueError(f"unsupported scalar type: {type(value)}")


def is_scalar_value_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or stripped.startswith("["):
        return False
    return "=" in stripped


def find_inline_comment_start(value_region: str) -> int | None:
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


def split_scalar_assignment(line: str, key: str) -> tuple[str, str | None] | None:
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
    if '"""' in value_region and value_region.count('"""') % 2 == 1:
        return None
    comment_idx = find_inline_comment_start(value_region)
    if comment_idx is not None:
        suffix_start = comment_idx
        while suffix_start > 0 and value_region[suffix_start - 1] in " \t":
            suffix_start -= 1
        value_part = value_region[:suffix_start].rstrip()
        comment_suffix = value_region[suffix_start:]
    else:
        value_part = value_region.rstrip()
        comment_suffix = None
    if not value_part:
        return None
    return (f"{indent}{key} = ", comment_suffix)


def patch_scalar_line(line: str, key: str, new_value: str) -> str | None:
    split = split_scalar_assignment(line, key)
    if split is None:
        return None
    prefix, comment_suffix = split
    if comment_suffix is None:
        return f"{prefix}{new_value}"
    return f"{prefix}{new_value}{comment_suffix}"


def first_table_index(lines: list[str]) -> int:
    for i, line in enumerate(lines):
        if line.strip().startswith("["):
            return i
    return len(lines)


def find_table_range(lines: list[str], table_path: str) -> tuple[int, int] | None:
    header = f"[{table_path}]"
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == header or stripped.startswith(f"{header} #"):
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if lines[j].strip().startswith("["):
                    end = j
                    break
            return i + 1, end
    return None


def assert_path_prefix_is_table(config: dict[str, Any], path: tuple[str, ...]) -> None:
    current: Any = config
    walked: list[str] = []
    for part in path[:-1]:
        walked.append(part)
        if not isinstance(current, dict):
            fail(f"managed path {display_path(path)!r} conflicts with non-table prefix {'.'.join(walked[:-1])!r}")
        if part not in current:
            return
        current = current[part]
    if current is not MISSING and not isinstance(current, dict):
        fail(f"managed path {display_path(path)!r} conflicts with non-table prefix {display_path(path[:-1])!r}")


def patch_top_level(lines: list[str], key: str, value: Any) -> bool:
    rendered = format_toml_scalar(value)
    table_start = first_table_index(lines)
    for i in range(table_start):
        patched = patch_scalar_line(lines[i], key, rendered)
        if patched is not None:
            if patched != lines[i]:
                lines[i] = patched
                return True
            return False
    lines.insert(table_start, f"{key} = {rendered}")
    return True


def patch_nested(lines: list[str], path: tuple[str, ...], value: Any) -> bool:
    rendered = format_toml_scalar(value)
    table_path = display_path(path[:-1])
    field = path[-1]
    dotted_key = display_path(path)
    table_start = first_table_index(lines)

    for i in range(table_start):
        patched = patch_scalar_line(lines[i], dotted_key, rendered)
        if patched is not None:
            if patched != lines[i]:
                lines[i] = patched
                return True
            return False

    table_range = find_table_range(lines, table_path)
    if table_range is not None:
        start, end = table_range
        for i in range(start, end):
            patched = patch_scalar_line(lines[i], field, rendered)
            if patched is not None:
                if patched != lines[i]:
                    lines[i] = patched
                    return True
                return False
        lines.insert(end, f"{field} = {rendered}")
        return True

    last_related_dotted_line: int | None = None
    dotted_prefix = f"{table_path}."
    for i in range(table_start):
        if is_scalar_value_line(lines[i]) and lines[i].lstrip().startswith(dotted_prefix):
            last_related_dotted_line = i
    if last_related_dotted_line is not None:
        lines.insert(last_related_dotted_line + 1, f"{dotted_key} = {rendered}")
        return True

    if lines and lines[-1].strip():
        lines.append("")
    lines.append(f"[{table_path}]")
    lines.append(f"{field} = {rendered}")
    return True


def patch_toml_text(text: str, installed: dict[str, Any], managed: dict[str, Any]) -> str:
    desired = managed_values(managed)
    lines = text.splitlines()
    changed = False

    for path, value in desired.items():
        assert_path_prefix_is_table(installed, path)
        if len(path) == 1:
            changed = patch_top_level(lines, path[0], value) or changed
        else:
            changed = patch_nested(lines, path, value) or changed

    if not changed:
        return text
    return "\n".join(lines) + "\n"


def validate_backup_dir(backup_dir: Path | None, target: Path) -> None:
    if backup_dir is None:
        fail(f"--backup-dir is required when applying to existing file: {target}")
    if not backup_dir.is_absolute():
        fail(f"backup_dir must be an absolute path: {backup_dir}")
    if backup_dir == target.parent:
        fail(f"backup_dir must not be the target parent directory: {backup_dir}")
    if backup_dir.resolve() == Path("/").resolve():
        fail(f"backup_dir must not be filesystem root: {backup_dir}")


def apply_defaults(target: Path, managed_path: Path, backup_dir: Path | None) -> None:
    managed = load_toml(managed_path)
    if not target.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(managed_path.read_text(encoding="utf-8"), encoding="utf-8")
        return

    validate_backup_dir(backup_dir, target)
    installed = load_toml(target)
    if managed_match(installed, managed):
        return

    patched = patch_toml_text(target.read_text(encoding="utf-8"), installed, managed)
    try:
        parsed = tomllib.loads(patched)
    except tomllib.TOMLDecodeError as exc:
        fail(f"patched TOML is invalid: {exc}")
    if not managed_match(parsed, managed):
        fail(f"patched {target} does not match expected routing defaults")

    assert backup_dir is not None
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / target.name
    if not backup_path.exists():
        shutil.copy2(target, backup_path)
    if not backup_path.is_file():
        fail(f"backup creation failed: {backup_path}")

    staged = target.with_suffix(target.suffix + ".routing.tmp")
    try:
        staged.write_text(patched, encoding="utf-8")
        staged_parsed = load_toml(staged)
        if not managed_match(staged_parsed, managed):
            fail(f"staged validation failed for {target}: managed routing defaults mismatch")
        staged.replace(target)
    finally:
        if staged.exists():
            staged.unlink()

    final = load_toml(target)
    if not managed_match(final, managed):
        shutil.copy2(backup_path, target)
        fail(f"final validation failed for {target}: restored from backup")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="Installed config.toml path")
    parser.add_argument("managed", type=Path, help="Bundled managed config path")
    parser.add_argument("--managed-match", action="store_true", help="Exit 0 when routing defaults match")
    parser.add_argument("--diff", action="store_true", help="Print routing-default path diffs only")
    parser.add_argument("--apply", action="store_true", help="Apply routing defaults to target")
    parser.add_argument("--backup-dir", type=Path, help="Backup directory used with --apply")
    args = parser.parse_args()

    modes = sum(1 for enabled in (args.managed_match, args.diff, args.apply) if enabled)
    if modes != 1:
        parser.error("exactly one of --managed-match, --diff, or --apply is required")

    if args.managed_match:
        if not args.target.is_file():
            raise SystemExit(1)
        raise SystemExit(0 if managed_match(load_toml(args.target), load_toml(args.managed)) else 1)

    if args.diff:
        if not args.target.is_file():
            print(f"codex routing defaults target missing: {args.target}")
            return
        diffs = differing_paths(load_toml(args.target), load_toml(args.managed))
        if diffs:
            print("--- codex-config routing-default diffs")
            for path in diffs:
                print(f'  managed path "{display_path(path)}" would change')
        else:
            print("codex-config routing defaults synced")
        return

    apply_defaults(args.target, args.managed, args.backup_dir)


if __name__ == "__main__":
    main()
