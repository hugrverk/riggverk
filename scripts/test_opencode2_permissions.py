#!/usr/bin/env python3
"""The OpenCode 2 evaluation mode of the permission mirror and the opt-in `debug agents`
cross-check. Runs without OpenCode: the cross-check is driven by a stand-in binary."""

from __future__ import annotations

import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import validate_opencode_permissions as validator  # noqa: E402
from opencode_permission_eval import (  # noqa: E402
    V2_SHELL_OPAQUE_REASONS,
    Rule,
    compose_agent_rules,
    evaluate,
    location_resource,
    v2_action,
    v2_rules_from_dump,
    v2_ruleset,
    v2_ruleset_from_permission,
    wildcard_match,
)


def model_resolution() -> dict[str, list[Rule]]:
    """A stand-in for what `debug agents` resolves: the modelled rules, test home already in place."""
    snapshot = json.loads(validator.SNAPSHOT_PATH.read_text(encoding="utf-8"))
    resolved = {
        role: validator._with_test_home(v2_ruleset_from_permission(validator.compose_role_permission(validator.load_role(role))))
        for role in validator.ALL_ROLES
    }
    for agent in validator.V2_BUILTIN_AGENTS:
        entry = snapshot.get("agent", {}).get(agent, {}).get("permission")
        resolved[agent] = validator._with_test_home(v2_ruleset(compose_agent_rules(agent, snapshot["permission"], entry)))
    return resolved


class RenameTest(unittest.TestCase):
    def test_v1_keys_become_the_2x_actions(self) -> None:
        renamed = {key: v2_action(key) for key in ("bash", "task", "write", "patch", "apply_patch", "edit", "read", "webfetch")}
        self.assertEqual(
            renamed,
            {
                "bash": "shell",
                "task": "subagent",
                "write": "edit",
                "patch": "edit",
                "apply_patch": "edit",
                "edit": "edit",
                "read": "read",
                "webfetch": "webfetch",
            },
        )

    def test_rule_order_is_kept_so_last_match_still_wins(self) -> None:
        rules = v2_ruleset_from_permission({"write": {"*": "deny"}, "edit": {"src/**": "allow"}, "task": "deny"})
        self.assertEqual(
            rules,
            [Rule("edit", "*", "deny"), Rule("edit", "src/**", "allow"), Rule("subagent", "*", "deny")],
        )
        self.assertEqual(evaluate("edit", "src/a.ts", rules).action, "allow")
        # A later `write` deny now overrides an earlier `edit` allow: both are `edit` in 2.x.
        later = v2_ruleset_from_permission({"edit": {"*": "allow"}, "write": {"*.md": "deny"}})
        self.assertEqual(evaluate("edit", "README.md", later).action, "deny")

    def test_dump_rules_keep_their_fields(self) -> None:
        dump = [{"action": "shell", "resource": "git *", "effect": "allow"}]
        self.assertEqual(v2_rules_from_dump(dump), [Rule("shell", "git *", "allow")])


class WildcardTest(unittest.TestCase):
    """Behaviour of `match` in packages/core/src/util/wildcard.ts at v2.3.2."""

    def test_semantics(self) -> None:
        self.assertTrue(wildcard_match("a/b/c.md", "*.md"))  # `*` crosses `/`
        self.assertTrue(wildcard_match("../.env", "**/.env*"))
        self.assertFalse(wildcard_match(".env", "**/.env*"))
        self.assertTrue(wildcard_match("ab", "a?"))
        self.assertFalse(wildcard_match("abc", "a?"))
        self.assertTrue(wildcard_match("git status", "git status *"))  # trailing ` *` matches the bare command
        self.assertTrue(wildcard_match("src\\a.ts", "src/*"))  # backslashes are slashes
        self.assertTrue(wildcard_match("a\nb", "a*b"))  # the `s` flag: `*` crosses newlines
        self.assertFalse(wildcard_match("xa.md", "a.md"))  # anchored at both ends
        self.assertTrue(wildcard_match("a+b(c)", "a+b(c)"))  # regex syntax is literal

    def test_no_match_asks(self) -> None:
        self.assertEqual(evaluate("read", "x", []).action, "ask")


class LocationTest(unittest.TestCase):
    def test_resources_are_relative_to_the_location(self) -> None:
        worktree = "/h/proj"
        self.assertEqual(location_resource("/h/proj/.env", worktree, worktree), ".env")
        self.assertEqual(location_resource("/h/proj/.env", "/h/proj/src", worktree), "../.env")
        self.assertEqual(location_resource("/h/proj/src/a.ts", "/h/proj/src", worktree), "a.ts")
        self.assertEqual(location_resource("/h/proj/src", "/h/proj/src", worktree), ".")
        self.assertEqual(location_resource("/h/.ssh/id_rsa", worktree, worktree), "/h/.ssh/id_rsa")
        self.assertEqual(location_resource("/h/projects/x", worktree, worktree), "/h/projects/x")
        # A worktree at the filesystem root does not make everything internal.
        self.assertEqual(location_resource("/etc/hosts", "/srv", "/"), "/etc/hosts")


class ModelTest(unittest.TestCase):
    def test_bundled_roles_pass_the_2x_model(self) -> None:
        self.assertEqual(validator.v2_model_errors(), [])

    def test_rows_cover_subfolder_locations_and_builtins(self) -> None:
        rows = validator.non_shell_rows()
        subfolder = [row for row in rows if row.location != validator._WORKTREE]
        self.assertTrue(any(row.agent == "scribe" and row.expected == "deny" and row.resource.endswith("/.env") for row in subfolder))
        self.assertIn("plan", {row.agent for row in rows})
        self.assertNotIn("bash", {row.key for row in rows})
        for row in rows:
            if row.key in validator.V2_FILE_KEYS:
                self.assertTrue(row.resource.startswith("/"), row)

    def test_a_secret_deny_lost_in_a_subfolder_is_reported(self) -> None:
        # Only the root form `.env` left: it matches at the root and misses `../.env`.
        rules = [Rule("read", "*", "allow"), Rule("read", ".env", "deny")]
        row = validator.DecisionRow("scribe", "read", f"{validator._WORKTREE}/.env", "deny", f"{validator._WORKTREE}/src")
        errors = validator._row_errors("opencode 2 model: ", rules, row)
        self.assertEqual(len(errors), 1)
        self.assertIn("from Location src/", errors[0])
        root = validator.DecisionRow("scribe", "read", f"{validator._WORKTREE}/.env", "deny")
        self.assertEqual(validator._row_errors("x: ", rules, root), [])

    def test_a_widened_role_fails_the_model(self) -> None:
        load = validator.load_role

        def widened(name: str) -> dict:
            role = load(name)
            if name == "repo-scout":
                role.setdefault("permission", {})["task"] = "allow"
            return role

        with mock.patch.object(validator, "load_role", widened):
            errors = validator.v2_model_errors()
        self.assertTrue(any("repo-scout: subagent 'general' must be deny" in error for error in errors), errors)

    def test_not_allow_rows_accept_ask_and_deny(self) -> None:
        row = validator.DecisionRow("scribe", "edit", f"{validator._WORKTREE}/x.ts", validator.NOT_ALLOW)
        for action, failures in (("deny", 0), ("ask", 0), ("allow", 1)):
            self.assertEqual(len(validator._row_errors("", [Rule("edit", "*", action)], row)), failures)


class CrossCheckRowsTest(unittest.TestCase):
    def test_matching_resolution_passes(self) -> None:
        errors, count = validator.v2_crosscheck_errors(model_resolution())
        self.assertEqual(errors, [])
        self.assertGreater(count, 500)

    def test_mismatch_and_missing_agent_fail(self) -> None:
        resolved = model_resolution()
        resolved["plan"] = resolved["plan"] + [Rule("edit", "*", "allow")]
        del resolved["sentinel"]
        errors, _ = validator.v2_crosscheck_errors(resolved)
        self.assertIn("opencode 2 cross-check: agent sentinel is missing from debug agents", errors)
        self.assertIn(f"opencode 2 cross-check: plan: edit '{validator._WORKTREE}/src/x.ts' must be deny, got allow", errors)


FAKE = """#!{python}
import json, os, sys
with open({seen!r}, "a") as out:
    out.write(json.dumps({{"argv": sys.argv, "env": dict(os.environ), "cwd": os.getcwd()}}) + "\\n")
if sys.argv[1:] == ["--version"]:
    print({version!r})
    sys.exit(0)
if sys.argv[1:] != ["debug", "agents", "--standalone"]:
    sys.exit(7)
home = os.environ["HOME"]
config = os.path.join(home, ".config", "opencode")
assert os.path.isfile(os.path.join(config, "opencode.json"))
agents = json.load(open({dump!r}))
for agent in agents:
    for rule in agent["permissions"]:
        if rule["resource"].startswith("/home/u/"):
            rule["resource"] = home + rule["resource"][len("/home/u"):]
print(json.dumps(agents))
"""


class CrossCheckRunTest(unittest.TestCase):
    """The cross-check driven end to end by a stand-in OpenCode 2 binary."""

    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        self.seen = self.root / "seen.jsonl"
        self.dump = self.root / "dump.json"
        self.binary = self.root / "opencode"
        self.write_dump(model_resolution())
        self.install()

    def write_dump(self, resolved: dict[str, list[Rule]]) -> None:
        agents = [
            {"id": agent, "permissions": [{"action": r.permission, "resource": r.pattern, "effect": r.action} for r in rules]}
            for agent, rules in resolved.items()
        ]
        self.dump.write_text(json.dumps(agents), encoding="utf-8")

    def install(self, version: str = "opencode v2.3.2") -> None:
        self.binary.write_text(FAKE.format(python=sys.executable, seen=str(self.seen), version=version, dump=str(self.dump)), encoding="utf-8")
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)

    def main(self, argv: list[str], environ: dict[str, str] | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        env = {"PATH": os.environ["PATH"], "SECRET_FROM_CALLER": "canary", **(environ or {})}
        code = 0
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(validator, "validate", lambda: []):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    validator.main(argv)
                except SystemExit as exit:
                    code = int(exit.code or 0)
        return code, out.getvalue(), err.getvalue()

    def test_skipped_without_a_binary_and_says_so(self) -> None:
        code, out, _ = self.main([])
        self.assertEqual(code, 0)
        self.assertIn("OpenCode 2 cross-check skipped", out)
        self.assertIn("Shell rows model OpenCode 1.x only", out)
        for reason in V2_SHELL_OPAQUE_REASONS:
            self.assertIn(reason, out)
        self.assertFalse(self.seen.exists())

    def test_passes_against_a_matching_binary_from_flag_or_env(self) -> None:
        for argv, environ in (([f"--opencode2={self.binary}"], None), ([], {"RIGGVERK_OPENCODE2_BIN": str(self.binary)})):
            with self.subTest(argv=argv):
                code, out, err = self.main(argv, environ)
                self.assertEqual((code, err), (0, ""))
                self.assertIn("OpenCode 2.3.2 cross-check:", out)
                self.assertNotIn("skipped", out)
        calls = [json.loads(line) for line in self.seen.read_text(encoding="utf-8").splitlines()]
        self.assertIn(["debug", "agents", "--standalone"], [call["argv"][1:] for call in calls])
        for call in calls:
            self.assertNotIn("SECRET_FROM_CALLER", call["env"])
            self.assertIn("riggverk-oc2-permissions-", call["env"]["HOME"])
            self.assertEqual(call["cwd"], call["env"]["HOME"] + "/proj")
            for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"):
                self.assertTrue(call["env"][key].startswith(call["env"]["HOME"]), key)

    def test_a_weaker_binary_result_fails(self) -> None:
        resolved = model_resolution()
        resolved["repo-scout"] = resolved["repo-scout"] + [Rule("read", "*", "allow")]
        self.write_dump(resolved)
        code, _, err = self.main([f"--opencode2={self.binary}"])
        self.assertEqual(code, 1)
        self.assertIn("opencode 2 cross-check: repo-scout: read", err)

    def test_wrong_major_or_failing_binary_fails_instead_of_skipping(self) -> None:
        self.install(version="1.19.5")
        code, _, err = self.main([f"--opencode2={self.binary}"])
        self.assertEqual(code, 1)
        self.assertIn("is not OpenCode 2.x", err)
        code, _, err = self.main(["--opencode2", str(self.root / "missing")])
        self.assertEqual(code, 1)
        self.assertIn("cross-check could not run", err)

    def test_refuses_project_config_above_the_temp_home(self) -> None:
        base = self.root / "tmp"
        base.mkdir()
        for marker in validator.V2_PROJECT_MARKERS:
            with self.subTest(marker=marker):
                target = self.root / marker
                target.mkdir() if marker.startswith(".") else target.write_text("{}", encoding="utf-8")
                with mock.patch.object(tempfile, "tempdir", str(base)):
                    code, _, err = self.main([f"--opencode2={self.binary}"])
                self.assertEqual(code, 1)
                self.assertIn("as project config", err)
                target.rmdir() if marker.startswith(".") else target.unlink()


if __name__ == "__main__":
    unittest.main()
