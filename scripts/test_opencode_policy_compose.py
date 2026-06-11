#!/usr/bin/env python3
"""Regression tests for OpenCode permission composition."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from opencode_policy_compose import compose_role_permission  # noqa: E402

ROLES_DIR = REPO_ROOT / "resources" / "default-workspace" / "templates" / "opencode" / "agents"

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

SOURCE_EDIT_PATTERNS = [
    "src/**",
    "app/**",
    "components/**",
    "scripts/**",
    "tests/**",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
]


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


def edit_denied(permission: dict) -> bool:
    edit = permission.get("edit", {})
    return edit == "deny" or (
        isinstance(edit, dict) and edit.get("*") == "deny" and not any(
            v == "allow" for k, v in edit.items() if k != "*"
        )
    )


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


class TestReadOnlyRoles(unittest.TestCase):
    ROLES = ("repo-scout", "inspector", "sentinel")

    def test_edit_denied(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                perm = compose_role_permission(load_role(role))
                self.assertEqual(perm.get("edit"), "deny", f"{role} must deny edit")

    def test_task_denied(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                perm = compose_role_permission(load_role(role))
                self.assertEqual(perm.get("task"), "deny", f"{role} must deny task")

    def test_no_mutating_bash(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                perm = compose_role_permission(load_role(role))
                for cmd in MUTATING_BASH:
                    self.assertFalse(
                        bash_allows(perm, cmd),
                        f"{role} must not allow bash: {cmd}",
                    )

    def test_inspection_bash_allowed(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                perm = compose_role_permission(load_role(role))
                self.assertTrue(bash_allows(perm, "git status"))
                self.assertTrue(bash_allows(perm, "git diff"))


class TestVerifier(unittest.TestCase):
    def setUp(self) -> None:
        self.perm = compose_role_permission(load_role("verifier"))

    def test_edit_denied(self) -> None:
        self.assertEqual(self.perm.get("edit"), "deny")

    def test_verification_commands_allowed(self) -> None:
        for cmd in (
            "npm test",
            "npm run lint",
            "npm run typecheck",
            "npm run build",
            "cargo check",
            "cargo clippy",
            "cargo test",
        ):
            with self.subTest(cmd=cmd):
                self.assertTrue(bash_allows(self.perm, cmd), f"verifier must allow {cmd}")

    def test_no_git_or_fs_mutations(self) -> None:
        for cmd in MUTATING_BASH + [
            "npm run deploy",
            "npm run migrate",
            "npm run seed",
            "npm run reset",
        ]:
            with self.subTest(cmd=cmd):
                self.assertFalse(bash_allows(self.perm, cmd), f"verifier must not allow {cmd}")


class TestScribe(unittest.TestCase):
    def setUp(self) -> None:
        self.perm = compose_role_permission(load_role("scribe"))

    def test_documentation_edit_allowed(self) -> None:
        self.assertTrue(edit_allows(self.perm, "README.md"))
        self.assertTrue(edit_allows(self.perm, "docs/guide.md"))

    def test_source_edit_denied(self) -> None:
        for path in ("src/App.tsx", "app/page.tsx", "components/Button.tsx", "scripts/foo.py"):
            with self.subTest(path=path):
                self.assertFalse(edit_allows(self.perm, path), f"scribe must not edit {path}")

    def test_source_patterns_not_allowed(self) -> None:
        edit = self.perm.get("edit", {})
        self.assertIsInstance(edit, dict)
        for pattern in SOURCE_EDIT_PATTERNS:
            with self.subTest(pattern=pattern):
                self.assertNotEqual(
                    edit.get(pattern),
                    "allow",
                    f"scribe must not allow edit pattern {pattern}",
                )

    def test_no_mutating_bash(self) -> None:
        for cmd in MUTATING_BASH:
            with self.subTest(cmd=cmd):
                self.assertFalse(bash_allows(self.perm, cmd))


class TestArchitect(unittest.TestCase):
    def setUp(self) -> None:
        self.perm = compose_role_permission(load_role("architect"))

    def test_implementation_edit_allowed(self) -> None:
        self.assertTrue(edit_allows(self.perm, "src/App.tsx"))

    def test_git_commit_allowed(self) -> None:
        self.assertTrue(bash_allows(self.perm, "git add ."))
        self.assertTrue(bash_allows(self.perm, "git commit -m test"))

    def test_delegation_allowed(self) -> None:
        task = self.perm.get("task", {})
        self.assertIsInstance(task, dict)
        self.assertEqual(task.get("repo-scout"), "allow")


class TestSecretDenials(unittest.TestCase):
    ROLES = (
        "architect",
        "repo-scout",
        "inspector",
        "sentinel",
        "scribe",
        "verifier",
    )

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
