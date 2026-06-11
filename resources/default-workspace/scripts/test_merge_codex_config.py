#!/usr/bin/env python3
"""Regression tests for merge-codex-config.py.

Tests output boundary, private marker protection, managed key sync,
user content preservation, comment preservation, and rollback safety.
Does not inspect real user configuration.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

# Path to the script under test
SCRIPT = Path(__file__).resolve().parent / "merge-codex-config.py"

# Private marker values — must never appear on stdout/stderr
PRIVATE_MARKERS = frozenset([
    "my-user-secret-token-999",
    "user-personality-value-private",
    "my-custom-api-key-888",
    "private-mcp-token-codex-777",
])


def write_file(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def run_script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def check_no_markers(text: str, label: str) -> None:
    for marker in PRIVATE_MARKERS:
        assert marker not in text, f"Private marker {marker!r} found in {label}"


# ── Fixtures ──


def managed_toml(tmp: Path) -> Path:
    """Create a bundled managed config."""
    return write_file(tmp / "managed.toml", """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())


def installed_with_markers(tmp: Path) -> Path:
    """Create an installed config with private markers."""
    return write_file(tmp / "installed.toml", """# User's custom model selection
model = "claude-4-sonnet"

# User personality
personality = "user-personality-value-private"

profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "auto"
sandbox_mode = "none"

[user.custom_section]
api_key = "my-user-secret-token-999"
enabled = true

[[user.custom_array]]
name = "my-custom-api-key-888"

# User MCP configs
[mcp.servers]
custom_server = { url = "https://private.example.com", token = "private-mcp-token-codex-777" }

[user.dates]
last_updated = "2026-01-15"
""")


# ── Tests ──


def test_private_markers_not_on_stdout_or_stderr() -> None:
    """--merge --output must not leak private markers to stdout/stderr."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_toml(tmp)
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
        managed = managed_toml(tmp)
        out = tmp / "merged.json"
        run_script(str(installed), str(managed), "--merge", "--output", str(out))

        merged = json.loads(out.read_text(encoding="utf-8"))
        # User model selection preserved
        assert merged["model"] == "claude-4-sonnet"
        # User personality preserved
        assert merged["personality"] == "user-personality-value-private"
        # Unknown table preserved
        assert merged["user"]["custom_section"]["api_key"] == "my-user-secret-token-999"
        # Array preserved
        assert merged["user"]["custom_array"][0]["name"] == "my-custom-api-key-888"
        # MCP preserved
        assert merged["mcp"]["servers"]["custom_server"]["token"] == "private-mcp-token-codex-777"


def test_managed_fields_updated_in_output() -> None:
    """Managed profile fields must be updated in output."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", """
profile = "custom"

[profiles.safe]
approval_policy = "manual"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "manual"
sandbox_mode = "none"

[user.data]
value = "preserved"
""".lstrip())
        managed = write_file(tmp / "managed.toml", """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "auto"
sandbox_mode = "write"
""".lstrip())
        out = tmp / "merged.json"
        run_script(str(installed), str(managed), "--merge", "--output", str(out))

        merged = json.loads(out.read_text(encoding="utf-8"))
        assert merged["profile"] == "safe"
        assert merged["profiles"]["safe"]["approval_policy"] == "auto"
        assert merged["profiles"]["workspace-write"]["sandbox_mode"] == "write"
        # User data preserved
        assert merged["user"]["data"]["value"] == "preserved"


def test_comments_preserved_in_apply() -> None:
    """Apply must preserve comments via line-based patching."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", """# User's custom model selection
model = "claude-4-sonnet"

# This comment block must be preserved
profile = "custom"

[profiles.safe]
# safe section comment preserved
approval_policy = "manual"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "auto"
sandbox_mode = "none"
""")
        managed = write_file(tmp / "managed.toml", """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "auto"
sandbox_mode = "write"
""".lstrip())
        backup = tmp / "backups"
        result = run_script(
            str(installed), str(managed), "--apply", "--backup-dir", str(backup)
        )
        assert result.returncode == 0, f"apply failed: {result.stderr}"

        content = installed.read_text(encoding="utf-8")
        # Comments outside managed fields preserved
        assert "# User's custom model selection" in content
        assert "# This comment block must be preserved" in content
        assert "# safe section comment preserved" in content
        # Managed fields updated
        assert 'profile = "safe"' in content
        assert 'approval_policy = "auto"' in content
        assert 'sandbox_mode = "write"' in content


def test_missing_output_is_rejected() -> None:
    """--merge without --output must fail before producing merged content."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_toml(tmp)
        result = run_script(str(installed), str(managed), "--merge")
        assert result.returncode != 0, "--merge without --output must fail"
        assert "--merge requires --output" in (result.stderr + result.stdout)


def test_output_without_merge_is_rejected() -> None:
    """--output without --merge must fail."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_toml(tmp)
        out = tmp / "merged.json"
        result = run_script(str(installed), str(managed), "--output", str(out))
        assert result.returncode != 0, "--output without --merge must fail"
        assert "--output requires --merge" in (result.stderr + result.stdout)


def test_managed_match_exit_code_based() -> None:
    """--managed-match must exit 0 on match, 1 on mismatch."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())
        managed = write_file(tmp / "managed.toml", """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())

        result = run_script(str(installed), str(managed), "--managed-match")
        assert result.returncode == 0, "should exit 0 when matching"

        managed2 = write_file(tmp / "managed2.toml", """
profile = "unsafe"

[profiles.safe]
approval_policy = "manual"
""".lstrip())
        result2 = run_script(str(installed), str(managed2), "--managed-match")
        assert result2.returncode == 1, "should exit 1 when mismatching"


def test_managed_match_missing_target_exits_1() -> None:
    """--managed-match with missing target exits 1."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        missing = tmp / "nonexistent.toml"
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        result = run_script(str(missing), str(managed), "--managed-match")
        assert result.returncode == 1


def test_ambiguous_toml_refused() -> None:
    """Apply must refuse ambiguous TOML structure."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        # Unparseable TOML
        installed = write_file(tmp / "installed.toml", "<<<NOT TOML>>>")
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        backup = tmp / "backups"
        result = run_script(
            str(installed), str(managed), "--apply", "--backup-dir", str(backup)
        )
        assert result.returncode != 0, "ambiguous TOML must be refused"


def test_no_stdout_leak_on_apply() -> None:
    """--apply must not write full config to stdout."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = managed_toml(tmp)
        backup = tmp / "backups"
        result = run_script(
            str(installed), str(managed), "--apply", "--backup-dir", str(backup)
        )
        for marker in PRIVATE_MARKERS:
            assert marker not in result.stdout, f"Marker in stdout: {marker}"
            assert marker not in result.stderr, f"Marker in stderr: {marker}"


def test_rollback_managed_preserves_comments_and_user_content() -> None:
    """--rollback-managed restores managed fields while preserving formatting."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(
            tmp / "backup.toml",
            """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip(),
        )
        installed = write_file(
            tmp / "installed.toml",
            """# User model
model = "claude-4-sonnet"

# keep this blank line

profile = "custom"

[profiles.safe]
# inline comment
approval_policy = "manual"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "manual"
sandbox_mode = "write"

[mcp.servers]
custom = { token = "private-mcp-token-codex-777" }
""",
        )
        result = run_script(str(installed), str(backup), "--rollback-managed")
        assert result.returncode == 0, f"rollback failed: {result.stderr}"
        check_no_markers(result.stdout, "stdout")
        check_no_markers(result.stderr, "stderr")

        content = installed.read_text(encoding="utf-8")
        assert "# User model" in content
        assert "# keep this blank line" in content
        assert "# inline comment" in content
        assert 'model = "claude-4-sonnet"' in content
        assert "private-mcp-token-codex-777" in content
        assert 'profile = "safe"' in content
        assert 'approval_policy = "auto"' in content


def test_rollback_managed_malformed_current_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(tmp / "backup.toml", 'profile = "safe"\n')
        installed = write_file(tmp / "installed.toml", "<<<NOT TOML>>>")
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(backup), "--rollback-managed")
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_rollback_managed_malformed_backup_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(tmp / "backup.toml", "<<<NOT TOML>>>")
        installed = write_file(tmp / "installed.toml", 'profile = "safe"\n')
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(backup), "--rollback-managed")
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_top_level_managed_inline_comment_preserved_on_apply() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'profile = "custom"  # keep this comment\n',
        )
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        assert installed.read_text(encoding="utf-8") == 'profile = "safe"  # keep this comment\n'


def test_profile_field_inline_comment_preserved_on_apply() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            """
[profiles.safe]
  approval_policy = "manual"  # user note
  sandbox_mode = "none"
""".lstrip(),
        )
        managed = write_file(
            tmp / "managed.toml",
            """
profile = "safe"

[profiles.safe]
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip(),
        )
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'approval_policy = "auto"  # user note' in content


def test_hash_inside_quoted_string_not_treated_as_comment() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'profile = "safe#not-a-comment"  # real trailing comment\n',
        )
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'profile = "safe"  # real trailing comment' in content
        assert "safe#not-a-comment" not in content


def test_escaped_quote_before_hash_preserved() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'profile = "safe\\"#still-value"  # real comment\n',
        )
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'profile = "safe"  # real comment' in content


def test_ambiguous_multiline_scalar_refused_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'profile = """\nopen multiline\n',
        )
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        backup = tmp / "backups"
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_malformed_quoted_value_refused_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", 'profile = "unterminated\n')
        managed = write_file(tmp / "managed.toml", 'profile = "safe"\n')
        backup = tmp / "backups"
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_rollback_preserves_same_line_inline_comment() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(tmp / "backup.toml", 'profile = "safe"\n')
        installed = write_file(
            tmp / "installed.toml",
            'profile = "custom"  # keep this comment\n',
        )
        result = run_script(str(installed), str(backup), "--rollback-managed")
        assert result.returncode == 0, result.stderr
        assert installed.read_text(encoding="utf-8") == 'profile = "safe"  # keep this comment\n'


def test_apply_preserves_user_owned_content() -> None:
    """Apply must preserve user model, personality, MCP, dates, arrays, unknown tables."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = installed_with_markers(tmp)
        managed = write_file(tmp / "managed.toml", """
profile = "safe"

[profiles.safe]
approval_policy = "manual"
sandbox_mode = "none"

[profiles.workspace-write]
approval_policy = "manual"
sandbox_mode = "none"
""".lstrip())
        backup = tmp / "backups"
        result = run_script(
            str(installed), str(managed), "--apply", "--backup-dir", str(backup)
        )
        assert result.returncode == 0, f"apply failed: {result.stderr}"

        content = installed.read_text(encoding="utf-8")
        assert "my-user-secret-token-999" in content
        assert "user-personality-value-private" in content
        assert "my-custom-api-key-888" in content
        assert "private-mcp-token-codex-777" in content
        assert 'last_updated = "2026-01-15"' in content


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
