#!/usr/bin/env python3
"""Unit tests for global Cursor profile merge and safety checks."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PERMISSIONS_TEMPLATE = ROOT / "templates" / "cursor" / "permissions" / "global-playwright.json"
MCP_TEMPLATE = ROOT / "templates" / "cursor" / "mcp" / "playwright.mcp.json"
PLAYWRIGHT_LIB = SCRIPTS / "playwright-mcp-lib.sh"
CURSOR_LIB = SCRIPTS / "cursor-global-profile-lib.sh"


def test_env(home: Path) -> dict[str, str]:
    return {
        "WORKSPACE_ROOT": str(ROOT),
        "HOME": str(home),
        "AW_PYTHON": sys.executable,
    }


def merge_permissions(template: Path, target: Path) -> None:
    env = test_env(target.parent.parent)
    subprocess.run(
        [
            "bash",
            "-c",
            f'source "{CURSOR_LIB}" && merge_cursor_permissions "{template}" "{target}"',
        ],
        check=True,
        env=env,
    )


def merge_mcp(template: Path, target: Path, config_path: str, browsers_path: str) -> None:
    env = test_env(target.parent.parent)
    subprocess.run(
        [
            "bash",
            "-c",
            (
                f'source "{PLAYWRIGHT_LIB}" && '
                f'merge_cursor_playwright_mcp "{template}" "{target}" '
                f'"{config_path}" "{browsers_path}" "0.0.48"'
            ),
        ],
        check=True,
        env=env,
    )


def permissions_unsafe(path: Path) -> bool:
    env = {"WORKSPACE_ROOT": str(ROOT)}
    proc = subprocess.run(
        [
            "bash",
            "-c",
            f'source "{CURSOR_LIB}" && permissions_json_unsafe "{path}"',
        ],
        env=env,
    )
    return proc.returncode != 0


class GlobalProfileMergeTests(unittest.TestCase):
    def test_permissions_merge_preserves_unrelated_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / ".cursor" / "permissions.json"
            target.parent.mkdir(parents=True)
            target.write_text(
                json.dumps(
                    {
                        "mcpAllowlist": ["github:*"],
                        "terminalAllowlist": ["git status"],
                        "custom": True,
                    }
                ),
                encoding="utf-8",
            )
            merge_permissions(PERMISSIONS_TEMPLATE, target)
            data = json.loads(target.read_text(encoding="utf-8"))
            self.assertIn("github:*", data["mcpAllowlist"])
            self.assertIn("playwright:*", data["mcpAllowlist"])
            self.assertEqual(data["terminalAllowlist"], ["git status"])
            self.assertTrue(data["custom"])

    def test_permissions_merge_creates_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / ".cursor" / "permissions.json"
            target.parent.mkdir(parents=True)
            merge_permissions(PERMISSIONS_TEMPLATE, target)
            data = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(data["mcpAllowlist"], ["playwright:*"])
            self.assertNotIn("terminalAllowlist", data)

    def test_mcp_merge_preserves_other_servers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / ".cursor" / "mcp.json"
            target.parent.mkdir(parents=True)
            target.write_text(
                json.dumps({"mcpServers": {"github": {"url": "https://example.com"}}}),
                encoding="utf-8",
            )
            merge_mcp(
                MCP_TEMPLATE,
                target,
                str(Path(tmp) / "pw-config.json"),
                str(Path(tmp) / "browsers"),
            )
            data = json.loads(target.read_text(encoding="utf-8"))
            self.assertIn("github", data["mcpServers"])
            self.assertIn("playwright", data["mcpServers"])
            self.assertEqual(data["mcpServers"]["playwright"]["command"], "npx")

    def test_unsafe_terminal_allowlist_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "permissions.json"
            path.write_text(
                json.dumps({"terminalAllowlist": ["npx -y @playwright/mcp"]}),
                encoding="utf-8",
            )
            self.assertTrue(permissions_unsafe(path))

    def test_unsafe_mcp_run_everything_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "permissions.json"
            path.write_text(json.dumps({"mcpAllowlist": ["*:*"]}), encoding="utf-8")
            self.assertTrue(permissions_unsafe(path))

    def test_safe_permissions_template_passes(self) -> None:
        self.assertFalse(permissions_unsafe(PERMISSIONS_TEMPLATE))

    def test_install_script_accepts_apply_global_profile(self) -> None:
        script = SCRIPTS / "install-cursor-workspace.sh"
        proc = subprocess.run(
            ["bash", str(script), "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--apply-global-profile", proc.stdout)
        self.assertIn("--diff-global-profile", proc.stdout)
        self.assertIn("--validate-global-profile", proc.stdout)

    def test_apply_global_profile_writes_only_under_temp_home(self) -> None:
        script = SCRIPTS / "install-cursor-workspace.sh"
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            fake_project = home / "project"
            fake_project.mkdir()
            env = {
                "HOME": str(home),
                "AGENT_WORKSPACE_BACKUP_DIR": str(home / "backups"),
            }
            proc = subprocess.run(
                ["bash", str(script), "--apply-global-profile", "--quiet"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
            self.assertTrue((home / ".cursor" / "mcp.json").is_file())
            self.assertTrue((home / ".cursor" / "permissions.json").is_file())
            perms = json.loads(
                (home / ".cursor" / "permissions.json").read_text(encoding="utf-8")
            )
            self.assertIn("playwright:*", perms.get("mcpAllowlist", []))
            self.assertNotIn("terminalAllowlist", perms)
            self.assertFalse((fake_project / ".cursor").exists())


    def test_apply_global_profile_honors_custom_profile_root_env(self) -> None:
        script = SCRIPTS / "install-cursor-workspace.sh"
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            profile_root = home / "custom-cursor-profile"
            home.mkdir()
            env = {
                "HOME": str(home),
                "CURSOR_PROFILE_ROOT": str(profile_root),
                "CURSOR_AGENTS_PATH": str(profile_root / "agents"),
                "CURSOR_SKILLS_PATH": str(profile_root / "skills"),
                "CURSOR_MCP_CONFIG_PATH": str(profile_root / "mcp.json"),
                "CURSOR_PERMISSIONS_PATH": str(profile_root / "permissions.json"),
                "AGENT_WORKSPACE_BACKUP_DIR": str(home / "backups"),
            }
            proc = subprocess.run(
                ["bash", str(script), "--apply-global-profile", "--quiet"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
            self.assertTrue((profile_root / "mcp.json").is_file())
            self.assertTrue((profile_root / "permissions.json").is_file())
            self.assertFalse((home / ".cursor").exists())

if __name__ == "__main__":
    sys.exit(unittest.main())
