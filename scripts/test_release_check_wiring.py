#!/usr/bin/env python3
"""Every checker runs in the release gate and every generator is registered.

A new scripts/check-*.py, validate_*.py or smoke-*.sh that release-check.sh never calls would
guard nothing; a new generate-*.py missing from the generate.py registry would never be
checked for staleness.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look their module up while the class is built
    spec.loader.exec_module(module)
    return module


def gate_commands() -> str:
    """release-check.sh without its comment lines."""
    text = (SCRIPTS / "release-check.sh").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


class ReleaseCheckWiringTests(unittest.TestCase):
    def test_every_checker_runs_in_the_gate(self) -> None:
        commands = gate_commands()
        scripts = sorted(
            [*SCRIPTS.glob("check-*.py"), *SCRIPTS.glob("validate_*.py"), *SCRIPTS.glob("smoke-*.sh"), SCRIPTS / "generate.py"]
        )
        self.assertTrue(scripts)
        for path in scripts:
            with self.subTest(script=path.name):
                self.assertIn(f"scripts/{path.name}", commands)

    def test_python_tests_run_by_glob_and_bundled_merge_tests_run(self) -> None:
        commands = gate_commands()
        self.assertIn("for test_file in scripts/test_*.py", commands)
        self.assertIn("run_python_unittests", commands)
        self.assertIn("resources/default-workspace/scripts/test_merge_codex_config.py", commands)

    def test_every_generator_is_registered(self) -> None:
        generate = load("generate_wiring", "generate.py")
        registered = {generator.script for generator in generate.REGISTRY}
        for path in sorted(SCRIPTS.glob("generate-*.py")):
            with self.subTest(script=path.name):
                self.assertIn(f"scripts/{path.name}", registered)

    def test_managed_installation_required_gates_are_in_the_gate(self) -> None:
        contract = load("managed_installation_contract_wiring", "check-managed-installation-contract.py")
        commands = gate_commands()
        self.assertIn("python3 scripts/generate.py check", contract.REQUIRED_GATES)
        for command in contract.REQUIRED_GATES:
            with self.subTest(command=command):
                self.assertIn(command, commands)


if __name__ == "__main__":
    unittest.main()
