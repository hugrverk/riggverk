#!/usr/bin/env python3
"""Tests for scripts/check-bundle-content.py.

The real tree must pass; every rule must fire on its own sample; and each group must fail on a
planted violation in a throwaway copy of the bundle.
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from guards import Rule, check  # noqa: E402

_spec = importlib.util.spec_from_file_location("check_bundle_content", SCRIPTS / "check-bundle-content.py")
assert _spec is not None and _spec.loader is not None
bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bc)

WS = Path(bc.BUNDLE)


def probe_path(rule: Rule) -> str:
    spec = rule.files[0]
    if spec.endswith("/"):
        return spec + "probe.txt"
    return spec.replace("*", "probe")


class RuleTableTests(unittest.TestCase):
    def test_every_sample_matches_its_own_pattern(self) -> None:
        for rule in bc.RULES:
            with self.subTest(rule=rule.id):
                match = re.search(rule.pattern, rule.sample)
                self.assertIsNotNone(match)
                if rule.allow:
                    self.assertIsNone(re.fullmatch(rule.allow, match.group(0)))

    def test_rule_ids_are_unique(self) -> None:
        ids = [rule.id for rule in bc.RULES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_each_rule_fires_on_its_sample(self) -> None:
        for rule in bc.RULES:
            with self.subTest(rule=rule.id), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                probe = root / probe_path(rule)
                probe.parent.mkdir(parents=True, exist_ok=True)
                probe.write_text("unrelated text\n", encoding="utf-8")
                files = bc.bundle_files(root)
                before = check(root, [rule], files)
                probe.write_text(f"unrelated text\n{rule.sample}\n", encoding="utf-8")
                after = check(root, [rule], files)
                if rule.kind == "forbid":
                    self.assertEqual(before, [])
                    self.assertEqual(len(after), 1)
                    self.assertTrue(after[0].startswith(f"{rule.id}:"), after)
                else:
                    self.assertTrue(before and before[0].startswith(f"{rule.id}:"), before)
                    self.assertEqual(after, [])


class BundleTests(unittest.TestCase):
    def test_real_tree_passes(self) -> None:
        self.assertEqual(bc.run(ROOT, list(bc.GROUPS)), [])

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = Path(self._tmp.name)
        shutil.copytree(ROOT / WS, self.tree / WS, symlinks=True)
        frozen_list = self.tree / bc.FROZEN_LIST_RS
        frozen_list.parent.mkdir(parents=True)
        shutil.copy2(ROOT / bc.FROZEN_LIST_RS, frozen_list)
        pin_source = self.tree / bc.PIN_SOURCE
        pin_source.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / bc.PIN_SOURCE, pin_source)

    def failures(self, group: str) -> list[str]:
        return bc.run(self.tree, [group])

    def edit(self, rel: str, old: str, new: str) -> None:
        path = self.tree / WS / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def assertFails(self, group: str, needle: str) -> None:
        failures = self.failures(group)
        self.assertTrue(any(needle in failure for failure in failures), failures)

    def test_copy_passes(self) -> None:
        self.assertEqual(bc.run(self.tree, list(bc.GROUPS)), [])

    def test_security_audit_digest_lock(self) -> None:
        directory = self.tree / WS / "skills/security-audit"
        path = directory / "HUNTING.md"
        original = path.read_bytes()
        for change in ("modify", "remove", "add", "upstream", "manifest"):
            with self.subTest(change=change):
                upstream = directory / "UPSTREAM.md"
                upstream_original = upstream.read_bytes()
                if change == "modify":
                    path.write_bytes(original + b"changed\n")
                elif change == "remove":
                    path.unlink()
                elif change == "add":
                    (directory / "extra.md").write_text("extra\n")
                elif change == "upstream":
                    upstream.write_bytes(b"changed\n" + upstream_original)
                else:
                    upstream.write_bytes(upstream_original + b"invalid\n")
                self.assertFails("security-audit", "update UPSTREAM.md after reviewing the change")
                path.write_bytes(original)
                upstream.write_bytes(upstream_original)
                (directory / "extra.md").unlink(missing_ok=True)
                self.assertEqual(self.failures("security-audit"), [])

    def test_hardcoded_home_directory(self) -> None:
        (self.tree / WS / "templates/leaked-home.json").write_text('{"path": "/Users/someone-else/project"}\n')
        self.assertFails("playwright", "hardcoded")

    def test_neutral_home_directory_is_allowed(self) -> None:
        (self.tree / WS / "templates/example-home.json").write_text('{"path": "/Users/example/project"}\n')
        self.assertEqual(self.failures("playwright"), [])

    def test_token_in_codex_template(self) -> None:
        self.edit("templates/codex/README.md", "\n", "\napi key sk-" + "abcdefghijklmnop1234\n")
        self.assertFails("codex", "credential-like literal: resources/default-workspace/templates/codex/README.md")

    def test_codex_defaults(self) -> None:
        self.edit("templates/codex/config.toml", 'approval_policy = "on-request"', 'approval_policy = "never"')
        path = self.tree / WS / "templates/codex/config.toml"
        path.write_text(path.read_text(encoding="utf-8") + '\n[profiles.safe]\nmodel = "x"\n', encoding="utf-8")
        failures = self.failures("codex")
        self.assertTrue(any("approval_policy" in failure for failure in failures), failures)
        self.assertTrue(any("[profiles.*]" in failure for failure in failures), failures)

    def test_missing_codex_template(self) -> None:
        (self.tree / WS / "templates/codex/mcp/playwright.toml").unlink()
        self.assertFails("codex", "missing Codex template")

    def test_symlink_in_bundle(self) -> None:
        (self.tree / WS / "docs/link.md").symlink_to("START_HERE.md")
        self.assertFails("symlinks", "symlink in the bundled workspace: resources/default-workspace/docs/link.md")

    def test_missing_agent_file(self) -> None:
        (self.tree / WS / "agents/inspector.md").unlink()
        self.assertFails("agents", "missing=['inspector.md']")

    def test_agent_model_frontmatter_and_second_primary(self) -> None:
        self.edit("agents/inspector.md", "mode: subagent", "mode: primary\nmodel: some/model")
        failures = self.failures("agents")
        self.assertTrue(any("model frontmatter" in failure for failure in failures), failures)
        self.assertTrue(any("exactly one bundled agent must be mode: primary" in failure for failure in failures), failures)

    def test_default_agent_must_be_the_primary(self) -> None:
        self.edit("templates/opencode.json", '"default_agent": "architect"', '"default_agent": "inspector"')
        self.assertFails("agents", "default_agent 'inspector'")

    def test_opencode_and_tui_defaults(self) -> None:
        self.edit("templates/opencode.json", '"snapshot": true', '"snapshot": false')
        self.assertFails("opencode-defaults", "snapshot must be True")
        self.edit("templates/tui.json", '"mouse": true', '"mouse": false')
        self.assertFails("tui-defaults", "mouse must be True")

    def test_models_must_not_be_bundled(self) -> None:
        self.edit("templates/opencode.json", '"snapshot": true', '"model": "other/model", "snapshot": true')
        self.assertFails("opencode-defaults", "must not set model")

    def test_invalid_json(self) -> None:
        (self.tree / WS / "templates/broken.json").write_text('{"a": NaN}\n')
        self.assertFails("json", "not strict JSON: resources/default-workspace/templates/broken.json")

    def test_empty_listed_file_and_missing_doc(self) -> None:
        (self.tree / WS / "README.md").write_text("")
        (self.tree / WS / "docs/START_HERE.md").unlink()
        failures = self.failures("nonempty")
        self.assertTrue(any(failure.endswith("resources/default-workspace/README.md") for failure in failures), failures)
        self.assertTrue(any(failure.endswith("docs/START_HERE.md") for failure in failures), failures)

    def test_hand_written_opencode_header(self) -> None:
        (self.tree / WS / "templates/opencode/agents/architect.header.yaml").write_text("mode: primary\n")
        self.assertFails("opencode-headers", "architect.header.yaml")

    def test_private_context_file_dir_and_name(self) -> None:
        (self.tree / WS / "docs/USER_CONTEXT.md").write_text("notes\n")
        (self.tree / WS / "private-context").mkdir()
        self.edit("docs/CONCEPTS.md", "\n", f"\nThanks {bc.PRIVATE_NAMES[0]}.\n")
        failures = self.failures("boundary")
        self.assertTrue(any("private context file" in failure for failure in failures), failures)
        self.assertTrue(any("private context directory" in failure for failure in failures), failures)
        self.assertTrue(any(failure.startswith("[boundary] private-names:") for failure in failures), failures)

    def test_ignored_files_on_disk_are_scanned(self) -> None:
        # The app bundles the directory as it is on disk, so a gitignored file still ships.
        cache = self.tree / WS / "scripts/__pycache__"
        cache.mkdir()
        (cache / "notes.txt").write_text("PLAYWRIGHT_BROWSERS_PATH=0\n")
        self.assertFails("playwright", "playwright-browsers-path")

    def edit_pin_source(self, old: str, new: str) -> None:
        path = self.tree / bc.PIN_SOURCE
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_every_template_names_the_pin_of_the_app(self) -> None:
        version, _ = bc.read_pin(self.tree)
        for rel in bc.PIN_TEMPLATES:
            with self.subTest(template=rel):
                self.assertIn(f"@playwright/mcp@{version}", (self.tree / WS / rel).read_text(encoding="utf-8"))

    def test_a_template_with_another_version_fails(self) -> None:
        version, _ = bc.read_pin(self.tree)
        self.edit("templates/mcp/pi.playwright.json", f"@playwright/mcp@{version}", "@playwright/mcp@0.0.1")
        self.assertFails("playwright-pin", "templates/mcp/pi.playwright.json:5: names @playwright/mcp@0.0.1")
        self.assertFails("playwright-pin", "templates/mcp/pi.playwright.json: does not pin")

    def test_a_template_without_a_pin_fails(self) -> None:
        version, _ = bc.read_pin(self.tree)
        self.edit("templates/cursor/mcp/playwright.mcp.json", f"@playwright/mcp@{version}", "playwright")
        self.assertFails("playwright-pin", "templates/cursor/mcp/playwright.mcp.json: does not pin")

    def test_every_entry_selects_the_system_chrome_and_turns_webmcp_off(self) -> None:
        for rel, location in bc.PIN_ENTRIES.items():
            with self.subTest(template=rel):
                arguments = bc.entry_arguments(self.tree / WS / rel, location)
                self.assertIsInstance(arguments, list)
                self.assertEqual(arguments.count("--no-webmcp"), 1)
                self.assertEqual(arguments.count("--isolated"), 1)
                at = arguments.index("--browser")
                self.assertEqual(arguments[at + 1], "chrome")
        self.assertEqual(self.failures("playwright-pin"), [])

    def test_an_entry_without_the_chrome_selection_fails(self) -> None:
        # Naming no browser, or `chromium`, resolves to Playwright's own Chromium on 0.0.83.
        for rel, location in bc.PIN_ENTRIES.items():
            for broken in ("chromium", "firefox"):
                with self.subTest(template=rel, browser=broken):
                    path = self.tree / WS / rel
                    original = path.read_text(encoding="utf-8")
                    path.write_text(original.replace('"chrome"', f'"{broken}"', 1), encoding="utf-8")
                    self.assertFails("playwright-pin", f"{rel}: does not select the system Chrome")
                    path.write_text(original, encoding="utf-8")
                    self.assertEqual(self.failures("playwright-pin"), [])

    def test_an_entry_without_the_browser_flag_fails(self) -> None:
        for rel in bc.PIN_ENTRIES:
            with self.subTest(template=rel):
                path = self.tree / WS / rel
                original = path.read_text(encoding="utf-8")
                path.write_text(original.replace("--browser", "--channel", 1), encoding="utf-8")
                self.assertFails("playwright-pin", f"{rel}: does not select the system Chrome")
                path.write_text(original, encoding="utf-8")

    def test_an_entry_that_leaves_webmcp_on_fails(self) -> None:
        for rel in bc.PIN_ENTRIES:
            with self.subTest(template=rel):
                path = self.tree / WS / rel
                original = path.read_text(encoding="utf-8")
                path.write_text(original.replace("--no-webmcp", "--webmcp", 1), encoding="utf-8")
                self.assertFails("playwright-pin", f"{rel}: does not pass `--no-webmcp`")
                path.write_text(original, encoding="utf-8")
                self.assertEqual(self.failures("playwright-pin"), [])

    def test_an_entry_that_is_not_isolated_fails(self) -> None:
        for rel in bc.PIN_ENTRIES:
            with self.subTest(template=rel):
                path = self.tree / WS / rel
                original = path.read_text(encoding="utf-8")
                path.write_text(original.replace("--isolated", "--shared", 1), encoding="utf-8")
                self.assertFails("playwright-pin", f"{rel}: does not pass `--isolated`")
                path.write_text(original, encoding="utf-8")

    def test_an_entry_the_check_cannot_find_fails_with_a_reason(self) -> None:
        self.edit("templates/mcp/pi.playwright.json", '"args"', '"arguments"')
        self.assertFails("playwright-pin", "templates/mcp/pi.playwright.json: has no args entry")
        (self.tree / WS / "templates/codex/mcp/playwright.toml").write_text("[mcp_servers.playwright\n", encoding="utf-8")
        self.assertFails("playwright-pin", "templates/codex/mcp/playwright.toml: cannot be read")

    def test_a_doc_and_the_readme_must_agree_with_the_pin(self) -> None:
        self.edit("docs/OPENCODE_CONFIG.md", "@playwright/mcp@", "@playwright/mcp@9.9.9 and @playwright/mcp@")
        (self.tree / "README.md").write_text("Run `npx -y @playwright/mcp@0.0.1 --help`.\n", encoding="utf-8")
        failures = self.failures("playwright-pin")
        self.assertTrue(any("docs/OPENCODE_CONFIG.md" in f and "@playwright/mcp@9.9.9" in f for f in failures), failures)
        self.assertTrue(any(f.startswith("[playwright-pin] README.md:1:") for f in failures), failures)

    def test_a_pin_the_app_does_not_record_fails(self) -> None:
        self.edit_pin_source("// released", "// shipped")
        self.assertFails("playwright-pin", "no `PLAYWRIGHT_MCP_VERSION")
        (self.tree / bc.PIN_SOURCE).unlink()
        self.assertFails("playwright-pin", "missing the Playwright MCP pin source")
        self.assertEqual(bc.pin_warnings(self.tree), [])

    def test_a_bump_of_the_app_alone_fails_until_the_templates_follow(self) -> None:
        version, _ = bc.read_pin(self.tree)
        self.edit_pin_source(f'"{version}"', '"0.0.999"')
        self.assertFails("playwright-pin", "the app pins 0.0.999")

    def test_an_old_pin_warns_and_does_not_fail(self) -> None:
        version, released = bc.read_pin(self.tree)
        self.edit_pin_source(f"// released {released.isoformat()}", "// released 2020-01-31")
        self.assertEqual(self.failures("playwright-pin"), [])
        warnings = bc.pin_warnings(self.tree, today=date(2026, 10, 19))
        self.assertEqual(len(warnings), 1, warnings)
        self.assertIn(f"@playwright/mcp@{version} was released on 2020-01-31", warnings[0])

    def test_the_warning_starts_after_the_age_limit(self) -> None:
        _, released = bc.read_pin(self.tree)
        limit = released + timedelta(days=bc.PIN_MAX_AGE_DAYS)
        self.assertEqual(bc.pin_warnings(self.tree, today=limit), [])
        self.assertEqual(len(bc.pin_warnings(self.tree, today=limit + timedelta(days=1))), 1)

    def test_cursor_user_rules_wording(self) -> None:
        self.edit("templates/cursor/user-rules.md", bc.USER_RULES_PHRASES[1], "Use subagents freely")
        self.assertFails("cursor-user-rules", "cursor-user-rules-2")


if __name__ == "__main__":
    unittest.main()
