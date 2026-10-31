#!/usr/bin/env python3
"""
Deterministic OpenCode config generator.

Reads opencode.base.json (non-permission config) and opencode.policy.json
(compact policy) and produces the full opencode.json snapshot.

Usage:
  python3 scripts/generate-default-opencode-config.py --check   # verify snapshot is current
  python3 scripts/generate-default-opencode-config.py --write   # regenerate snapshot
  python3 scripts/generate-default-opencode-config.py --help    # this message

Exit codes:
  0 -- check passed or write succeeded
  1 -- check failed (stale snapshot) or write/validation error
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Permission composition lives in opencode_policy_compose.py (shared with the agent
# adapters); the workspace-shipped generate-opencode-config.py is its standalone twin.
from opencode_policy_compose import (  # noqa: E402
    build_base_permission,
    build_builtin_agent_overrides,
    unknown_policy_keys,
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE_PATH = os.path.join(REPO_ROOT, "resources", "default-workspace", "templates", "opencode.base.json")
POLICY_PATH = os.path.join(REPO_ROOT, "resources", "default-workspace", "templates", "opencode.policy.json")
SNAPSHOT_PATH = os.path.join(REPO_ROOT, "resources", "default-workspace", "templates", "opencode.json")


def load_json(path, label):
    """Load and validate a strict JSON file."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"ERROR: {label} not found: {path}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: {label} is not valid strict JSON: {e}", file=sys.stderr)
        sys.exit(1)


# Non-permission keys emitted first, in this order. Unknown keys from
# opencode.base.json follow them; "permission" is generated from the policy.
BASE_KEY_ORDER = [
    "$schema", "share", "autoupdate", "snapshot",
    "default_agent",
    "provider", "mcp", "lsp", "compaction", "watcher",
]


def generate_config():
    """Generate the full opencode config dict from source files."""
    base = load_json(BASE_PATH, "opencode.base.json")
    policy = load_json(POLICY_PATH, "opencode.policy.json")

    unknown = unknown_policy_keys(policy)
    if unknown:
        print(f"ERROR: unknown keys in opencode.policy.json would be dropped: {', '.join(unknown)}", file=sys.stderr)
        sys.exit(1)
    if "permission" in base:
        print("ERROR: opencode.base.json must not define 'permission'; it is generated from opencode.policy.json", file=sys.stderr)
        sys.exit(1)

    config = {}

    # Base keys in stable order, then any unknown keys in file order
    for key in BASE_KEY_ORDER:
        if key in base:
            config[key] = base[key]
    for key, value in base.items():
        if key not in config:
            config[key] = value

    # Build and append permission, then the managed built-in agent overrides
    config["permission"] = build_base_permission(policy)
    agent = build_builtin_agent_overrides(policy)
    if agent:
        config["agent"] = agent

    return config


def serialize(config):
    """Serialize config to a deterministic JSON string."""
    return json.dumps(config, indent=2, ensure_ascii=False) + "\n"


def read_snapshot():
    """Read current snapshot file, returns (string, parsed dict) or None."""
    try:
        with open(SNAPSHOT_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        parsed = json.loads(content)
        return content, parsed
    except (FileNotFoundError, json.JSONDecodeError):
        return None, None


def cmd_check():
    """Check if generated config matches the snapshot."""
    generated = generate_config()
    generated_str = serialize(generated)

    snapshot_str, snapshot_parsed = read_snapshot()
    if snapshot_str is None:
        print("CHECK FAILED: opencode.json snapshot not found or invalid", file=sys.stderr)
        sys.exit(1)

    # Compare parsed structures (ignores formatting differences)
    if generated != snapshot_parsed:
        print("CHECK FAILED: opencode.json snapshot is stale", file=sys.stderr)
        print("Differences detected. Regenerate with:", file=sys.stderr)
        print(f"  python3 scripts/generate-default-opencode-config.py --write", file=sys.stderr)
        sys.exit(1)

    # Also check byte-level match for strict determinism
    if generated_str != snapshot_str:
        print("CHECK FAILED: opencode.json snapshot has formatting differences", file=sys.stderr)
        print("Regenerate with:", file=sys.stderr)
        print(f"  python3 scripts/generate-default-opencode-config.py --write", file=sys.stderr)
        sys.exit(1)

    print("CHECK PASSED: opencode.json snapshot is current")
    sys.exit(0)


def cmd_write():
    """Generate and write the opencode.json snapshot."""
    generated = generate_config()
    generated_str = serialize(generated)

    # Validate by re-parsing
    json.loads(generated_str)

    with open(SNAPSHOT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(generated_str)

    print(f"Written: {SNAPSHOT_PATH}")
    sys.exit(0)


def cmd_help():
    print(__doc__)
    sys.exit(0)


def main():
    if len(sys.argv) != 2:
        cmd_help()

    arg = sys.argv[1]
    if arg == "--check":
        cmd_check()
    elif arg == "--write":
        cmd_write()
    elif arg in ("--help", "-h"):
        cmd_help()
    else:
        print(f"Unknown option: {arg}", file=sys.stderr)
        print("Use --check, --write, or --help", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
