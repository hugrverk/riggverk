#!/usr/bin/env python3
"""Semantic validation of composed OpenCode agent permission boundaries."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from opencode_permission_eval import (  # noqa: E402
    bash_is_allowed,
    edit_is_allowed,
    winning_rule,
)
from opencode_policy_compose import compose_opencode_header, compose_role_permission, load_policy  # noqa: E402

ROLES_DIR = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode" / "agents"
AGENTS_DIR = REPO_ROOT / "resources" / "default-workspace" / "agents"
POLICY_PATH = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode.policy.json"

READONLY_ROLES = ("repo-scout", "inspector", "sentinel")
ALL_ROLES = ("architect", "repo-scout", "inspector", "sentinel", "scribe", "verifier")

SECRET_READ = ["**/.env*", "**/id_rsa"]
DESTRUCTIVE_BASH = ["rm -rf*", "sudo*", "git reset --hard*", "git push --force*"]

READONLY_BASH_DENY = [
    "git add .",
    "git commit -m test",
    "git branch temporary-branch",
    "git branch -D temporary-branch",
    "mkdir changed",
    "touch changed.txt",
    "cp source destination",
    "mv source destination",
    "rm file",
    "find . -delete",
    "find . -exec touch changed.txt ;",
    "git diff > changed.txt",
    "git diff >> changed.txt",
    "git status > changed.txt",
    "ls > changed.txt",
    "git status | sh",
    "git status | bash",
    "git status && touch changed.txt",
    "git status || touch changed.txt",
    "git status ; touch changed.txt",
    "git diff --output=changed.txt",
    "git checkout main",
    "git switch main",
    "git restore .",
    "git reset HEAD",
    "git clean -fd",
    "git stash",
    "git tag v1",
    "git fetch",
    "git pull",
    "npm install",
    "npm test",
    "cargo check",
]

VERIFIER_FORBIDDEN = [
    cmd
    for cmd in READONLY_BASH_DENY
    if cmd not in {"npm test", "cargo check"}
] + [
    "cargo fmt",
    "cargo fmt --all",
    "npm run lint -- --fix",
    "pnpm run lint -- --fix",
    "yarn run lint --fix",
    "bun run lint --fix",
    "npm test -- --updateSnapshot",
    "npm test -- -u",
    "npm run deploy",
    "npm run migrate",
]

VERIFIER_REQUIRED = [
    "npm test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "cargo check",
    "cargo clippy",
    "cargo test",
    "cargo fmt --check",
]

SCRIBE_EDIT_DENY = [
    "src/App.tsx",
    "app/page.tsx",
    "components/Button.tsx",
    "scripts/tool.py",
    "tests/example.test.ts",
    "package.json",
    "package-lock.json",
    "agents/architect.md",
    "templates/opencode/agents/architect.role.json",
    ".github/workflows/ci.yml",
    ".env",
    "AGENTS.md",
]

RESTRICTIVE_BASH_FORBIDDEN_PATTERNS = ("find *", "git branch*", "cargo fmt*")


def load_role(name: str) -> dict:
    return json.loads((ROLES_DIR / f"{name}.role.json").read_text(encoding="utf-8"))


def _bash_section(permission: dict) -> dict[str, str]:
    bash = permission.get("bash", {})
    if isinstance(bash, str):
        return {"*": bash}
    if isinstance(bash, dict):
        return bash
    return {}


def _edit_section(permission: dict) -> dict[str, str]:
    edit = permission.get("edit", {})
    if isinstance(edit, str):
        return {"*": edit}
    if isinstance(edit, dict):
        return edit
    return {}


def _validate_restrictive_profile_quality(role: str, perm: dict, errors: list[str]) -> None:
    bash = _bash_section(perm)
    if bash.get("*") != "deny":
        errors.append(f"{role}: restrictive bash profile must default to deny")
    for pattern in RESTRICTIVE_BASH_FORBIDDEN_PATTERNS:
        action = bash.get(pattern)
        if action == "allow":
            errors.append(f"{role}: must not allow bash pattern {pattern}")
    if role == "verifier" and bash.get("cargo fmt*") == "allow":
        errors.append("verifier: must not allow cargo fmt wildcard")


def validate() -> list[str]:
    errors: list[str] = []

    policy = load_policy()
    for profile_name in ("bash_readonly", "bash_verifier"):
        profile = policy.get("role_profiles", {}).get(profile_name, {})
        if profile.get("default") != "deny":
            errors.append(f"role_profiles.{profile_name}: default must be deny")

    for role in READONLY_ROLES:
        perm = compose_role_permission(load_role(role))
        if perm.get("edit") != "deny":
            errors.append(f"{role}: edit must be deny")
        if perm.get("task") != "deny":
            errors.append(f"{role}: task must be deny")
        _validate_restrictive_profile_quality(role, perm, errors)
        for cmd in READONLY_BASH_DENY:
            if bash_is_allowed(perm, cmd):
                pattern, action = winning_rule(perm, "bash", cmd)
                errors.append(f"{role}: must not allow bash {cmd!r} (matched {pattern!r} -> {action})")

    verifier = compose_role_permission(load_role("verifier"))
    if verifier.get("edit") != "deny":
        errors.append("verifier: edit must be deny")
    _validate_restrictive_profile_quality("verifier", verifier, errors)
    for cmd in VERIFIER_REQUIRED:
        if not bash_is_allowed(verifier, cmd):
            pattern, action = winning_rule(verifier, "bash", cmd)
            errors.append(f"verifier: must allow bash {cmd!r} (effective {action} via {pattern!r})")
    for cmd in VERIFIER_FORBIDDEN:
        if bash_is_allowed(verifier, cmd):
            pattern, action = winning_rule(verifier, "bash", cmd)
            errors.append(f"verifier: must not allow bash {cmd!r} (matched {pattern!r} -> {action})")

    scribe = compose_role_permission(load_role("scribe"))
    if not edit_is_allowed(scribe, "README.md") or not edit_is_allowed(scribe, "docs/guide.md"):
        errors.append("scribe: documentation paths must be editable")
    for path in SCRIBE_EDIT_DENY:
        if edit_is_allowed(scribe, path):
            pattern, action = winning_rule(scribe, "edit", path)
            errors.append(f"scribe: must not allow edit {path!r} (matched {pattern!r} -> {action})")
    _validate_restrictive_profile_quality("scribe", scribe, errors)
    for cmd in READONLY_BASH_DENY:
        if bash_is_allowed(scribe, cmd):
            errors.append(f"scribe: must not allow bash {cmd!r}")

    architect = compose_role_permission(load_role("architect"))
    if not edit_is_allowed(architect, "src/App.tsx"):
        errors.append("architect: must allow source edit")
    if not bash_is_allowed(architect, "git commit -m test"):
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

    for role in ALL_ROLES:
        agent_path = AGENTS_DIR / f"{role}.md"
        role_path = ROLES_DIR / f"{role}.role.json"
        if not agent_path.is_file():
            errors.append(f"missing generated OpenCode agent: {agent_path.name}")
            continue
        expected_header = compose_opencode_header(role_path)
        actual = agent_path.read_text(encoding="utf-8")
        if not actual.startswith(f"---\n{expected_header}---"):
            errors.append(f"{role}: generated adapter drift (run generate-agent-adapters.py --write)")

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
