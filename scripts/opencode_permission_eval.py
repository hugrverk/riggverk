#!/usr/bin/env python3
"""Mirror OpenCode permission evaluation (Wildcard.match + findLast ruleset merge)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

Action = str  # allow | deny | ask


@dataclass(frozen=True)
class Rule:
    permission: str
    pattern: str
    action: Action


def wildcard_match(value: str, pattern: str) -> bool:
    """Match OpenCode Wildcard.match (packages/core/src/util/wildcard.ts)."""
    if value:
        value = value.replace("\\", "/")
    if pattern:
        pattern = pattern.replace("\\", "/")
    escaped = re.sub(r"[.+^${}()|[\]\\]", r"\\\g<0>", pattern)
    escaped = escaped.replace("*", ".*").replace("?", ".")
    if escaped.endswith(" .*"):
        escaped = escaped[:-3] + "( .*)?"
    # Upstream compiles with the "s" flag (dot matches newline), plus "i" on win32.
    flags = re.DOTALL | (re.IGNORECASE if _is_windows() else 0)
    return re.fullmatch(escaped, value, flags=flags) is not None


def _is_windows() -> bool:
    import sys

    return sys.platform == "win32"


def expand_home(pattern: str) -> str:
    import os

    if pattern.startswith("~/"):
        return os.path.expanduser("~") + pattern[1:]
    if pattern == "~":
        return os.path.expanduser("~")
    if pattern.startswith("$HOME/"):
        return os.path.expanduser("~") + pattern[5:]
    if pattern.startswith("$HOME"):
        return os.path.expanduser("~") + pattern[5:]
    return pattern


def ruleset_from_section(permission_key: str, section: Any) -> list[Rule]:
    rules: list[Rule] = []
    if isinstance(section, str):
        rules.append(Rule(permission_key, "*", section))
        return rules
    if not isinstance(section, dict):
        return rules
    for pattern, action in section.items():
        rules.append(Rule(permission_key, expand_home(pattern), action))
    return rules


def ruleset_from_permission(permission: dict[str, Any]) -> list[Rule]:
    rules: list[Rule] = []
    for key, value in permission.items():
        rules.extend(ruleset_from_section(key, value))
    return rules


def evaluate(permission: str, pattern: str, *rulesets: Iterable[Rule]) -> Rule:
    merged = [rule for ruleset in rulesets for rule in ruleset]
    for rule in reversed(merged):
        if wildcard_match(permission, rule.permission) and wildcard_match(pattern, rule.pattern):
            return rule
    return Rule(permission, "*", "ask")


def effective_bash_action(permission: dict[str, Any], command: str) -> Action:
    bash = permission.get("bash")
    if isinstance(bash, str):
        return bash
    rules = ruleset_from_section("bash", bash) if bash is not None else []
    return evaluate("bash", command, rules).action


def effective_edit_action(permission: dict[str, Any], path: str) -> Action:
    edit = permission.get("edit")
    if isinstance(edit, str):
        return edit
    rules = ruleset_from_section("edit", edit) if edit is not None else []
    return evaluate("edit", path, rules).action


def effective_read_action(permission: dict[str, Any], path: str) -> Action:
    read = permission.get("read")
    if isinstance(read, str):
        return read
    rules = ruleset_from_section("read", read) if read is not None else []
    return evaluate("read", path, rules).action


def bash_is_allowed(permission: dict[str, Any], command: str) -> bool:
    return effective_bash_action(permission, command) == "allow"


def bash_is_denied(permission: dict[str, Any], command: str) -> bool:
    return effective_bash_action(permission, command) == "deny"


def edit_is_allowed(permission: dict[str, Any], path: str) -> bool:
    return effective_edit_action(permission, path) == "allow"


def matching_rules(permission: dict[str, Any], perm_key: str, pattern: str) -> list[tuple[str, Action]]:
    section = permission.get(perm_key)
    if isinstance(section, str):
        return [("*", section)] if wildcard_match(perm_key, perm_key) else []
    if not isinstance(section, dict):
        return []
    rules = ruleset_from_section(perm_key, section)
    matched: list[tuple[str, Action]] = []
    for rule in rules:
        if wildcard_match(perm_key, rule.permission) and wildcard_match(pattern, rule.pattern):
            matched.append((rule.pattern, rule.action))
    return matched


def winning_rule(permission: dict[str, Any], perm_key: str, pattern: str) -> tuple[str, Action]:
    section = permission.get(perm_key)
    if isinstance(section, str):
        return ("*", section)
    rules = ruleset_from_section(perm_key, section) if isinstance(section, dict) else []
    rule = evaluate(perm_key, pattern, rules)
    return (rule.pattern, rule.action)
