#!/usr/bin/env python3
"""Merge bundled OpenCode managed keys into an installed opencode.json."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = SCRIPT_DIR.parent
MANAGED_KEYS_PATH = WORKSPACE_ROOT / "metadata" / "opencode-managed-keys.json"


def fail(message: str) -> None:
    print(f"merge-opencode-config.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_managed_keys() -> tuple[list[str], list[str]]:
    if not MANAGED_KEYS_PATH.is_file():
        fail(f"managed keys metadata not found: {MANAGED_KEYS_PATH}")
    data = json.loads(MANAGED_KEYS_PATH.read_text(encoding="utf-8"))
    top_level = list(data.get("top_level") or [])
    mcp_servers = list(data.get("mcp_servers") or [])
    if not top_level:
        fail("managed keys metadata missing top_level")
    return top_level, mcp_servers


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path}: {exc}")
    except OSError as exc:
        fail(f"unable to read {path}: {exc}")


RETIRED_QWEN_MODEL = "qwen3.6-plus"


def remove_retired_provider_model(config: dict[str, Any]) -> dict[str, Any]:
    """Remove retired qwen3.6-plus model from provider.opencode-go.models.

    Prunes empty ``models``, ``opencode-go``, and ``provider`` containers
    after the removal.  Modifies and returns *config* in place — caller
    must deep-copy if the original must be preserved.
    """
    provider = config.get("provider")
    if not isinstance(provider, dict):
        return config

    opencode_go = provider.get("opencode-go")
    if not isinstance(opencode_go, dict):
        return config

    models = opencode_go.get("models")
    if not isinstance(models, dict):
        return config

    if RETIRED_QWEN_MODEL in models:
        del models[RETIRED_QWEN_MODEL]

    # Prune empty containers bottom-up
    if not models:
        del opencode_go["models"]
    if not opencode_go:
        del provider["opencode-go"]
    if not provider:
        del config["provider"]

    return config


def merge_managed(installed: dict[str, Any], managed: dict[str, Any]) -> dict[str, Any]:
    top_level, mcp_servers = load_managed_keys()
    merged = json.loads(json.dumps(installed))
    for key in top_level:
        if key in managed:
            merged[key] = json.loads(json.dumps(managed[key]))
    managed_mcp = managed.get("mcp")
    if isinstance(managed_mcp, dict):
        target_mcp = merged.setdefault("mcp", {})
        if not isinstance(target_mcp, dict):
            target_mcp = {}
            merged["mcp"] = target_mcp
        for server in mcp_servers:
            if server in managed_mcp:
                target_mcp[server] = json.loads(json.dumps(managed_mcp[server]))
    remove_retired_provider_model(merged)
    return merged


def extract_managed(config: dict[str, Any]) -> dict[str, Any]:
    top_level, mcp_servers = load_managed_keys()
    extracted: dict[str, Any] = {}
    for key in top_level:
        if key in config:
            extracted[key] = json.loads(json.dumps(config[key]))
    mcp = config.get("mcp")
    if isinstance(mcp, dict):
        managed_mcp: dict[str, Any] = {}
        for server in mcp_servers:
            if server in mcp:
                managed_mcp[server] = json.loads(json.dumps(mcp[server]))
        if managed_mcp:
            extracted["mcp"] = managed_mcp
    return extracted


def managed_keys_match(installed: dict[str, Any], managed: dict[str, Any]) -> bool:
    if extract_managed(installed) != extract_managed(managed):
        return False
    # Installed configs carrying the retired qwen provider model must be
    # reconciled even when managed keys happen to match, so that
    # --apply / --merge clean up the stale block.
    provider = installed.get("provider")
    if isinstance(provider, dict):
        opencode_go = provider.get("opencode-go")
        if isinstance(opencode_go, dict):
            models = opencode_go.get("models")
            if isinstance(models, dict) and RETIRED_QWEN_MODEL in models:
                return False
    return True


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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


def apply_merge(target: Path, managed: dict[str, Any], backup_dir: Path | None) -> None:
    if not target.is_file():
        if not isinstance(managed, dict):
            fail("managed config must be a JSON object")
        write_json(target, managed)
        return

    installed = load_json(target)
    if not isinstance(installed, dict):
        fail(f"installed config must be a JSON object: {target}")
    merged = merge_managed(installed, managed)
    if managed_keys_match(installed, managed):
        return

    # Backup is mandatory when mutating an existing file
    validate_backup_dir(backup_dir, target)
    backup_dir = backup_dir  # type: ignore[assignment] - validated non-None above

    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / target.name
    shutil.copy2(target, backup_path)
    if not backup_path.is_file():
        fail(f"backup creation failed: {backup_path}")

    # Write through a staged file in the target directory
    staged = target.with_suffix(target.suffix + ".tmp")
    try:
        write_json(staged, merged)
    except Exception as exc:
        if staged.exists():
            staged.unlink()
        fail(f"staged write failed for {staged}: {exc}")

    # Validate staged file
    try:
        post_parsed = load_json(staged)
    except SystemExit:
        staged.unlink()
        shutil.copy2(backup_path, target)
        fail(f"staged validation failed for {target}: invalid JSON")

    if not isinstance(post_parsed, dict):
        staged.unlink()
        shutil.copy2(backup_path, target)
        fail(f"staged validation failed for {target}: not a JSON object")

    if not managed_keys_match(post_parsed, managed):
        staged.unlink()
        shutil.copy2(backup_path, target)
        fail(f"staged validation failed for {target}: managed keys mismatch")

    # Verify user provider still present (allow only the retired qwen model removal)
    user_provider = installed.get("provider")
    if user_provider is not None:
        # Wrap provider in a config-shaped dict so remove_retired_provider_model
        # can operate on it, then extract the cleaned provider back out.
        expected_provider = remove_retired_provider_model(
            {"provider": json.loads(json.dumps(user_provider))}
        ).get("provider")
        if post_parsed.get("provider") != expected_provider:
            staged.unlink()
            shutil.copy2(backup_path, target)
            fail(
                f"staged validation failed for {target}: provider block modified "
                f"(beyond removing retired {RETIRED_QWEN_MODEL!r}). "
                f"Original restored from {backup_path}."
            )

    # Atomic replace: rename staged -> target
    staged.replace(target)
    # Verify final state
    if not target.is_file():
        shutil.copy2(backup_path, target)
        fail(f"atomic replace failed for {target}, restored from backup")

    try:
        final_parsed = load_json(target)
    except SystemExit:
        shutil.copy2(backup_path, target)
        fail(f"final validation failed for {target}: invalid JSON, restored from backup")

    if not managed_keys_match(final_parsed, managed):
        shutil.copy2(backup_path, target)
        fail(
            f"final validation failed for {target}: managed keys mismatch, "
            f"restored from {backup_path}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", type=Path, help="Installed opencode.json path")
    parser.add_argument("managed", nargs="?", type=Path, help="Rendered bundled managed config path")
    parser.add_argument("--managed-match", action="store_true", help="Exit 0 when managed keys already match")
    parser.add_argument("--merge", action="store_true", help="Print merged JSON to stdout")
    parser.add_argument("--apply", action="store_true", help="Merge managed keys into target with optional backup")
    parser.add_argument("--output", type=Path, help="Write merged JSON to this path instead of stdout")
    parser.add_argument("--backup-dir", type=Path, help="Backup directory used with --apply")
    args = parser.parse_args()

    if args.target is None or args.managed is None:
        parser.error("target and managed paths are required")

    managed_value = load_json(args.managed)
    if not isinstance(managed_value, dict):
        fail(f"managed config must be a JSON object: {args.managed}")

    if args.managed_match:
        if not args.target.is_file():
            raise SystemExit(1)
        installed_value = load_json(args.target)
        if not isinstance(installed_value, dict):
            fail(f"installed config must be a JSON object: {args.target}")
        raise SystemExit(0 if managed_keys_match(installed_value, managed_value) else 1)

    if args.merge:
        if args.output is None:
            parser.error("--merge requires --output <path> to prevent sensitive config disclosure")
        if args.target.is_file():
            installed_value = load_json(args.target)
            if not isinstance(installed_value, dict):
                fail(f"installed config must be a JSON object: {args.target}")
            merged = merge_managed(installed_value, managed_value)
        else:
            merged = json.loads(json.dumps(managed_value))
        payload = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
        return

    if args.output:
        parser.error("--output requires --merge (use --merge --output <path>)")

    if args.apply:
        apply_merge(args.target, managed_value, args.backup_dir)
        return

    parser.error("one of --managed-match, --merge, or --apply is required")


if __name__ == "__main__":
    main()
