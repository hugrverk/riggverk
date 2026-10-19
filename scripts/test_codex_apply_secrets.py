#!/usr/bin/env python3
"""Apply the bundled Codex merge and routing scripts to a config that holds secrets.

The scripts run against a copy in a temporary HOME. Their output must not print a secret, the
user's own values must survive, the managed defaults must apply and the legacy profile
selector must go.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WS_SCRIPTS = ROOT / "resources/default-workspace/scripts"
TEMPLATE = ROOT / "resources/default-workspace/templates/codex/config.toml"

SECRETS = ("sk-test-secret-key-12345", "ghp_test_secret_token_54321", "test-secret-value-98765")
USER_CONFIG = f'''# User Codex config
profile = "safe"
model = "gpt-4"
personality = "helpful"

[test-secret-section]
api_key = "{SECRETS[0]}"
token = "{SECRETS[1]}"

[mcp_servers.custom-server]
command = "custom"
args = []
env = {{API_KEY = "{SECRETS[2]}"}}

[profiles.safe]
sandbox_mode = false
model = "gpt-4"

[unknown-table]
value = "should-be-preserved"
'''


class CodexApplySecretsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        home = Path(cls._tmp.name)
        config = home / ".codex/config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(USER_CONFIG, encoding="utf-8")
        backups = home / "backups"
        backups.mkdir()
        env = {**os.environ, "HOME": str(home)}
        cls.output = ""
        cls.returncodes = []
        for script in ("merge-codex-config.py", "ensure-codex-routing-defaults.py"):
            result = subprocess.run(
                [sys.executable, str(WS_SCRIPTS / script), "--apply", str(config), str(TEMPLATE), "--backup-dir", str(backups)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            cls.returncodes.append(result.returncode)
            cls.output += result.stdout + result.stderr
        cls.result = tomllib.loads(config.read_text(encoding="utf-8"))
        cls.template = tomllib.loads(TEMPLATE.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_apply_succeeds(self) -> None:
        self.assertEqual(self.returncodes, [0, 0], self.output)

    def test_output_does_not_print_secrets(self) -> None:
        # Prefixes, so a truncated secret counts as printed too.
        for marker in ("sk-test-secret", "ghp_test_secret", "test-secret-value-98765"):
            self.assertNotIn(marker, self.output)

    def test_managed_defaults_apply(self) -> None:
        for key in ("approval_policy", "sandbox_mode"):
            self.assertEqual(self.result.get(key), self.template[key], key)
        # An absent create-only key is seeded from the template.
        self.assertEqual(self.result.get("model_reasoning_effort"), self.template["model_reasoning_effort"])

    def test_user_values_survive(self) -> None:
        self.assertEqual(self.result.get("model"), "gpt-4")  # create-only key the user set
        self.assertEqual(self.result.get("personality"), "helpful")
        self.assertEqual(self.result.get("unknown-table", {}).get("value"), "should-be-preserved")
        self.assertEqual(self.result["test-secret-section"]["api_key"], SECRETS[0])

    def test_legacy_profile_selector_removed_and_custom_profile_kept(self) -> None:
        self.assertNotIn("profile", self.result)
        self.assertEqual(self.result.get("profiles", {}).get("safe", {}).get("model"), "gpt-4")


if __name__ == "__main__":
    unittest.main()
