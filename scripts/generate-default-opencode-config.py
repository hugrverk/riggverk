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

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE_PATH = os.path.join(REPO_ROOT, "resources", "default-workspace", "templates", "opencode.base.json")
POLICY_PATH = os.path.join(REPO_ROOT, "resources", "default-workspace", "templates", "opencode.policy.json")
SNAPSHOT_PATH = os.path.join(REPO_ROOT, "resources", "default-workspace", "templates", "opencode.json")

# Stable permission key order (matching the original hand-maintained ordering)
PERMISSION_KEY_ORDER = [
    "*", "external_directory", "doom_loop", "todowrite",
    "read", "glob", "grep", "list", "lsp",
    "question", "webfetch", "websearch", "task",
    "skill", "bash", "edit",
]

# Order of key groups within the bash section for deterministic output
BASH_ORDER = ["default", "allow", "ask", "deny"]

# Order of key groups within edit section for deterministic output
EDIT_ORDER = ["default", "allow", "ask", "deny", "allow_override"]

# Order of key groups within read section for deterministic output
READ_ORDER = ["default", "deny", "allow_override"]

# Secret content commands in order (matching original file order)
SECRET_COMMANDS = ["cat", "head", "tail", "sed", "grep *", "rg *", "git grep *"]


def load_json(path, label):
    """Load and validate a strict JSON file."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"ERROR: {label} not found: {path}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: {label} is not valid strict JSON: {e}", file=sys.stderr)
        sys.exit(1)


def build_read_section(policy):
    """Build read permission section from policy data."""
    read_policy = policy.get("read", {})
    result = {}
    result["*"] = read_policy.get("default", "allow")
    for pattern in read_policy.get("deny", []):
        result[pattern] = "deny"
    for pattern in read_policy.get("allow_override", []):
        result[pattern] = "allow"
    return result


def build_edit_section(policy):
    """Build edit permission section from policy data."""
    edit_policy = policy.get("edit", {})
    result = {}
    result["*"] = edit_policy.get("default", "ask")
    for pattern in edit_policy.get("allow", []):
        result[pattern] = "allow"
    for pattern in edit_policy.get("ask", []):
        result[pattern] = "ask"
    for pattern in edit_policy.get("deny", []):
        result[pattern] = "deny"
    for pattern in edit_policy.get("allow_override", []):
        result[pattern] = "allow"
    return result


def build_bash_section(policy):
    """Build bash permission section from policy data, expanding secret content denies."""
    bash_policy = policy.get("bash", {})
    result = {}

    # Default
    result["*"] = bash_policy.get("default", "ask")

    # Explicit allow entries (preserving order from policy)
    for pattern in bash_policy.get("allow", []):
        result[pattern] = "allow"

    # Explicit ask entries
    for pattern in bash_policy.get("ask", []):
        result[pattern] = "ask"

    # Explicit deny entries
    for pattern in bash_policy.get("deny", []):
        result[pattern] = "deny"

    # Generated secret content denies: for each command × each pattern
    commands = bash_policy.get("secret_content_commands", [])
    patterns = bash_policy.get("secret_content_patterns", [])
    for cmd in commands:
        for pat in patterns:
            key = f"{cmd} {pat}"
            result[key] = "deny"

    return result


def build_permission(policy):
    """Build the full permission section with deterministic key ordering."""
    perm = {}

    for key in PERMISSION_KEY_ORDER:
        if key == "read":
            perm["read"] = build_read_section(policy)
        elif key == "edit":
            perm["edit"] = build_edit_section(policy)
        elif key == "bash":
            perm["bash"] = build_bash_section(policy)
        elif key == "skill":
            perm["skill"] = policy.get("skill", {"*": "allow"})
        elif key in policy.get("top_level", {}):
            perm[key] = policy["top_level"][key]

    return perm


def generate_config():
    """Generate the full opencode config dict from source files."""
    base = load_json(BASE_PATH, "opencode.base.json")
    policy = load_json(POLICY_PATH, "opencode.policy.json")

    config = {}

    # Base keys in stable order
    base_keys = [
        "$schema", "share", "autoupdate", "snapshot",
        "model", "small_model", "default_agent",
        "provider", "compaction", "watcher",
    ]
    for key in base_keys:
        if key in base:
            config[key] = base[key]

    # Build and append permission
    config["permission"] = build_permission(policy)

    return config


def serialize(config):
    """Serialize config to a deterministic JSON string."""
    return json.dumps(config, indent=2, ensure_ascii=False) + "\n"


def read_snapshot():
    """Read current snapshot file, returns (string, parsed dict) or None."""
    try:
        with open(SNAPSHOT_PATH, "r") as f:
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

    with open(SNAPSHOT_PATH, "w") as f:
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
