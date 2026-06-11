#!/usr/bin/env python3
"""Semantic validation of composed OpenCode agent permission boundaries."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from opencode_policy_compose import compose_role_permission  # noqa: E402

ROLES_DIR = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode" / "agents"

READONLY_ROLES = ("repo-scout", "inspector", "sentinel")
ALL_ROLES = ("architect", "repo-scout", "inspector", "sentinel", "scribe", "verifier")

MUTATING_BASH = [
    "git add",
    "git commit",
    "mkdir",
    "touch",
    "cp",
    "mv",
    "rm",
    "npm install",
    "pnpm install",
]

VERIFIER_FORBIDDEN = MUTATING_BASH + [
    "npm run deploy",
    "npm run migrate",
    "npm run seed",
    "npm run reset",
]

VERIFIER_REQUIRED = [
    "npm test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "cargo check",
    "cargo clippy",
    "cargo test",
]

SOURCE_EDIT_PATTERNS = [
    "src/**",
    "app/**",
    "components/**",
    "scripts/**",
    "tests/**",
    "*.ts",
    "*.tsx",
]

DESTRUCTIVE_BASH = [
    "rm -rf*",
    "sudo*",
    "git reset --hard*",
    "git push --force*",
]

SECRET_READ = ["**/.env*", "**/id_rsa"]


def load_role(name: str) -> dict:
    return json.loads((ROLES_DIR / f"{name}.role.json").read_text(encoding="utf-8"))


def bash_allows(permission: dict, command: str) -> bool:
    bash = permission.get("bash", {})
    if isinstance(bash, str):
        return bash == "allow"
    for pattern, action in bash.items():
        if _bash_pattern_matches(pattern, command) and action == "allow":
            return True
    return False


def edit_allows(permission: dict, path: str) -> bool:
    edit = permission.get("edit", {})
    if isinstance(edit, str):
        return edit == "allow"
    for pattern, action in edit.items():
        if _glob_matches(pattern, path) and action == "allow":
            return True
    return False


def _bash_pattern_matches(pattern: str, command: str) -> bool:
    pat = pattern.rstrip("*").strip()
    if pattern.endswith("*"):
        return command == pat or command.startswith(pat + " ") or command.startswith(pat)
    return command == pattern


def _glob_matches(pattern: str, path: str) -> bool:
    from fnmatch import fnmatch

    if pattern == "*":
        return True
    return fnmatch(path, pattern)


def validate() -> list[str]:
    errors: list[str] = []

    for role in READONLY_ROLES:
        perm = compose_role_permission(load_role(role))
        if perm.get("edit") != "deny":
            errors.append(f"{role}: edit must be deny")
        if perm.get("task") != "deny":
            errors.append(f"{role}: task must be deny")
        for cmd in MUTATING_BASH:
            if bash_allows(perm, cmd):
                errors.append(f"{role}: must not allow bash {cmd}")

    verifier = compose_role_permission(load_role("verifier"))
    if verifier.get("edit") != "deny":
        errors.append("verifier: edit must be deny")
    for cmd in VERIFIER_REQUIRED:
        if not bash_allows(verifier, cmd):
            errors.append(f"verifier: must allow bash {cmd}")
    for cmd in VERIFIER_FORBIDDEN:
        if bash_allows(verifier, cmd):
            errors.append(f"verifier: must not allow bash {cmd}")

    scribe = compose_role_permission(load_role("scribe"))
    if not edit_allows(scribe, "README.md") or not edit_allows(scribe, "docs/guide.md"):
        errors.append("scribe: documentation paths must be editable")
    for path in ("src/App.tsx", "scripts/foo.py", "components/Button.tsx"):
        if edit_allows(scribe, path):
            errors.append(f"scribe: must not allow edit {path}")
    edit = scribe.get("edit", {})
    if isinstance(edit, dict):
        for pattern in SOURCE_EDIT_PATTERNS:
            if edit.get(pattern) == "allow":
                errors.append(f"scribe: must not allow edit pattern {pattern}")
    for cmd in MUTATING_BASH:
        if bash_allows(scribe, cmd):
            errors.append(f"scribe: must not allow bash {cmd}")

    architect = compose_role_permission(load_role("architect"))
    if not edit_allows(architect, "src/App.tsx"):
        errors.append("architect: must allow source edit")
    if not bash_allows(architect, "git commit -m test"):
        errors.append("architect: must allow git commit")
    task = architect.get("task", {})
    if not isinstance(task, dict) or task.get("repo-scout") != "allow":
        errors.append("architect: must allow repo-scout delegation")

    for role in ALL_ROLES:
        perm = compose_role_permission(load_role(role))
        read = perm.get("read", {})
        if isinstance(read, dict):
            for pat in SECRET_READ:
                if read.get(pat) != "deny":
                    errors.append(f"{role}: missing read deny {pat}")
        bash = perm.get("bash", {})
        if isinstance(bash, dict):
            for pat in DESTRUCTIVE_BASH:
                if bash.get(pat) != "deny":
                    errors.append(f"{role}: missing bash deny {pat}")
        edit = perm.get("edit", {})
        if isinstance(edit, dict):
            for pat in SECRET_READ:
                if edit.get(pat) != "deny":
                    errors.append(f"{role}: missing edit deny {pat}")

    return errors


def main() -> None:
    errors = validate()
    if errors:
        print("FAIL: OpenCode permission contract validation failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)
    print(f"PASS: OpenCode permission contract valid for {len(ALL_ROLES)} roles")


if __name__ == "__main__":
    main()
