#!/usr/bin/env python3
"""Negative tests for scripts/check-harness-mirror.py.

Each case copies the inputs of the checker into a throwaway tree, breaks exactly one of the mirrored
lists and asserts the checker fails with the expected message, so none of the comparisons can
silently become a no-op.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check-harness-mirror.py"

_spec = importlib.util.spec_from_file_location("check_harness_mirror", SCRIPT)
assert _spec and _spec.loader
mirror = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mirror)


class CheckHarnessMirrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tree = Path(self._tmp.name)
        for rel in mirror.INPUTS:
            target = self.tree / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, target)

    def edit(self, rel: str, old: str, new: str, count: int = 1) -> None:
        path = self.tree / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"{rel} no longer contains {old!r}: update the test")
        path.write_text(text.replace(old, new, count), encoding="utf-8")

    def run_check(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.tree)],
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_fails(self, message: str) -> None:
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)

    def test_the_repository_agrees(self) -> None:
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("7 harnesses (4 central, 3 light)", result.stdout)

    def test_a_missing_input_is_reported(self) -> None:
        (self.tree / mirror.TS_VIEWS).unlink()
        self.assert_fails("inputs missing")

    # Rust ids

    def test_a_rust_variant_missing_from_all(self) -> None:
        self.edit(mirror.RUST_TARGETS, "        HarnessId::Pi,\n        HarnessId::Kilo,\n    ];\n\n    /// The harnesses enabled", "        HarnessId::Kilo,\n    ];\n\n    /// The harnesses enabled")
        self.assert_fails("HarnessId::ALL")

    def test_a_rust_variant_the_ui_does_not_know(self) -> None:
        self.edit(mirror.RUST_TARGETS, "    Kilo,\n}", "    Kilo,\n    Extra,\n}")
        self.assert_fails("HarnessId::ALL")

    def test_a_wire_name_that_serde_would_not_write(self) -> None:
        self.edit(mirror.RUST_TARGETS, 'HarnessId::Kilo => "kilo"', 'HarnessId::Kilo => "kilocode"')
        self.assert_fails("HarnessId::as_str")

    def test_a_light_harness_switched_on_by_default_in_rust_only(self) -> None:
        self.edit(
            mirror.RUST_TARGETS,
            "        HarnessId::Claude,\n        HarnessId::Cursor,\n    ];\n\n    pub fn as_str",
            "        HarnessId::Claude,\n        HarnessId::Cursor,\n        HarnessId::Kilo,\n    ];\n\n    pub fn as_str",
        )
        self.assert_fails("HarnessId tiers")

    # TypeScript lists

    def test_a_harness_missing_from_the_typescript_lists(self) -> None:
        self.edit(mirror.TS_TYPES, '"copilot", "pi", "kilo"', '"copilot", "pi"')
        self.assert_fails("INSTALL_AGENTS")

    def test_a_central_list_that_is_missing_a_harness_changes_the_whole_list(self) -> None:
        self.edit(mirror.TS_TYPES, '["codex", "opencode", "claude", "cursor"] as const', '["codex", "opencode", "claude"] as const')
        self.assert_fails("INSTALL_AGENTS")

    def test_central_agents_that_are_not_the_rust_defaults_in_order(self) -> None:
        self.edit(
            mirror.RUST_TARGETS,
            "        HarnessId::Codex,\n        HarnessId::OpenCode,\n        HarnessId::Claude,\n        HarnessId::Cursor,\n    ];\n\n    pub fn as_str",
            "        HarnessId::Codex,\n        HarnessId::Claude,\n        HarnessId::OpenCode,\n        HarnessId::Cursor,\n    ];\n\n    pub fn as_str",
        )
        self.assert_fails("CENTRAL_AGENTS")

    def test_the_ts_default_must_stay_the_central_four(self) -> None:
        self.edit(mirror.TS_INSTALL, "= CENTRAL_AGENTS;", "= INSTALL_AGENTS;")
        self.assert_fails("DEFAULT_ENABLED_HARNESS_IDS")

    def test_a_tab_missing_for_a_harness(self) -> None:
        self.edit(mirror.TS_INSTALL, '"copilot", "pi", "kilo"];', '"copilot", "pi"];')
        self.assert_fails("HARNESS_NAV_ORDER")

    def test_light_tabs_must_follow_the_central_ones(self) -> None:
        self.edit(
            mirror.TS_INSTALL,
            '["codex", "opencode", "cursor", "claude", "copilot", "pi", "kilo"]',
            '["copilot", "codex", "opencode", "cursor", "claude", "pi", "kilo"]',
        )
        self.assert_fails("the light tier must follow")

    def test_a_label_missing_for_a_harness(self) -> None:
        self.edit(mirror.TS_INSTALL, '  kilo: "Kilo",\n', "")
        self.assert_fails("HARNESS_LABELS")

    def test_surfaces_missing_for_a_harness(self) -> None:
        self.edit(mirror.TS_INSTALL, '  kilo: ["skills"],\n', "")
        self.assert_fails("HARNESS_SURFACES")

    def test_a_view_missing_for_a_harness(self) -> None:
        self.edit(mirror.TS_VIEWS, '  | "kilo"\n', "")
        self.assert_fails("AppView")

    def test_a_short_tab_label_missing_for_a_harness(self) -> None:
        self.edit(mirror.TS_VIEWS, '  kilo: "kilo",\n', "")
        self.assert_fails("HARNESS_SHORT")

    # The descriptor

    def test_a_descriptor_without_a_light_harness(self) -> None:
        self.edit(mirror.DESCRIPTOR, '    "pi": {\n      "label": "Pi",\n      "cli": { "program": "pi" }\n    },\n', "")
        self.assert_fails("light descriptor")

    def test_a_descriptor_with_a_harness_twice(self) -> None:
        self.edit(
            mirror.DESCRIPTOR,
            '    "pi": {',
            '    "pi": {\n      "label": "Pi",\n      "cli": { "program": "pi" }\n    },\n    "pi": {',
        )
        self.assert_fails("lists a name twice")

    def test_a_label_that_differs_from_the_ui_label(self) -> None:
        self.edit(mirror.DESCRIPTOR, '"label": "Copilot"', '"label": "GitHub Copilot"')
        self.assert_fails("label of copilot")

    def test_a_harness_without_a_cli_program(self) -> None:
        self.edit(mirror.DESCRIPTOR, '"cli": { "program": "kilo" }', '"cli": { "program": "" }')
        self.assert_fails("no cli.program")

    # Skills reach, surfaces and targets

    def test_a_skill_folder_the_ui_does_not_know(self) -> None:
        self.edit(mirror.TS_TYPES, '  | "kilo";', '  | "kilo_x";')
        self.assert_fails("SkillReadFolder")

    def test_a_load_flag_the_ui_does_not_know(self) -> None:
        self.edit(mirror.TS_TYPES, '  | "shadowed_by_folder_order"\n', "")
        self.assert_fails("SkillLoadFlag")

    def test_a_rust_folder_missing_from_all(self) -> None:
        self.edit(mirror.RUST_ROOTS, "        ReadFolder::Kilo,\n    ];", "    ];")
        self.assert_fails("ReadFolder::ALL")

    def test_a_surface_only_one_side_knows(self) -> None:
        self.edit(mirror.TS_TYPES, '  | "workspace_bundle";', '  | "workspace_bundle"\n  | "copilot_rules";')
        self.assert_fails("SetupSurfaceId")

    def test_a_target_only_the_backend_knows(self) -> None:
        self.edit(mirror.RUST_TARGETS, 'id: "cursor_setup"', 'id: "cursor_setup_2"')
        self.assert_fails("SetupTargetId")

    # Wiring

    def test_a_health_loader_missing_for_a_light_harness(self) -> None:
        self.edit(mirror.TS_APP, '      pi: generation => loadLightRuntimeHealth("pi", generation),\n', "")
        self.assert_fails("no entry for pi")

    def test_the_light_pages_must_render_through_the_shared_view(self) -> None:
        self.edit(mirror.TS_APP, "LightHarnessView", "SomethingElse", count=-1)
        self.assert_fails("LightHarnessView")

    def test_the_health_command_must_be_registered(self) -> None:
        self.edit(mirror.RUST_LIB, "get_light_runtime_health,\n            list_skills", "list_skills")
        self.edit(mirror.RUST_LIB, "get_light_runtime_health, ", "")
        self.assert_fails("get_light_runtime_health")


if __name__ == "__main__":
    unittest.main()
