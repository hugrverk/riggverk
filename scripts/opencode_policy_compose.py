#!/usr/bin/env python3
"""Compose OpenCode agent permission blocks from opencode.policy.json and role overrides."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode.policy.json"

PERMISSION_KEY_ORDER = [
    "*",
    "external_directory",
    "doom_loop",
    "todowrite",
    "read",
    "glob",
    "grep",
    "list",
    "lsp",
    "question",
    "webfetch",
    "websearch",
    "task",
    "skill",
    "bash",
    "edit",
]

# Policy keys this composer understands. Anything else would be silently dropped
# from the generated permission blocks, so it is rejected instead.
POLICY_SECTION_KEYS: dict[str, set[str] | None] = {
    "top_level": None,
    "skill": None,
    "read": {"default", "deny", "allow_override"},
    "edit": {"default", "allow", "ask", "deny", "allow_override"},
    "bash": {"default", "allow", "ask", "deny", "secret_content_commands"},
    "builtin_agents": None,
    "role_profiles": None,
}

BUILTIN_AGENT_KEYS = {"permission", "from_base", "bash_profile"}


def unknown_policy_keys(policy: dict[str, Any]) -> list[str]:
    problems: list[str] = []
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


def load_policy() -> dict[str, Any]:
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    unknown = unknown_policy_keys(policy)
    if unknown:
        raise ValueError(f"unknown keys in opencode.policy.json would be dropped: {', '.join(unknown)}")
    return policy


def with_root_forms(patterns: list[str]) -> list[str]:
    """Pair every `**/P` pattern with the root form `P`.

    OpenCode matches read and edit rules against the worktree-relative path, and `**/P`
    compiles to `^.*.*/P$`, so it needs a `/` before `P` and never matches `P` at the
    worktree root (`wp-config.php`, `secrets/prod.json`).
    """
    out: list[str] = []
    for pattern in patterns:
        if pattern.startswith("**/") and pattern[3:] not in out:
            out.append(pattern[3:])
        if pattern not in out:
            out.append(pattern)
    return out


def build_read_section(policy: dict[str, Any]) -> dict[str, str]:
    read_policy = policy.get("read", {})
    result: dict[str, str] = {"*": read_policy.get("default", "allow")}
    for pattern in with_root_forms(read_policy.get("deny", [])):
        result[pattern] = "deny"
    for pattern in with_root_forms(read_policy.get("allow_override", [])):
        result[pattern] = "allow"
    return result


def build_edit_section(policy: dict[str, Any]) -> dict[str, str]:
    edit_policy = policy.get("edit", {})
    result: dict[str, str] = {"*": edit_policy.get("default", "ask")}
    for pattern in edit_policy.get("allow", []):
        result[pattern] = "allow"
    for pattern in edit_policy.get("ask", []):
        result[pattern] = "ask"
    for pattern in with_root_forms(edit_policy.get("deny", [])):
        result[pattern] = "deny"
    for pattern in with_root_forms(edit_policy.get("allow_override", [])):
        result[pattern] = "allow"
    return result


def _names(patterns: list[str]) -> list[str]:
    """`**/P` becomes `P`; a pattern with a `*` at both ends (`*.env*`) is left out.

    Such a pattern has no fixed start or end. Inside a command line it would match every mention
    (`rg process.env src`), so it stays a read deny only.
    """
    names: list[str] = []
    for pattern in patterns:
        name = pattern[3:] if pattern.startswith("**/") else pattern
        if name.startswith("*") and name.endswith("*"):
            continue
        if name not in names:
            names.append(name)
    return names


def secret_names(policy: dict[str, Any]) -> list[str]:
    """The secret file names and path tails of `read.deny`, for the bash denies."""
    return _names(policy.get("read", {}).get("deny", []))


def secret_file_names(policy: dict[str, Any]) -> list[str]:
    """The names of `secret_names` that `edit.deny` holds too: the secret files themselves.

    The rest is credential-bearing config (`mcp.json`, `.claude.json`, `.git/config`, ...), which is
    read-denied only and which code often names, so searching for its name stays possible.
    """
    edit = set(_names(policy.get("edit", {}).get("deny", [])))
    return [name for name in secret_names(policy) if name in edit]


def secret_content_denies(policy: dict[str, Any]) -> list[str]:
    """Bash denies for printing a secret file with a content command, however its path is spelled.

    OpenCode matches a bash rule against the command text, `*` matches any text (spaces and `/`
    included) and a trailing ` *` also matches nothing; `~` is not expanded. For a command C
    and a secret name P from `read.deny`:

    * a file reader (`cat`, `head`, ...): `C P` and `C P *`, the name right after the command, and,
      when P does not start with `*`, `C * P *` after other words (`head -n 5 .env`) and `C */P *`,
      a path that ends in `/P` whatever the prefix (`./`, `~/`, `$HOME/`, absolute, nested);
    * a command written with a trailing ` *` (`grep *`, `rg *`, `git grep *`): its first operand
      is the search pattern, so P is denied as a path, `C */P *`. A bare P as the last word,
      `C P`, is denied only for `secret_file_names`; `rg -n mcp.json` and
      `grep -r id_rsa docs/` keep asking.

    The trailing ` *` (more words, or a redirect) is left out when P already ends in `*`.
    """
    file_names = set(secret_file_names(policy))
    denies: list[str] = []
    for command in policy.get("bash", {}).get("secret_content_commands", []):
        search = command.endswith(" *")
        for name in secret_names(policy):
            more = "" if name.endswith("*") else " *"
            forms = [f"{command} {name}"] if not search or name in file_names else []
            if search:
                forms.append(f"{command} */{name}{more}")
            else:
                forms.append(f"{command} {name}{more}")
                if not name.startswith("*"):
                    forms += [f"{command} * {name}{more}", f"{command} */{name}{more}"]
            denies.extend(forms)
    return list(dict.fromkeys(denies))


def build_bash_section(policy: dict[str, Any]) -> dict[str, str]:
    bash_policy = policy.get("bash", {})
    result: dict[str, str] = {"*": bash_policy.get("default", "ask")}
    for pattern in bash_policy.get("allow", []):
        result[pattern] = "allow"
    for pattern in bash_policy.get("ask", []):
        result[pattern] = "ask"
    for pattern in bash_policy.get("deny", []):
        result[pattern] = "deny"
    for pattern in secret_content_denies(policy):
        result[pattern] = "deny"
    return result


def _build_profile_section(
    policy: dict[str, Any],
    profile_name: str,
    base_builder: Any,
) -> dict[str, str]:
    profiles = policy.get("role_profiles", {})
    if profile_name not in profiles:
        raise KeyError(f"unknown role profile: {profile_name}")
    profile = profiles[profile_name]
    result: dict[str, str] = {"*": profile.get("default", "deny")}
    for pattern in profile.get("allow", []):
        result[pattern] = "allow"
    for pattern in profile.get("ask", []):
        result[pattern] = "ask"
    for pattern in profile.get("deny", []):
        result[pattern] = "deny"
    base = base_builder(policy)
    for pattern, action in base.items():
        if action == "deny":
            result[pattern] = "deny"
    return result


def build_bash_profile(policy: dict[str, Any], profile_name: str) -> dict[str, str]:
    return _build_profile_section(policy, profile_name, build_bash_section)


def build_edit_profile(policy: dict[str, Any], profile_name: str) -> dict[str, str]:
    return _build_profile_section(policy, profile_name, build_edit_section)


def build_base_permission(policy: dict[str, Any]) -> dict[str, Any]:
    perm: dict[str, Any] = {}
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
    for key, value in policy.get("top_level", {}).items():
        if key not in PERMISSION_KEY_ORDER:
            perm[key] = value
    return perm


def _merge_dict_section(
    base_section: dict[str, str],
    override_section: dict[str, str],
) -> dict[str, str]:
    merged = dict(base_section)
    merged.update(override_section)
    return merged


def _apply_profile_replacements(
    policy: dict[str, Any],
    merged: dict[str, Any],
    composition: dict[str, Any],
) -> None:
    replace_sections = composition.get("replace_sections", [])
    for section in replace_sections:
        profile_key = f"{section}_profile"
        profile_name = composition.get(profile_key)
        if not profile_name:
            continue
        if section == "bash":
            merged["bash"] = build_bash_profile(policy, profile_name)
        elif section == "edit":
            merged["edit"] = build_edit_profile(policy, profile_name)


def _merge_permission(base: dict[str, Any], override: dict[str, Any], replace_sections: set[str]) -> dict[str, Any]:
    merged = json.loads(json.dumps(base))
    for key, value in override.items():
        if key in replace_sections and isinstance(value, dict):
            section = merged.get(key)
            if isinstance(section, dict):
                merged[key] = _merge_dict_section(section, value)
            else:
                merged[key] = dict(value)
            continue
        if key in {"read", "bash", "edit", "task", "skill"} and isinstance(value, dict):
            if key in replace_sections:
                continue
            section = merged.setdefault(key, {})
            if isinstance(section, str):
                section = {}
                merged[key] = section
            section.update(value)
        else:
            merged[key] = value
    return merged


def compose_role_permission(role_override: dict[str, Any]) -> dict[str, Any]:
    policy = load_policy()
    base = build_base_permission(policy)
    composition = role_override.get("composition", {})
    replace_sections = set(composition.get("replace_sections", []))
    merged = json.loads(json.dumps(base))
    _apply_profile_replacements(policy, merged, composition)
    permission_override = role_override.get("permission", {})
    return _merge_permission(merged, permission_override, replace_sections)


def build_builtin_agent_overrides(policy: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Managed `agent.<name>.permission` entries that restore OpenCode's built-in read-only agents.

    OpenCode builds a built-in agent as defaults + its own restriction + the user `permission`
    (agent.ts), so the global Riggverk block silently widens `plan` and `explore`. The config's
    `agent.<name>.permission` is appended after the user ruleset and wins. An entry either
    carries only the delta (`plan`), or is composed from the base permission with a bash profile
    (`from_base`, `explore`), because a trailing `"*": "deny"` has to be followed by every re-allow.
    """
    overrides: dict[str, dict[str, Any]] = {}
    for name, entry in policy.get("builtin_agents", {}).items():
        permission: dict[str, Any] = {}
        if entry.get("from_base"):
            permission = build_base_permission(policy)
            if entry.get("bash_profile"):
                permission["bash"] = build_bash_profile(policy, entry["bash_profile"])
        for key, value in entry.get("permission", {}).items():
            permission[key] = json.loads(json.dumps(value))
        overrides[name] = {"permission": permission}
    return overrides


def _yaml_quote(value: str) -> str:
    return json.dumps(value)


# Plain YAML 1.1/1.2 scalars that would be read back as something other than a string.
_YAML_RESERVED_WORDS = {"true", "false", "yes", "no", "on", "off", "y", "n", "null", "~"}
_PLAIN_YAML_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PLAIN_YAML_NUMBER = re.compile(r"[-+]?[\d._]+([eE][-+]?\d+)?|0[xob][0-9a-fA-F_]+")
_YAML_INDICATORS = "-?:,[]{}#&*!|>'\"%@`"


def _yaml_key(key: str) -> str:
    """Emit a mapping key; anything that is not a plain identifier is quoted (`*` is a YAML alias)."""
    if _PLAIN_YAML_KEY.match(key) and key.lower() not in _YAML_RESERVED_WORDS:
        return key
    return _yaml_quote(key)


def _yaml_scalar(value: Any) -> str:
    """Emit a scalar value; strings that plain YAML would misparse are quoted."""
    if not isinstance(value, str):
        return str(value)
    needs_quote = (
        value == ""
        or value != value.strip()
        or value[0] in _YAML_INDICATORS
        or ": " in value
        or " #" in value
        or value.endswith(":")
        or any(ord(ch) < 32 for ch in value)
        or value.lower() in _YAML_RESERVED_WORDS
        or _PLAIN_YAML_NUMBER.fullmatch(value) is not None
    )
    return _yaml_quote(value) if needs_quote else value


def permission_to_yaml(permission: dict[str, Any], indent: int = 0) -> str:
    lines: list[str] = []
    pad = "  " * indent
    known = [key for key in PERMISSION_KEY_ORDER if key in permission]
    unknown = [key for key in permission if key not in PERMISSION_KEY_ORDER]
    for key in known + unknown:
        value = permission[key]
        if isinstance(value, dict):
            lines.append(f"{pad}{_yaml_key(key)}:")
            for sub_key, sub_val in value.items():
                lines.append(f"{pad}  {_yaml_quote(sub_key)}: {_yaml_scalar(sub_val)}")
        else:
            lines.append(f"{pad}{_yaml_key(key)}: {_yaml_scalar(value)}")
    return "\n".join(lines) + "\n"


def compose_opencode_header(role_path: Path) -> str:
    role = json.loads(role_path.read_text(encoding="utf-8"))
    permission = compose_role_permission(role)
    lines = [
        f"name: {_yaml_scalar(role['name'])}",
        f"description: {_yaml_scalar(role['description'])}",
        f"mode: {_yaml_scalar(role['mode'])}",
        f"temperature: {role['temperature']}",
        f"steps: {role['steps']}",
    ]
    if role.get("hidden"):
        lines.append("hidden: true")
    lines.append("permission:")
    lines.append(permission_to_yaml(permission, indent=1).rstrip())
    return "\n".join(lines) + "\n"
