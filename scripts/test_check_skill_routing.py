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
    (dest / "src/lib").mkdir(parents=True)
    shutil.copy2(ROOT / "src/lib/brainSetup.ts", dest / "src/lib/brainSetup.ts")


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

    def regenerate(self) -> None:
        result = run(self.tree, "generate-skill-adapters.py", "--write")
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_fails(self, message: str) -> None:
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)

    def test_baseline_passes(self) -> None:
        result = run(self.tree, "check-skill-routing.py")
        self.assertEqual(result.returncode, 0, result.stderr)

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
        self.edit(self.skill("zoom-out"), "category: architecture", "disable-model-invocation: true\ncategory: architecture")
        self.regenerate()
        self.assert_fails("names user-invoked skill `zoom-out`")

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


if __name__ == "__main__":
    unittest.main()
