#!/usr/bin/env python3
"""
Workspace-relative OpenCode config generator.

Reads templates/opencode.base.json (non-permission config) and
templates/opencode.policy.json (compact policy) and produces the
templates/opencode.json snapshot.

Paths are relative to the workspace root: inferred from the script location
under scripts/, or given with --root (the app runs its bundled copy of this
script against the active workspace, so a script inside that workspace never
runs).

Usage:
  python3 scripts/generate-opencode-config.py --check   # verify snapshot is current
  python3 scripts/generate-opencode-config.py --write   # regenerate snapshot
  python3 scripts/generate-opencode-config.py --root DIR --check|--write
  python3 scripts/generate-opencode-config.py --help    # this message

Exit codes:
  0 -- check passed or write succeeded
  1 -- check failed (stale snapshot) or write/validation error
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_ROOT = ""
BASE_PATH = ""
POLICY_PATH = ""
SNAPSHOT_PATH = ""


def set_workspace_root(root):
    """Point the template paths at a workspace root."""
    global WORKSPACE_ROOT, BASE_PATH, POLICY_PATH, SNAPSHOT_PATH
    WORKSPACE_ROOT = os.path.abspath(root)
    BASE_PATH = os.path.join(WORKSPACE_ROOT, "templates", "opencode.base.json")
    POLICY_PATH = os.path.join(WORKSPACE_ROOT, "templates", "opencode.policy.json")
    SNAPSHOT_PATH = os.path.join(WORKSPACE_ROOT, "templates", "opencode.json")


set_workspace_root(os.path.join(SCRIPT_DIR, ".."))

# Stable permission key order (matching the original hand-maintained ordering)
PERMISSION_KEY_ORDER = [
    "*", "external_directory", "doom_loop", "todowrite",
    "read", "glob", "grep", "list", "lsp",
    "question", "webfetch", "websearch", "task",
    "skill", "bash", "edit",
]

# Policy keys this generator understands; anything else would be silently dropped
# from opencode.json, so it is rejected instead.
POLICY_SECTION_KEYS = {
    "top_level": None,
    "skill": None,
    "read": {"default", "deny", "allow_override"},
    "edit": {"default", "allow", "ask", "deny", "allow_override"},
    "bash": {"default", "allow", "ask", "deny", "secret_content_commands"},
    "builtin_agents": None,
    "role_profiles": None,
}

BUILTIN_AGENT_KEYS = {"permission", "from_base", "bash_profile"}

# Non-permission keys emitted first, in this order. Unknown keys from
# opencode.base.json follow them; "permission" is generated from the policy.
BASE_KEY_ORDER = [
    "$schema", "share", "autoupdate", "snapshot",
    "model", "small_model", "default_agent",
    "provider", "mcp", "lsp", "compaction", "watcher",
]


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


def with_root_forms(patterns):
    """Pair every `**/P` pattern with the root form `P`.

    OpenCode matches read and edit rules against the worktree-relative path, and `**/P`
    compiles to `^.*.*/P$`, so it needs a `/` before `P` and never matches `P` at the
    worktree root (`wp-config.php`, `secrets/prod.json`).
    """
    out = []
    for pattern in patterns:
        if pattern.startswith("**/") and pattern[3:] not in out:
            out.append(pattern[3:])
        if pattern not in out:
            out.append(pattern)
    return out


def build_read_section(policy):
    """Build read permission section from policy data."""
    read_policy = policy.get("read", {})
    result = {}
    result["*"] = read_policy.get("default", "allow")
    for pattern in with_root_forms(read_policy.get("deny", [])):
        result[pattern] = "deny"
    for pattern in with_root_forms(read_policy.get("allow_override", [])):
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
    for pattern in with_root_forms(edit_policy.get("deny", [])):
        result[pattern] = "deny"
    for pattern in with_root_forms(edit_policy.get("allow_override", [])):
        result[pattern] = "allow"
    return result


def secret_names(policy):
    """The secret file names and path tails of `read.deny` (`**/P` becomes `P`), for the bash denies.

    A read pattern with a `*` at both ends (`*.env*`) has no fixed start or end. Inside a command
    line it would match every mention (`rg process.env src`), so it stays a read deny only.
    """
    names = []
    for pattern in policy.get("read", {}).get("deny", []):
        name = pattern[3:] if pattern.startswith("**/") else pattern
        if name.startswith("*") and name.endswith("*"):
            continue
        if name not in names:
            names.append(name)
    return names


def secret_content_denies(policy):
    """Bash denies for printing a secret file with a content command, however its path is spelled.

    OpenCode matches a bash rule against the command text, `*` matches any text (spaces and `/`
    included) and a trailing ` *` also matches nothing; `~` is not expanded. For a command C
    and a secret name P from `read.deny`:

    * `C P`: the name right after the command (`cat .env`; `grep -r x .env` for `grep *`);
    * a file reader (`cat`, `head`, ...): also `C P *`, the name followed by more words, and, when
      P does not start with `*`, `C * P *` after other words (`head -n 5 .env`) and `C */P *`, a
      path that ends in `/P` whatever the prefix (`./`, `~/`, `$HOME/`, absolute, nested);
    * a command written with a trailing ` *` (`grep *`, `rg *`, `git grep *`): its first operand
      is the search pattern, so a bare name counts only as the last word (`grep -r id_rsa docs/`
      keeps asking) and the other spellings need a `/`: `C */P *`.

    The trailing ` *` (more words, or a redirect) is left out when P already ends in `*`.
    """
    denies = []
    for command in policy.get("bash", {}).get("secret_content_commands", []):
        search = command.endswith(" *")
        for name in secret_names(policy):
            more = "" if name.endswith("*") else " *"
            forms = [f"{command} {name}"]
            if search:
                forms.append(f"{command} */{name}{more}")
            else:
                forms.append(f"{command} {name}{more}")
                if not name.startswith("*"):
                    forms += [f"{command} * {name}{more}", f"{command} */{name}{more}"]
            denies.extend(forms)
    return list(dict.fromkeys(denies))


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

    # Generated secret content denies, derived from the read deny list
    for pattern in secret_content_denies(policy):
        result[pattern] = "deny"

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

    # Unknown permission keys keep their policy order after the known ones.
    for key, value in policy.get("top_level", {}).items():
        if key not in PERMISSION_KEY_ORDER:
            perm[key] = value

    return perm


def build_bash_profile(policy, profile_name):
    """Build a role bash profile: its own rules, plus every deny of the base bash section."""
    profiles = policy.get("role_profiles", {})
    if profile_name not in profiles:
        print(f"ERROR: unknown role profile: {profile_name}", file=sys.stderr)
        sys.exit(1)
    profile = profiles[profile_name]
    result = {"*": profile.get("default", "deny")}
    for action in ("allow", "ask", "deny"):
        for pattern in profile.get(action, []):
            result[pattern] = action
    for pattern, action in build_bash_section(policy).items():
        if action == "deny":
            result[pattern] = "deny"
    return result


def build_builtin_agent_overrides(policy):
    """Managed `agent.<name>.permission` entries that restore OpenCode's built-in read-only agents.

    OpenCode builds a built-in agent as defaults + its own restriction + the user `permission`
    (agent.ts), so the global AW block silently widens `plan` and `explore`. The config's
    `agent.<name>.permission` is appended after the user ruleset and wins. An entry either
    carries only the delta (`plan`), or is composed from the base permission with a bash profile
    (`from_base`, `explore`), because a trailing `"*": "deny"` has to be followed by every re-allow.
    """
    overrides = {}
    for name, entry in policy.get("builtin_agents", {}).items():
        permission = {}
        if entry.get("from_base"):
            permission = build_permission(policy)
            if entry.get("bash_profile"):
                permission["bash"] = build_bash_profile(policy, entry["bash_profile"])
        for key, value in entry.get("permission", {}).items():
            permission[key] = json.loads(json.dumps(value))
        overrides[name] = {"permission": permission}
    return overrides


def unknown_policy_keys(policy):
    """Return policy keys that build_permission would silently ignore."""
    problems = []
    for key, value in policy.items():
        if key not in POLICY_SECTION_KEYS:
            problems.append(key)
            continue
        allowed = POLICY_SECTION_KEYS[key]
        if allowed is not None and isinstance(value, dict):
            problems.extend(f"{key}.{sub}" for sub in value if sub not in allowed)
    for name, entry in policy.get("builtin_agents", {}).items():
        problems.extend(f"builtin_agents.{name}.{sub}" for sub in entry if sub not in BUILTIN_AGENT_KEYS)
    return problems


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
    config["permission"] = build_permission(policy)
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
        print(f"  python3 scripts/generate-opencode-config.py --write", file=sys.stderr)
        sys.exit(1)

    # Also check byte-level match for strict determinism
    if generated_str != snapshot_str:
        print("CHECK FAILED: opencode.json snapshot has formatting differences", file=sys.stderr)
        print("Regenerate with:", file=sys.stderr)
        print(f"  python3 scripts/generate-opencode-config.py --write", file=sys.stderr)
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
    args = sys.argv[1:]
    if "--root" in args:
        index = args.index("--root")
        if index + 1 >= len(args):
            print("--root requires a directory", file=sys.stderr)
            sys.exit(1)
        set_workspace_root(args[index + 1])
        args = args[:index] + args[index + 2:]

    if len(args) != 1:
        cmd_help()

    arg = args[0]
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
