#!/usr/bin/env python3
"""Regression tests for OpenCode permission composition and adversarial command matrix."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from opencode_permission_eval import (  # noqa: E402
    bash_is_allowed,
    edit_is_allowed,
    effective_bash_action,
    effective_read_action,
    wildcard_match,
    winning_rule,
)
import opencode_policy_compose  # noqa: E402
from opencode_policy_compose import (  # noqa: E402
    build_base_permission,
    compose_opencode_header,
    compose_role_permission,
    load_policy,
    permission_to_yaml,
    unknown_policy_keys,
)
from validate_opencode_permissions import (  # noqa: E402
    ARCHITECT_BASH_ACTIONS,
    CREDENTIAL_CONFIG_READ,
    READ_ACTIONS,
    SECRET_READ,
    _secret_read_errors,
    lexical_frontmatter_errors,
    validate_agent_frontmatter,
)

try:
    import yaml
except ImportError:  # PyYAML is optional; the lexical check still runs
    yaml = None

TEMPLATES_DIR = REPO_ROOT / "resources" / "default-workspace" / "templates"
ROLES_DIR = TEMPLATES_DIR / "opencode" / "agents"
SHIPPED_GENERATOR = REPO_ROOT / "resources" / "default-workspace" / "scripts" / "generate-opencode-config.py"
REPO_GENERATOR = REPO_ROOT / "scripts" / "generate-default-opencode-config.py"

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

    def test_dot_matches_newline_like_upstream(self) -> None:
        # Upstream compiles with the "s" flag, so `*` spans newlines.
        self.assertTrue(wildcard_match("git diff --stat\ntouch changed.txt", "git diff *"))
        self.assertTrue(wildcard_match("a\rb", "a*b"))
        perm = {"bash": {"*": "deny", "git diff *": "allow"}}
        self.assertEqual(effective_bash_action(perm, "git diff --stat\ntouch changed.txt"), "allow")

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

    def test_question_tool_allowed_for_architect_only(self) -> None:
        self.assertEqual(self.perm.get("question"), "allow")
        for role in ("repo-scout", "inspector", "sentinel", "scribe", "verifier"):
            with self.subTest(role=role):
                self.assertEqual(compose_role_permission(load_role(role)).get("question"), "deny")

    def test_broad_allows_do_not_cover_dangerous_variants(self) -> None:
        for command, expected in ARCHITECT_BASH_ACTIONS:
            with self.subTest(command=command):
                action = effective_bash_action(self.perm, command)
                self.assertEqual(
                    action,
                    expected,
                    f"{command!r}: expected {expected}, got {action} ({winning_rule(self.perm, 'bash', command)})",
                )

    def test_no_override_allow_follows_redirect_guard(self) -> None:
        # Last match wins: an allow placed after the `*>*` ask would let `cmd > file` through.
        bash = list(self.perm["bash"].items())
        guard = next(i for i, (pattern, _) in enumerate(bash) if pattern == "*>*")
        late_allows = [pattern for pattern, action in bash[guard + 1 :] if action == "allow"]
        self.assertEqual(late_allows, [])

    def test_read_denies_credential_config(self) -> None:
        for path, expected in READ_ACTIONS:
            with self.subTest(path=path):
                self.assertEqual(effective_read_action(self.perm, path), expected)


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

    def test_remove_credential_deny_is_detected(self) -> None:
        for pattern in SECRET_READ + CREDENTIAL_CONFIG_READ:
            with self.subTest(pattern=pattern):
                perm = compose_role_permission(load_role("repo-scout"))
                self.assertEqual(_secret_read_errors("repo-scout", perm), [])
                read = perm["read"]
                assert isinstance(read, dict)
                read.pop(pattern)
                self.assertTrue(any(pattern in err for err in _secret_read_errors("repo-scout", perm)))

    def test_scribe_agents_edit_would_allow(self) -> None:
        perm = compose_role_permission(load_role("scribe"))
        edit = perm.setdefault("edit", {})
        assert isinstance(edit, dict)
        edit["agents/**"] = "allow"
        self.assertTrue(edit_is_allowed(perm, "agents/architect.md"))

    def test_restore_git_diff_wildcard_allows_ext_diff(self) -> None:
        action = self._mutated_action("repo-scout", {"git diff *": "allow"}, "git diff --ext-diff")
        self.assertEqual(action, "allow")


# Output of the emitter before keys were quoted: a bare `*` starts a YAML alias.
OLD_STYLE_HEADER = """name: verifier
description: Run verification.
mode: subagent
temperature: 0.1
steps: 50
permission:
  *: ask
  read:
    "*": allow
"""


class TestAgentFrontmatter(unittest.TestCase):
    ROLES = ("architect", "repo-scout", "inspector", "sentinel", "scribe", "verifier")
    AGENTS_DIR = REPO_ROOT / "resources" / "default-workspace" / "agents"

    def test_generated_agents_parse_back_to_composed_role(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                role_def = load_role(role)
                text = (self.AGENTS_DIR / f"{role}.md").read_text(encoding="utf-8")
                self.assertEqual(
                    validate_agent_frontmatter(role, text, role_def, compose_role_permission(role_def)), []
                )

    @unittest.skipIf(yaml is None, "PyYAML not installed")
    def test_composed_header_round_trips_through_yaml_in_order(self) -> None:
        for role in self.ROLES:
            with self.subTest(role=role):
                role_def = load_role(role)
                parsed = yaml.safe_load(compose_opencode_header(ROLES_DIR / f"{role}.role.json"))
                self.assertEqual(parsed["mode"], role_def["mode"])
                self.assertEqual(
                    json.dumps(parsed["permission"]), json.dumps(compose_role_permission(role_def))
                )

    def test_unquoted_star_key_is_rejected(self) -> None:
        self.assertTrue(any("'*'" in err for err in lexical_frontmatter_errors(OLD_STYLE_HEADER)))
        role_def = {"name": "verifier", "description": "Run verification.", "mode": "subagent"}
        errors = validate_agent_frontmatter("verifier", f"---\n{OLD_STYLE_HEADER}---\n\nbody\n", role_def, {})
        self.assertTrue(errors)

    @unittest.skipIf(yaml is None, "PyYAML not installed")
    def test_old_style_header_is_invalid_yaml(self) -> None:
        with self.assertRaises(yaml.YAMLError):
            yaml.safe_load(OLD_STYLE_HEADER)

    def test_lexical_check_accepts_quoted_keys_and_rejects_other_indicators(self) -> None:
        self.assertEqual(lexical_frontmatter_errors('permission:\n  "*": ask\n  read:\n    "a: b": deny\n'), [])
        for bad in ("  &anchor: ask", "  !tag: ask", "  %x: ask", "  @x: ask", "  `x: ask", "  [x]: ask", '  "*: ask'):
            with self.subTest(line=bad):
                self.assertTrue(lexical_frontmatter_errors(f"permission:\n{bad}\n"))

    def test_emitter_quotes_non_identifier_keys(self) -> None:
        permission = {
            "*": "ask",
            "read": {"*": "allow", "a: b": "deny"},
            "my-tool": {"*": "deny"},
            "on": "allow",
            "custom_tool": "ask",
        }
        text = permission_to_yaml(permission)
        self.assertEqual(lexical_frontmatter_errors(text), [])
        self.assertIn('\n"my-tool":\n', text)
        self.assertIn("\ncustom_tool: ask\n", text)
        if yaml is not None:
            self.assertEqual(yaml.safe_load(text), permission)

    def test_emitter_quotes_awkward_name_and_description(self) -> None:
        role = load_role("verifier")
        role["description"] = "Use this: now # really"
        with tempfile.TemporaryDirectory() as tmp:
            role_path = Path(tmp) / "verifier.role.json"
            role_path.write_text(json.dumps(role), encoding="utf-8")
            header = compose_opencode_header(role_path)
        self.assertEqual(lexical_frontmatter_errors(header), [])
        if yaml is not None:
            self.assertEqual(yaml.safe_load(header)["description"], role["description"])


class TestUnknownKeyHandling(unittest.TestCase):
    def test_unknown_permission_key_is_preserved_after_known_keys(self) -> None:
        policy = load_policy()
        policy["top_level"]["codesearch"] = "deny"
        perm = build_base_permission(policy)
        self.assertEqual(perm["codesearch"], "deny")
        self.assertEqual(list(perm)[-1], "codesearch")
        self.assertIn("codesearch:", permission_to_yaml(perm))

    def test_unknown_policy_keys_are_reported(self) -> None:
        self.assertEqual(unknown_policy_keys(load_policy()), [])
        policy = load_policy()
        policy["plugin"] = {}
        policy["bash"]["allow_override"] = ["x"]
        self.assertEqual(sorted(unknown_policy_keys(policy)), ["bash.allow_override", "plugin"])

    def test_load_policy_fails_loudly_on_unknown_keys(self) -> None:
        policy = load_policy()
        policy["bash"]["allow_override"] = ["x"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "opencode.policy.json"
            path.write_text(json.dumps(policy), encoding="utf-8")
            original = opencode_policy_compose.POLICY_PATH
            opencode_policy_compose.POLICY_PATH = path
            try:
                with self.assertRaisesRegex(ValueError, "bash.allow_override"):
                    load_policy()
            finally:
                opencode_policy_compose.POLICY_PATH = original


def _load_generator(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestGeneratorParity(unittest.TestCase):
    def test_both_generators_match_compose_and_the_snapshot(self) -> None:
        snapshot = json.dumps(json.loads((TEMPLATES_DIR / "opencode.json").read_text(encoding="utf-8")))
        composed = json.dumps(build_base_permission(load_policy()))
        for name, path in (("shipped", SHIPPED_GENERATOR), ("repo", REPO_GENERATOR)):
            with self.subTest(generator=name):
                config = _load_generator(path, f"opencode_generator_{name}").generate_config()
                self.assertEqual(json.dumps(config), snapshot)
                self.assertEqual(json.dumps(config["permission"]), composed)


class TestGeneratorUnknownKeys(unittest.TestCase):
    """Generators must emit unknown keys (or fail), and --check must notice the snapshot lacks them."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "scripts").mkdir()
        (self.tmp / "templates").mkdir()
        self.script = self.tmp / "scripts" / "generate-opencode-config.py"
        shutil.copy(SHIPPED_GENERATOR, self.script)
        for name in ("opencode.base.json", "opencode.policy.json", "opencode.json"):
            shutil.copy(TEMPLATES_DIR / name, self.tmp / "templates" / name)

    def run_generator(self, flag: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(self.script), flag], capture_output=True, text=True)

    def edit_template(self, name: str, mutate) -> None:
        path = self.tmp / "templates" / name
        data = json.loads(path.read_text(encoding="utf-8"))
        mutate(data)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    def snapshot(self) -> dict:
        return json.loads((self.tmp / "templates" / "opencode.json").read_text(encoding="utf-8"))

    def test_pristine_copy_checks_clean(self) -> None:
        self.assertEqual(self.run_generator("--check").returncode, 0)

    def test_unknown_permission_key_is_emitted_and_check_detects_missing_key(self) -> None:
        self.edit_template("opencode.policy.json", lambda d: d["top_level"].update({"codesearch": "deny"}))
        self.assertEqual(self.run_generator("--check").returncode, 1)
        self.assertEqual(self.run_generator("--write").returncode, 0)
        self.assertEqual(self.snapshot()["permission"]["codesearch"], "deny")
        self.assertEqual(self.run_generator("--check").returncode, 0)

    def test_unknown_base_key_is_emitted_before_permission(self) -> None:
        self.edit_template("opencode.base.json", lambda d: d.update({"plugin": ["example"]}))
        self.assertEqual(self.run_generator("--check").returncode, 1)
        self.assertEqual(self.run_generator("--write").returncode, 0)
        keys = list(self.snapshot())
        self.assertEqual(self.snapshot()["plugin"], ["example"])
        self.assertEqual(keys[-2:], ["plugin", "permission"])
        self.assertEqual(self.run_generator("--check").returncode, 0)

    def test_unknown_policy_key_fails_loudly(self) -> None:
        before = (self.tmp / "templates" / "opencode.json").read_text(encoding="utf-8")
        self.edit_template("opencode.policy.json", lambda d: d["bash"].update({"allow_override": ["x"]}))
        for flag in ("--check", "--write"):
            with self.subTest(flag=flag):
                result = self.run_generator(flag)
                self.assertEqual(result.returncode, 1)
                self.assertIn("bash.allow_override", result.stderr)
        self.assertEqual((self.tmp / "templates" / "opencode.json").read_text(encoding="utf-8"), before)

    def test_permission_in_base_fails_loudly(self) -> None:
        self.edit_template("opencode.base.json", lambda d: d.update({"permission": {"*": "allow"}}))
        result = self.run_generator("--check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("permission", result.stderr)

    def test_repo_generator_emits_unknown_policy_key(self) -> None:
        module = _load_generator(REPO_GENERATOR, "opencode_generator_repo_unknown")
        module.BASE_PATH = str(self.tmp / "templates" / "opencode.base.json")
        module.POLICY_PATH = str(self.tmp / "templates" / "opencode.policy.json")
        module.SNAPSHOT_PATH = str(self.tmp / "templates" / "opencode.json")
        self.edit_template("opencode.policy.json", lambda d: d["top_level"].update({"codesearch": "deny"}))
        self.assertEqual(module.generate_config()["permission"]["codesearch"], "deny")


if __name__ == "__main__":
    unittest.main()
