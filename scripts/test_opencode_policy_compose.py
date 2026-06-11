#!/usr/bin/env python3
"""Regression tests for OpenCode permission composition and adversarial command matrix."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from opencode_permission_eval import (  # noqa: E402
    bash_is_allowed,
    edit_is_allowed,
    effective_bash_action,
    wildcard_match,
    winning_rule,
)
from opencode_policy_compose import compose_role_permission  # noqa: E402

ROLES_DIR = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode" / "agents"

READONLY_ROLES = ("repo-scout", "inspector", "sentinel")

ADVERSARIAL_READONLY_BASH = [
    ("git add .", "deny"),
    ("git commit -m test", "deny"),
    ("git branch temporary-branch", "deny"),
    ("git branch -D temporary-branch", "deny"),
    ("mkdir changed", "deny"),
    ("touch changed.txt", "deny"),
    ("cp source destination", "deny"),
    ("mv source destination", "deny"),
    ("rm file", "deny"),
    ("find . -delete", "deny"),
    ("find . -exec touch changed.txt ;", "deny"),
    ("find . -ok rm file ;", "deny"),
    ("find . -fprint changed.txt", "deny"),
    ("git diff > changed.txt", "deny"),
    ("git diff >> changed.txt", "deny"),
    ("git status > changed.txt", "deny"),
    ("ls > changed.txt", "deny"),
    ("git status | sh", "deny"),
    ("git status | bash", "deny"),
    ("git status && touch changed.txt", "deny"),
    ("git status || touch changed.txt", "deny"),
    ("git status ; touch changed.txt", "deny"),
    ("echo $(touch changed.txt)", "deny"),
    ("echo `touch changed.txt`", "deny"),
    ("git diff --output=changed.txt", "deny"),
    ("git log --output=changed.txt", "deny"),
    ("git show --output=changed.txt", "deny"),
    ("git checkout main", "deny"),
    ("git switch main", "deny"),
    ("git restore .", "deny"),
    ("git reset HEAD", "deny"),
    ("git clean -fd", "deny"),
    ("git stash", "deny"),
    ("git tag v1", "deny"),
    ("git fetch", "deny"),
    ("git pull", "deny"),
    ("git merge main", "deny"),
    ("git rebase main", "deny"),
    ("npm install", "deny"),
    ("npm test", "deny"),
    ("cargo check", "deny"),
]

READONLY_BASH_ALLOW = [
    "pwd",
    "ls",
    "ls -la",
    "git status",
    "git diff",
    "git diff --stat",
    "git log -1",
    "git show HEAD",
    "git rev-parse HEAD",
    "git ls-files",
]

VERIFIER_FORBIDDEN = [
    (cmd, expected)
    for cmd, expected in ADVERSARIAL_READONLY_BASH
    if cmd not in {"npm test", "cargo check"}
] + [
    ("cargo fmt", "deny"),
    ("cargo fmt --all", "deny"),
    ("npm run lint -- --fix", "deny"),
    ("pnpm run lint -- --fix", "deny"),
    ("yarn run lint --fix", "deny"),
    ("bun run lint --fix", "deny"),
    ("npm test -- --updateSnapshot", "deny"),
    ("npm test -- -u", "deny"),
    ("npm run deploy", "deny"),
    ("npm run migrate", "deny"),
    ("npm run seed", "deny"),
    ("npm run reset", "deny"),
]

VERIFIER_ALLOWED = [
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
    "pnpm-lock.yaml",
    "agents/architect.md",
    "templates/opencode/agents/architect.role.json",
    ".github/workflows/ci.yml",
    ".env",
    "AGENTS.md",
    "random.md",
]


def load_role(name: str) -> dict:
    return json.loads((ROLES_DIR / f"{name}.role.json").read_text(encoding="utf-8"))


class TestWildcardSemantics(unittest.TestCase):
    def test_trailing_space_wildcard_optional_args(self) -> None:
        self.assertTrue(wildcard_match("git status", "git status *"))
        self.assertTrue(wildcard_match("git status --porcelain", "git status *"))
        self.assertFalse(wildcard_match("git statusify", "git status *"))

    def test_findlast_precedence(self) -> None:
        perm = {
            "bash": {
                "*": "deny",
                "git diff *": "allow",
                "*>*": "deny",
            }
        }
        self.assertEqual(effective_bash_action(perm, "git diff > changed.txt"), "deny")


class TestReadOnlyRoles(unittest.TestCase):
    def test_edit_and_task_denied(self) -> None:
        for role in READONLY_ROLES:
            with self.subTest(role=role):
                perm = compose_role_permission(load_role(role))
                self.assertEqual(perm.get("edit"), "deny")
                self.assertEqual(perm.get("task"), "deny")

    def test_adversarial_bash_matrix(self) -> None:
        for role in READONLY_ROLES:
            perm = compose_role_permission(load_role(role))
            for command, expected in ADVERSARIAL_READONLY_BASH:
                with self.subTest(role=role, command=command):
                    action = effective_bash_action(perm, command)
                    self.assertEqual(
                        action,
                        expected,
                        f"{role} {command!r}: expected {expected}, got {action} "
                        f"({winning_rule(perm, 'bash', command)})",
                    )

    def test_inspection_bash_allowed(self) -> None:
        for role in READONLY_ROLES:
            perm = compose_role_permission(load_role(role))
            for cmd in READONLY_BASH_ALLOW:
                with self.subTest(role=role, cmd=cmd):
                    self.assertTrue(bash_is_allowed(perm, cmd), f"{role} must allow {cmd}")


class TestVerifier(unittest.TestCase):
    def setUp(self) -> None:
        self.perm = compose_role_permission(load_role("verifier"))

    def test_edit_denied(self) -> None:
        self.assertEqual(self.perm.get("edit"), "deny")

    def test_verification_commands_allowed(self) -> None:
        for cmd in VERIFIER_ALLOWED:
            with self.subTest(cmd=cmd):
                self.assertTrue(bash_is_allowed(self.perm, cmd), f"verifier must allow {cmd}")

    def test_forbidden_commands(self) -> None:
        for command, expected in VERIFIER_FORBIDDEN:
            with self.subTest(command=command):
                self.assertEqual(effective_bash_action(self.perm, command), expected)


class TestScribe(unittest.TestCase):
    def setUp(self) -> None:
        self.perm = compose_role_permission(load_role("scribe"))

    def test_documentation_edit_allowed(self) -> None:
        self.assertTrue(edit_is_allowed(self.perm, "README.md"))
        self.assertTrue(edit_is_allowed(self.perm, "docs/guide.md"))

    def test_source_and_config_edit_denied(self) -> None:
        for path in SCRIBE_EDIT_DENY:
            with self.subTest(path=path):
                self.assertFalse(edit_is_allowed(self.perm, path), f"scribe must not edit {path}")

    def test_no_mutating_bash(self) -> None:
        for command, expected in ADVERSARIAL_READONLY_BASH:
            with self.subTest(command=command):
                self.assertEqual(effective_bash_action(self.perm, command), expected)


class TestArchitect(unittest.TestCase):
    def setUp(self) -> None:
        self.perm = compose_role_permission(load_role("architect"))

    def test_implementation_edit_allowed(self) -> None:
        self.assertTrue(edit_is_allowed(self.perm, "src/App.tsx"))

    def test_git_commit_allowed(self) -> None:
        self.assertTrue(bash_is_allowed(self.perm, "git add ."))
        self.assertTrue(bash_is_allowed(self.perm, "git commit -m test"))

    def test_delegation_allowed(self) -> None:
        task = self.perm.get("task", {})
        self.assertIsInstance(task, dict)
        self.assertEqual(task.get("repo-scout"), "allow")


class TestSecretDenials(unittest.TestCase):
    ROLES = ("architect", "repo-scout", "inspector", "sentinel", "scribe", "verifier")

    def test_credential_read_denied(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                read = compose_role_permission(load_role(role)).get("read", {})
                self.assertIsInstance(read, dict)
                self.assertEqual(read.get("**/.env*"), "deny")
                self.assertEqual(read.get("**/id_rsa"), "deny")

    def test_destructive_bash_denied(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                bash = compose_role_permission(load_role(role)).get("bash", {})
                self.assertIsInstance(bash, dict)
                for pat in ("rm -rf*", "sudo*", "git reset --hard*", "git push --force*"):
                    self.assertEqual(bash.get(pat), "deny", f"{role} missing deny {pat}")


if __name__ == "__main__":
    unittest.main()
