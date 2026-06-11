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
    ("git status & touch changed.txt", "deny"),
    ("npm test & touch changed.txt", "deny"),
    ("git status\ntouch changed.txt", "deny"),
    ("git status\rtouch changed.txt", "deny"),
    ("ls <(touch changed.txt)", "deny"),
    ("ls >(touch changed.txt)", "deny"),
    ("git status < changed.txt", "deny"),
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
    ("tree -o changed.txt", "deny"),
    ("git diff --output=changed.txt", "deny"),
    ("git diff --ext-diff", "deny"),
    ("git diff --textconv", "deny"),
    ("git log --output=changed.txt", "deny"),
    ("git show --output=changed.txt", "deny"),
    ("git show --ext-diff", "deny"),
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
    "tree",
    "git status",
    "git status --short",
    "git status --porcelain",
    "git diff",
    "git diff --stat",
    "git diff --name-only",
    "git diff --name-status",
    "git log",
    "git log -1",
    "git log --oneline",
    "git show",
    "git show HEAD",
    "git rev-parse HEAD",
    "git rev-parse --show-toplevel",
    "git ls-files",
]

VERIFIER_FORBIDDEN = [
    (cmd, expected)
    for cmd, expected in ADVERSARIAL_READONLY_BASH
    if cmd not in {"npm test", "cargo check"}
] + [
    ("cargo fmt", "deny"),
    ("cargo fmt --all", "deny"),
    ("cargo clippy --fix", "deny"),
    ("cargo clippy --fix --allow-dirty", "deny"),
    ("cargo fmt --check -- --emit files", "deny"),
    ("npm run lint -- --fix", "deny"),
    ("pnpm run lint -- --fix", "deny"),
    ("yarn run lint --fix", "deny"),
    ("bun run lint --fix", "deny"),
    ("npm test -- --updateSnapshot", "deny"),
    ("pnpm test -- --updateSnapshot", "deny"),
    ("yarn test --updateSnapshot", "deny"),
    ("bun test --updateSnapshot", "deny"),
    ("npm test -- -u", "deny"),
    ("pnpm test -- -u", "deny"),
    ("yarn test -u", "deny"),
    ("bun test -u", "deny"),
    ("npm test -- --update", "deny"),
    ("npm run build -- --outDir src", "deny"),
    ("npm run typecheck -- --outDir src", "deny"),
    ("npm run verify -- --fix", "deny"),
    ("cargo test -- --update", "deny"),
    ("npm run deploy", "deny"),
    ("npm run migrate", "deny"),
    ("npm run seed", "deny"),
    ("npm run reset", "deny"),
]

VERIFIER_ALLOWED = [
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "npm run verify",
    "pnpm test",
    "pnpm run lint",
    "bun test",
    "yarn test",
    "cargo check",
    "cargo clippy",
    "cargo test",
    "cargo fmt --check",
]

RESTRICTIVE_BROAD_ALLOW_PATTERNS = [
    "tree *",
    "git status *",
    "git diff *",
    "git log *",
    "git show *",
    "npm test *",
    "npm run test *",
    "npm run lint *",
    "npm run build *",
    "npm run typecheck *",
    "npm run verify *",
    "cargo fmt *",
    "cargo clippy *",
    "cargo test *",
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

    def test_newline_deny_pattern(self) -> None:
        perm = {"bash": {"*": "deny", "*\n*": "deny", "git status": "allow"}}
        self.assertEqual(effective_bash_action(perm, "git status\ntouch changed.txt"), "deny")

    def test_carriage_return_deny_pattern(self) -> None:
        perm = {"bash": {"*": "deny", "*\r*": "deny", "git status": "allow"}}
        self.assertEqual(effective_bash_action(perm, "git status\rtouch changed.txt"), "deny")

    def test_single_ampersand_deny(self) -> None:
        perm = {"bash": {"*": "deny", "*&*": "deny", "git status": "allow"}}
        self.assertEqual(effective_bash_action(perm, "git status & touch changed.txt"), "deny")


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

    def test_no_broad_allow_patterns(self) -> None:
        for role in READONLY_ROLES + ("scribe", "verifier"):
            perm = compose_role_permission(load_role(role))
            bash = perm.get("bash", {})
            self.assertIsInstance(bash, dict)
            for pattern in RESTRICTIVE_BROAD_ALLOW_PATTERNS:
                with self.subTest(role=role, pattern=pattern):
                    self.assertNotEqual(
                        bash.get(pattern),
                        "allow",
                        f"{role} must not broadly allow {pattern!r}",
                    )


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


class TestMutationRejection(unittest.TestCase):
    """Widening restrictive patterns in memory must change effective action."""

    def _mutated_action(self, role: str, bash_patch: dict[str, str], command: str) -> str:
        perm = compose_role_permission(load_role(role))
        bash = perm.setdefault("bash", {})
        assert isinstance(bash, dict)
        bash.update(bash_patch)
        return effective_bash_action(perm, command)

    def test_widen_ampersand_allows_bypass(self) -> None:
        action = self._mutated_action("repo-scout", {"*&*": "allow"}, "git status & touch changed.txt")
        self.assertEqual(action, "allow")

    def test_widen_tree_allows_bypass_when_flag_deny_removed(self) -> None:
        perm = compose_role_permission(load_role("repo-scout"))
        bash = perm.setdefault("bash", {})
        assert isinstance(bash, dict)
        bash.pop("tree -*", None)
        bash["tree *"] = "allow"
        self.assertEqual(effective_bash_action(perm, "tree -o changed.txt"), "allow")

    def test_widen_cargo_clippy_allows_fix(self) -> None:
        action = self._mutated_action("verifier", {"cargo clippy *": "allow"}, "cargo clippy --fix")
        self.assertEqual(action, "allow")

    def test_widen_npm_build_allows_outdir(self) -> None:
        action = self._mutated_action(
            "verifier", {"npm run build *": "allow"}, "npm run build -- --outDir src"
        )
        self.assertEqual(action, "allow")

    def test_remove_credential_deny(self) -> None:
        perm = compose_role_permission(load_role("repo-scout"))
        read = perm.setdefault("read", {})
        assert isinstance(read, dict)
        read.pop("**/.env*", None)
        self.assertNotEqual(read.get("**/.env*"), "deny")

    def test_scribe_agents_edit_would_allow(self) -> None:
        perm = compose_role_permission(load_role("scribe"))
        edit = perm.setdefault("edit", {})
        assert isinstance(edit, dict)
        edit["agents/**"] = "allow"
        self.assertTrue(edit_is_allowed(perm, "agents/architect.md"))

    def test_restore_git_diff_wildcard_allows_ext_diff(self) -> None:
        action = self._mutated_action("repo-scout", {"git diff *": "allow"}, "git diff --ext-diff")
        self.assertEqual(action, "allow")


if __name__ == "__main__":
    unittest.main()
