#!/usr/bin/env python3
"""Negative tests for scripts/check-skill-routing.py.

Each case mutates a throwaway copy of the repo inputs and asserts the checker fails with
the expected message, so the semantic checks cannot silently become no-ops.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
WS = Path("resources/default-workspace")


def build_tree(dest: Path) -> None:
    (dest / "scripts").mkdir()
    for script in (ROOT / "scripts").glob("*.py"):
        shutil.copy2(script, dest / "scripts" / script.name)
    shutil.copytree(ROOT / WS, dest / WS)
    shutil.copytree(ROOT / "docs", dest / "docs")
    shutil.copy2(ROOT / "README.md", dest / "README.md")
    bootstrap = Path("src-tauri/src/managed_bootstrap.rs")
    (dest / bootstrap).parent.mkdir(parents=True)
    shutil.copy2(ROOT / bootstrap, dest / bootstrap)


def load_checker(tree: Path):
    """Import the checker copied into `tree` as a module, without running main()."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_skill_routing", tree / "scripts/check-skill-routing.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(tree: Path, script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, f"scripts/{script}", *args],
        cwd=tree,
        text=True,
        capture_output=True,
        check=False,
    )


class CheckSkillRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = Path(self._tmp.name)
        build_tree(self.tree)

    def skill(self, name: str) -> Path:
        matches = list((self.tree / WS / "skills").rglob(f"{name}/SKILL.md"))
        self.assertEqual(len(matches), 1, name)
        return matches[0]

    def edit(self, path: Path, old: str, new: str) -> None:
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def assert_fails(self, message: str) -> None:
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)

    def test_baseline_passes(self) -> None:
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_catalog_row_is_required_even_if_skill_is_mentioned_elsewhere(self) -> None:
        catalog = self.tree / WS / "docs/SKILLS.md"
        self.edit(catalog, "| `tdd` | Using", "| Testing | Using")
        self.assert_fails("bundled skills missing from catalog: ['tdd']")

    def test_catalog_row_without_skill_fails(self) -> None:
        self.append(self.tree / WS / "docs/SKILLS.md", "\n| `unknown-skill` | Missing source. |\n")
        self.assert_fails("catalog rows without bundled skills: ['unknown-skill']")

    def test_duplicate_catalog_row_fails(self) -> None:
        self.append(self.tree / WS / "docs/SKILLS.md", "\n| `tdd` | Duplicate. |\n")
        self.assert_fails("duplicate skill catalog rows")

    def test_new_skill_with_catalog_row_needs_no_count_pin(self) -> None:
        source = self.skill("tdd").read_text(encoding="utf-8")
        name = "fixture-skill"
        dest = self.tree / WS / "skills" / name / "SKILL.md"
        dest.parent.mkdir()
        dest.write_text(source.replace("name: tdd", f"name: {name}", 1), encoding="utf-8")
        self.append(self.tree / WS / "docs/SKILLS.md", f"\n| `{name}` | Fixture. |\n")
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        count = len(list((self.tree / WS / "skills").rglob("SKILL.md")))
        self.assertIn(f"PASS: {count} bundled skills", result.stdout)

    def test_removed_names_come_from_bootstrap(self) -> None:
        name = "fixture-" + "retired-skill"
        self.edit(
            self.tree / "src-tauri/src/managed_bootstrap.rs",
            "pub const REMOVED_SKILL_NAMES: &[&str] = &[",
            f'pub const REMOVED_SKILL_NAMES: &[&str] = &[\n    "{name}",',
        )
        self.append(self.tree / WS / "templates/global-agent-rules.md", f"\nUse {name}.\n")
        self.assert_fails(f"references removed skill {name}")

    def test_missing_removed_names_declaration_fails(self) -> None:
        self.edit(self.tree / "src-tauri/src/managed_bootstrap.rs", "pub const REMOVED_SKILL_NAMES:", "const OTHER_NAMES:")
        self.assert_fails("missing REMOVED_SKILL_NAMES declaration")

    def append(self, path: Path, text: str) -> None:
        path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8")

    def test_injection_syntax_outside_claude_notes_fails(self) -> None:
        self.append(self.skill("tdd"), "\nCheck: !`git status`\n")
        self.assert_fails("Claude injection syntax is only allowed")

    def test_injection_fence_outside_claude_notes_fails(self) -> None:
        self.append(self.skill("tdd"), "\n```!\ngit status\n```\n")
        self.assert_fails("Claude injection syntax is only allowed")

    def test_injection_syntax_in_another_harness_subsection_fails(self) -> None:
        self.edit(self.skill("browser-qa"), "### Codex\n\n", "### Codex\n\n- Run !`ls` first.\n")
        self.assert_fails("Claude injection syntax is only allowed")

    def test_injection_syntax_in_claude_notes_passes(self) -> None:
        self.assertIn("!`", self.skill("release-check").read_text(encoding="utf-8"))
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_reference_into_a_sibling_skill_fails(self) -> None:
        self.append(self.skill("tdd"), "\nSee `../diagnose/SKILL.md` for the loop.\n")
        self.assert_fails("references the files of skill 'diagnose'")

    def test_sibling_reference_in_a_supporting_file_fails(self) -> None:
        self.append(self.skill("browser-qa").parent / "playwright-cli.md", "\nRead skills/tdd/SKILL.md first.\n")
        self.assert_fails("references the files of skill 'tdd'")

    def test_sibling_reference_in_a_supporting_script_fails(self) -> None:
        for filename, text in (
            ("helper.cjs", 'const shared = require("../tdd/helper.cjs");\n'),
            ("view.html", '<script src="../diagnose/app.js"></script>\n'),
        ):
            with self.subTest(filename=filename):
                path = self.skill("browser-qa").parent / filename
                path.write_text(text, encoding="utf-8")
                self.assert_fails("references the files of skill")
                path.unlink()

    def test_skills_path_inside_an_external_url_is_not_a_sibling_reference(self) -> None:
        self.append(self.skill("browser-qa").parent / "playwright-cli.md", "\nSee https://example.com/skills/tdd/SKILL.md and https://example.com/a/../diagnose/x.\n")
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_binary_supporting_file_is_ignored(self) -> None:
        (self.skill("browser-qa").parent / "image.bin").write_bytes(b"\xff\xfe../tdd/\x00")
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_adversarial_skill_reading_the_implementation_skill_fails(self) -> None:
        self.append(self.skill("adversarial-test"), "\nRecipes: `../adversarial-implementation/critic-recipes.md`.\n")
        self.assert_fails("references the files of skill 'adversarial-implementation'")

    def test_adversarial_reference_copies_must_match(self) -> None:
        copy = self.skill("adversarial-review").parent / "critic-recipes.md"
        self.append(copy, "\nExtra line.\n")
        self.assert_fails("critic-recipes.md: copies differ")

    def test_adversarial_skill_without_its_own_reference_copy_fails(self) -> None:
        (self.skill("adversarial-test").parent / "adversarial-roles.md").unlink()
        self.assert_fails("every adversarial-* skill carries its own copy of adversarial-roles.md")

    def test_light_harness_notes_are_accepted_last(self) -> None:
        text = self.skill("release-check").read_text(encoding="utf-8")
        self.assertTrue(text.rstrip().rsplit("### ", 1)[1].startswith("Light harnesses"))
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_harness_notes_out_of_order_fails(self) -> None:
        path = self.skill("browser-qa")
        text = path.read_text(encoding="utf-8")
        claude = text.index("### Claude Code")
        codex = text.index("### Codex")
        path.write_text(text[:claude] + text[codex:] + "\n" + text[claude:codex].rstrip("\n") + "\n", encoding="utf-8")
        self.assert_fails("harness notes must follow the order")

    def test_unknown_harness_subsection_fails(self) -> None:
        self.edit(self.skill("browser-qa"), "### Codex\n", "### Gemini\n")
        self.assert_fails("subsections must be from")

    def test_text_before_first_harness_subsection_fails(self) -> None:
        self.edit(self.skill("browser-qa"), "## Harness notes\n\n", "## Harness notes\n\nLoose text.\n\n")
        self.assert_fails("text between '## Harness notes' and its first subsection")

    def test_harness_notes_must_be_the_last_section(self) -> None:
        self.append(self.skill("browser-qa"), "\n## Extra\n\nMore.\n")
        self.assert_fails("must be the last '##' section")

    def test_claude_only_frontmatter_needs_claude_notes(self) -> None:
        self.edit(self.skill("tdd"), "license: MIT\n", "license: MIT\nallowed-tools: Bash(ls *)\n")
        self.assert_fails("Claude-only frontmatter")

    def test_riggverk_key_at_the_top_level_of_a_bundled_skill_fails(self) -> None:
        self.edit(self.skill("tdd"), "  category: testing\n", "")
        self.edit(self.skill("tdd"), "license: MIT\n", "license: MIT\ncategory: testing\n")
        self.assert_fails("top-level frontmatter keys ['category'] are outside the Agent Skills spec")

    def test_unknown_top_level_key_fails(self) -> None:
        self.edit(self.skill("tdd"), "license: MIT\n", "license: MIT\nversion: 2\n")
        self.assert_fails("top-level frontmatter keys ['version'] are outside the Agent Skills spec")

    def test_missing_license_fails(self) -> None:
        self.edit(self.skill("tdd"), "license: MIT\n", "")
        self.assert_fails("bundled skills declare 'license: MIT'")

    def test_unknown_or_missing_metadata_key_fails(self) -> None:
        self.edit(self.skill("tdd"), "  risk: low\n", "  owner: me\n")
        self.assert_fails("unknown ['owner'], missing ['risk']")

    def test_duplicate_metadata_key_fails(self) -> None:
        self.edit(self.skill("tdd"), "  risk: low\n", "  risk: low\n  risk: high\n")
        self.assert_fails("duplicate metadata keys ['risk']")

    def test_long_compatibility_fails(self) -> None:
        self.edit(self.skill("browser-qa"), "compatibility: Needs", "compatibility: " + "x" * 500 + " Needs")
        self.assert_fails("compatibility must be one safe plain YAML line")

    def test_targets_must_name_every_harness(self) -> None:
        self.edit(self.skill("tdd"), ", antigravity, grok\n", ", antigravity\n")
        self.assert_fails("missing targets: ['grok']")

    def test_metadata_wins_over_a_top_level_key_like_in_the_app(self) -> None:
        checker = load_checker(self.tree)
        frontmatter = "name: x\ndescription: d\nrisk: high\nmetadata:\n  risk: low\n  related: a, b\n"
        self.assertEqual(checker.skill_fields(frontmatter)["risk"], "low")
        self.assertEqual(checker.skill_fields(frontmatter)["related"], "a, b")
        self.assertEqual(checker.skill_fields("name: x\nrisk: high\n")["risk"], "high")

    def test_duplicate_frontmatter_key_fails(self) -> None:
        self.edit(self.skill("release-check"), "agent: verifier\n", "agent: verifier\nagent: other\n")
        self.assert_fails("duplicate frontmatter keys ['agent']")

    def test_crlf_and_bom_fail(self) -> None:
        path = self.skill("tdd")
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        self.assert_fails("LF line endings")
        path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes().replace(b"\r\n", b"\n"))
        self.assert_fails("UTF-8 BOM")

    def test_stale_codex_skills_folder_claim_in_the_rules_fails(self) -> None:
        self.edit(
            self.tree / WS / "templates/rules/codex.md",
            "skills install to `~/.agents/skills`, which Codex reads (`$CODEX_HOME/skills` with a customised `CODEX_HOME`).",
            "skills install to `$CODEX_HOME/skills` (typically `~/.codex/skills`).",
        )
        self.assert_fails("stale skills folder claim")

    def test_codex_rules_must_name_the_agents_skills_folder(self) -> None:
        self.edit(self.tree / WS / "templates/rules/codex.md", "`~/.agents/skills`", "the skills folder")
        self.assert_fails("must name ~/.agents/skills")

    def test_stale_skills_folder_claim_in_a_doc_fails(self) -> None:
        self.append(self.tree / WS / "docs/CODEX_CONFIG.md", "\n- Codex: `$CODEX_HOME/skills` (typically `~/.codex/skills`)\n")
        self.assert_fails("stale skills folder claim")

    def test_leftover_per_harness_adapter_fails(self) -> None:
        adapter = self.tree / WS / "templates/skills/claude/tdd/SKILL.md"
        adapter.parent.mkdir(parents=True)
        adapter.write_text(self.skill("tdd").read_text(encoding="utf-8"), encoding="utf-8")
        self.assert_fails("templates/skills is retired")

    def test_description_over_300_chars_fails(self) -> None:
        self.edit(self.skill("tdd"), "Not for unknown root causes (diagnose).", "Not for unknown root causes (diagnose). " + "x" * 80)
        self.assert_fails("description is")

    def test_description_without_use_when_fails(self) -> None:
        self.edit(self.skill("tdd"), "Use when expected behavior", "Use if expected behavior")
        self.assert_fails("must contain 'Use when'")

    def test_block_scalar_description_fails(self) -> None:
        path = self.skill("tdd")
        text = path.read_text(encoding="utf-8").splitlines(keepends=True)
        index = next(i for i, line in enumerate(text) if line.startswith("description: "))
        text[index:index + 1] = ["description: >\n", "  " + text[index][len("description: "):]]
        path.write_text("".join(text), encoding="utf-8")
        self.assert_fails("block scalar")

    def test_description_with_colon_space_fails(self) -> None:
        self.edit(self.skill("tdd"), "Drives one specified behavior", "Drives: one specified behavior")
        self.assert_fails("safe plain YAML scalar")

    def test_missing_done_when_fails(self) -> None:
        self.edit(self.skill("zoom-out"), "Done when:", "Finished when:")
        self.assert_fails("Done when")

    def test_unknown_related_name_fails(self) -> None:
        self.edit(self.skill("tdd"), "related: diagnose, implementation-plan", "related: diagnose, no-such-skill")
        self.assert_fails("related skill 'no-such-skill' does not exist")

    def test_description_budget_fails(self) -> None:
        # Mutate a copy of the budget by lowering it through the module constant.
        script = self.tree / "scripts/check-skill-routing.py"
        self.edit(script, "CATALOG_DESCRIPTION_BUDGET = 8000", "CATALOG_DESCRIPTION_BUDGET = 100")
        self.assert_fails("skill descriptions total")

    def test_user_invoked_skill_in_routing_bullet_fails(self) -> None:
        self.edit(self.tree / WS / "templates/rules/claude.md", "## Claude harness\n", "## Claude harness\n\n- Retrospectives: `retro`.\n")
        self.assert_fails("names user-invoked skill `retro`")

    def test_user_invoked_flag_on_routed_skill_fails(self) -> None:
        # zoom-out is routed by the global rules; hiding it from the model would be a contradiction.
        self.edit(self.skill("zoom-out"), "license: MIT\n", "license: MIT\ndisable-model-invocation: true\n")
        self.assert_fails("names user-invoked skill `zoom-out`")

    def test_adversarial_skill_in_routing_bullet_fails(self) -> None:
        self.edit(
            self.tree / WS / "templates/global-agent-rules.md",
            "## Skill routing\n",
            "## Skill routing\n- Risky changes: `adversarial-review`.\n",
        )
        self.assert_fails("names on-request skill `adversarial-review`")

    def test_user_invoked_skill_in_composed_sync_rules_fails(self) -> None:
        sync = self.tree / WS / "templates/sync/codex-rules.md"
        sync.write_text(sync.read_text(encoding="utf-8") + "\n- Retrospectives: `retro`.\n", encoding="utf-8")
        self.assert_fails("codex-rules.md")

    def test_agents_metadata_default_skills_must_match_claude_header(self) -> None:
        self.edit(self.tree / WS / "metadata/agents.json", '"default_skills": ["zoom-out"]', '"default_skills": []')
        self.assert_fails("differ from Claude header skills")

    def test_agents_metadata_unknown_default_skill_fails(self) -> None:
        self.edit(self.tree / WS / "metadata/agents.json", '"default_skills": ["zoom-out"]', '"default_skills": ["no-such-skill"]')
        self.assert_fails("unknown skill 'no-such-skill'")

    def test_agents_metadata_targets_must_match_adapter_manifest(self) -> None:
        self.edit(self.tree / WS / "metadata/agents.json", '"targets": ["opencode", "claude", "codex"]', '"targets": ["opencode"]')
        self.assert_fails("differ from")

    def test_removed_skill_in_toml_agent_fails(self) -> None:
        agent = self.tree / WS / "templates/codex/agents/inspector.toml"
        removed = "grill" + "-me"  # built at runtime so this file is not itself a stale reference
        agent.write_text(agent.read_text(encoding="utf-8") + f"\n# see {removed}\n", encoding="utf-8")
        self.assert_fails(f"removed skill {removed}")

    def test_removed_skill_in_git_ignored_file_passes(self) -> None:
        removed = "grill" + "-me"
        subprocess.run(["git", "init", "-q"], cwd=self.tree, check=True)
        (self.tree / ".git/info/exclude").write_text("notes/\n", encoding="utf-8")
        (self.tree / "notes").mkdir()
        (self.tree / "notes/old.md").write_text(f"see {removed}\n", encoding="utf-8")
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        (self.tree / "draft.md").write_text(f"see {removed}\n", encoding="utf-8")
        self.assert_fails(f"draft.md: references removed skill {removed}")


class PortableSkillBodyTests(unittest.TestCase):
    """The bundled skills keep working as plain instructions in a harness that ignores Claude extras."""

    def body_before_notes(self, name: str) -> str:
        text = (ROOT / WS / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
        return text.split("## Harness notes")[0]

    def test_state_commands_are_plain_steps_outside_the_claude_notes(self) -> None:
        for name in ("release-check", "handoff"):
            body = self.body_before_notes(name)
            self.assertIn("`git status --short", body, name)
            self.assertIn("`git log --oneline", body, name)
            self.assertNotIn("!`", body, name)

    def test_retro_names_both_invocations_without_relying_on_the_flag(self) -> None:
        text = (ROOT / WS / "skills/retro/SKILL.md").read_text(encoding="utf-8")
        description = next(line for line in text.splitlines() if line.startswith("description:"))
        self.assertIn("/retro", description)
        self.assertIn("$retro", description)
        self.assertIn("## Invocation", text)

    def test_release_check_keeps_the_gate_exit_status(self) -> None:
        body = self.body_before_notes("release-check")
        self.assertIn("pipefail", body)
        self.assertIn("exit status", body)

    def test_playwright_cli_route_is_bounded_and_pinned_to_the_local_install(self) -> None:
        text = (ROOT / WS / "skills/browser-qa/playwright-cli.md").read_text(encoding="utf-8")
        self.assertNotIn("npx playwright install", text)
        self.assertNotIn("npx playwright screenshot", text)
        self.assertIn("node_modules/.bin/playwright", text)
        self.assertIn("MAX_BYTES", text)
        self.assertIn("MAX_EVENTS", text)
        self.assertIn("u.host", text)  # userinfo is dropped by printing protocol and host only
        self.assertNotIn("m.text()}", text)  # no raw console text in a template string

    def test_current_docs_has_a_fallback_without_web_tools(self) -> None:
        body = self.body_before_notes("current-docs")
        self.assertIn("llms.txt", body)
        self.assertIn("could not be fetched", body)

    def test_browser_qa_points_at_its_playwright_cli_route(self) -> None:
        folder = ROOT / WS / "skills/browser-qa"
        self.assertIn("playwright-cli.md", self.body_before_notes("browser-qa"))
        self.assertIn('playwright" install chromium', (folder / "playwright-cli.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
