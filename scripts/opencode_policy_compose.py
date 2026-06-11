#!/usr/bin/env python3
"""Compose OpenCode agent permission blocks from opencode.policy.json and role overrides."""

from __future__ import annotations

import json
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

def load_policy() -> dict[str, Any]:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def build_read_section(policy: dict[str, Any]) -> dict[str, str]:
    read_policy = policy.get("read", {})
    result: dict[str, str] = {"*": read_policy.get("default", "allow")}
    for pattern in read_policy.get("deny", []):
        result[pattern] = "deny"
    for pattern in read_policy.get("allow_override", []):
        result[pattern] = "allow"
    return result


def build_edit_section(policy: dict[str, Any]) -> dict[str, str]:
    edit_policy = policy.get("edit", {})
    result: dict[str, str] = {"*": edit_policy.get("default", "ask")}
    for pattern in edit_policy.get("allow", []):
        result[pattern] = "allow"
    for pattern in edit_policy.get("ask", []):
        result[pattern] = "ask"
    for pattern in edit_policy.get("deny", []):
        result[pattern] = "deny"
    for pattern in edit_policy.get("allow_override", []):
        result[pattern] = "allow"
    return result


def build_bash_section(policy: dict[str, Any]) -> dict[str, str]:
    bash_policy = policy.get("bash", {})
    result: dict[str, str] = {"*": bash_policy.get("default", "ask")}
    for pattern in bash_policy.get("allow", []):
        result[pattern] = "allow"
    for pattern in bash_policy.get("ask", []):
        result[pattern] = "ask"
    for pattern in bash_policy.get("deny", []):
        result[pattern] = "deny"
    for cmd in bash_policy.get("secret_content_commands", []):
        for pat in bash_policy.get("secret_content_patterns", []):
            result[f"{cmd} {pat}"] = "deny"
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


def _yaml_quote(value: str) -> str:
    return json.dumps(value)


def permission_to_yaml(permission: dict[str, Any], indent: int = 0) -> str:
    lines: list[str] = []
    pad = "  " * indent
    for key in PERMISSION_KEY_ORDER:
        if key not in permission:
            continue
        value = permission[key]
        if isinstance(value, dict):
            lines.append(f"{pad}{key}:")
            for sub_key, sub_val in value.items():
                lines.append(f"{pad}  {_yaml_quote(sub_key)}: {sub_val}")
        else:
            lines.append(f"{pad}{key}: {value}")
    for key, value in permission.items():
        if key in PERMISSION_KEY_ORDER:
            continue
        if isinstance(value, dict):
            lines.append(f"{pad}{key}:")
            for sub_key, sub_val in value.items():
                lines.append(f"{pad}  {_yaml_quote(sub_key)}: {sub_val}")
        else:
            lines.append(f"{pad}{key}: {value}")
    return "\n".join(lines) + "\n"


def compose_opencode_header(role_path: Path) -> str:
    role = json.loads(role_path.read_text(encoding="utf-8"))
    permission = compose_role_permission(role)
    lines = [
        f"name: {role['name']}",
        f"description: {role['description']}",
        f"mode: {role['mode']}",
        f"temperature: {role['temperature']}",
        f"steps: {role['steps']}",
    ]
    if role.get("hidden"):
        lines.append("hidden: true")
    lines.append("permission:")
    lines.append(permission_to_yaml(permission, indent=1).rstrip())
    return "\n".join(lines) + "\n"
