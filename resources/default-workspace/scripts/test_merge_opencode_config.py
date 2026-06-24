#!/usr/bin/env python3
"""Regression tests for merge-opencode-config.py.

Tests output boundary, private marker protection, managed key sync,
user key preservation, and rollback safety.  Does not inspect real
user configuration — private marker values are synthetic.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

# Path to the script under test
SCRIPT = Path(__file__).resolve().parent / "merge-opencode-config.py"

# Private marker values — must never appear on stdout/stderr
PRIVATE_MARKERS = frozenset([
    "private-marker-opencode-abc123",
    "private-plugin-key-xyz",
    "user-mcp-secret-opencode-private-key",
    "my-user-secret-value-999",
])


def write_json(path: Path, data: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def installed_with_markers(tmp: Path) -> Path:
    """Create an installed config with obvious private markers."""
    return write_json(tmp / "installed.json", {
        "model": "old-model",
        "user_api_key": "private-marker-opencode-abc123",
        "custom_plugin": {"enabled": True, "secret": "private-plugin-key-xyz"},
        "mcp": {
            "user-mcp-server": {
                "apiKey": "user-mcp-secret-opencode-private-key",
                "url": "https://private.example.com/mcp",
            },
        },
    })


def managed_config(tmp: Path) -> Path:
    """Create a bundled managed config."""
    # model is listed in the real opencode-managed-keys.json
    return write_json(tmp / "rendered.json", {
        "model": "claude-sonnet-4-20260506",
    })


def run_script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def check_no_markers(text: str, label: str) -> None:
    for marker in PRIVATE_MARKERS:
        assert marker not in text, f"Private marker {marker!r} found in {label}"


# ── Tests ──


def test_private_markers_not_on_stdout_or_stderr() -> None:
    """--merge --output must not leak private markers to stdout/stderr."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_config(tmp)
        out = tmp / "merged.json"
        result = run_script(str(installed), str(managed), "--merge", "--output", str(out))

        assert result.returncode == 0, f"merge failed: {result.stderr}"
        check_no_markers(result.stdout, "stdout")
        check_no_markers(result.stderr, "stderr")


def test_private_markers_present_in_output_file() -> None:
    """Private markers must be preserved in the output JSON file."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_config(tmp)
        out = tmp / "merged.json"
        run_script(str(installed), str(managed), "--merge", "--output", str(out))

        merged = json.loads(out.read_text(encoding="utf-8"))
        assert merged["user_api_key"] == "private-marker-opencode-abc123"
        assert merged["custom_plugin"]["secret"] == "private-plugin-key-xyz"
        assert (
            merged["mcp"]["user-mcp-server"]["apiKey"]
            == "user-mcp-secret-opencode-private-key"
        )


def test_managed_keys_updated_in_output() -> None:
    """Managed keys like model must be updated in output."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_json(tmp / "installed.json", {
            "model": "old-model",
            "user_key": "user-val",
        })
        managed = write_json(tmp / "rendered.json", {
            "model": "claude-sonnet-4-20260506",
        })
        out = tmp / "merged.json"
        run_script(str(installed), str(managed), "--merge", "--output", str(out))

        merged = json.loads(out.read_text(encoding="utf-8"))
        assert merged["model"] == "claude-sonnet-4-20260506"


def test_unrelated_user_keys_preserved() -> None:
    """Non-managed user keys must survive merge."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_json(tmp / "installed.json", {
            "model": "old-model",
            "user_model_setting": "gpt-4",
            "custom_thing": {"nested": True, "secret": "my-user-secret-value-999"},
        })
        managed = write_json(tmp / "rendered.json", {"model": "new-model"})
        out = tmp / "merged.json"
        run_script(str(installed), str(managed), "--merge", "--output", str(out))

        merged = json.loads(out.read_text(encoding="utf-8"))
        assert merged["model"] == "new-model"
        assert merged["user_model_setting"] == "gpt-4"
        assert merged["custom_thing"]["nested"] is True
        assert merged["custom_thing"]["secret"] == "my-user-secret-value-999"


def test_missing_output_is_rejected() -> None:
    """--merge without --output must fail before producing merged content."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_config(tmp)
        result = run_script(str(installed), str(managed), "--merge")
        assert result.returncode != 0, "--merge without --output must fail"
        assert "--merge requires --output" in (result.stderr + result.stdout)


def test_output_without_merge_is_rejected() -> None:
    """--output without --merge must fail."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_config(tmp)
        out = tmp / "merged.json"
        result = run_script(str(installed), str(managed), "--output", str(out))
        assert result.returncode != 0, "--output without --merge must fail"
        assert "--output requires --merge" in (result.stderr + result.stdout)


def test_managed_match_remains_exit_code_based() -> None:
    """--managed-match must exit 0 on match, 1 on mismatch."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        # model is a managed key in the real metadata
        installed = write_json(tmp / "installed.json", {
            "model": "same",
            "user_key": "user-val",
        })
        managed = write_json(tmp / "rendered.json", {"model": "same"})

        result = run_script(str(installed), str(managed), "--managed-match")
        assert result.returncode == 0, "should exit 0 when matching"

        managed2 = write_json(tmp / "rendered2.json", {"model": "different"})
        result2 = run_script(str(installed), str(managed2), "--managed-match")
        assert result2.returncode == 1, "should exit 1 when mismatching"


def test_managed_match_missing_target_exits_1() -> None:
    """--managed-match with missing target exits 1."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        missing = tmp / "nonexistent.json"
        # model is a managed key in the real metadata
        managed = write_json(tmp / "managed.json", {"model": "x"})
        result = run_script(str(missing), str(managed), "--managed-match")
        assert result.returncode == 1


def test_no_stdout_leak_on_apply() -> None:
    """--apply must not write full config to stdout, even on error."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_json(tmp / "installed.json", {
            "model": "old",
            "user_secret": "private-apply-marker-999",
        })
        # model is a managed key in the real metadata
        managed = write_json(tmp / "rendered.json", {"model": "new"})
        backup = tmp / "backups"
        result = run_script(
            str(installed), str(managed), "--apply", "--backup-dir", str(backup)
        )
        assert "private-apply-marker-999" not in result.stdout
        assert "private-apply-marker-999" not in result.stderr
        # Verify managed key was applied
        final = json.loads(installed.read_text(encoding="utf-8"))
        assert final["model"] == "new"
        assert final["user_secret"] == "private-apply-marker-999"


def test_apply_rollback_restores_on_bad_target() -> None:
    """Apply to a non-dict target must fail without corrupting original."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        # Write a non-dict installed config
        installed = tmp / "installed.json"
        installed.write_text(json.dumps(["not", "a", "dict"]) + "\n", encoding="utf-8")
        # model is a managed key in the real metadata
        managed = write_json(tmp / "rendered.json", {"model": "new"})
        backup = tmp / "backups"
        result = run_script(
            str(installed), str(managed), "--apply", "--backup-dir", str(backup)
        )
        assert result.returncode != 0, "apply to non-dict should fail"
        # Original should be unchanged
        assert json.loads(installed.read_text(encoding="utf-8")) == ["not", "a", "dict"]

# ── Main guard ──

if __name__ == "__main__":
    tests = [
        obj
        for name, obj in sorted(sys.modules[__name__].__dict__.items())
        if name.startswith("test_") and callable(obj)
    ]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"  PASS  {test.__name__}")
        except Exception as exc:
            print(f"  FAIL  {test.__name__}: {exc}")
            failures += 1
    if failures:
        print(f"\n{failures} test(s) FAILED")
        sys.exit(1)
    print(f"\nAll {len(tests)} test(s) PASSED")
