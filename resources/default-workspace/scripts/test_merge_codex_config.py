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
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())


def installed_with_markers(tmp: Path) -> Path:
    """Create an installed config with private markers."""
    return write_file(tmp / "installed.toml", """# User's custom model selection
model = "claude-4-sonnet"
approval_policy = "manual"
sandbox_mode = "danger-full-access"

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
    """Managed top-level fields must be updated in output."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", """
profile = "custom"
approval_policy = "manual"
sandbox_mode = "none"

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
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())
        out = tmp / "merged.json"
        run_script(str(installed), str(managed), "--merge", "--output", str(out))

        merged = json.loads(out.read_text(encoding="utf-8"))
        assert merged["approval_policy"] == "auto"
        assert merged["sandbox_mode"] == "none"
        assert "profile" in merged  # user-custom legacy selector value is not app-owned
        assert "profiles" not in merged
        # User data preserved
        assert merged["user"]["data"]["value"] == "preserved"


def test_comments_preserved_in_apply() -> None:
    """Apply must preserve comments via line-based patching."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", """# User's custom model selection
model = "claude-4-sonnet"
approval_policy = "manual"
sandbox_mode = "none"

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
        assert "# safe section comment preserved" not in content
        assert "[profiles.safe]" not in content
        # Managed fields updated
        assert 'profile = "custom"' in content
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
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())
        managed = write_file(tmp / "managed.toml", """
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip())

        result = run_script(str(installed), str(managed), "--managed-match")
        assert result.returncode == 0, "should exit 0 when matching"

        managed2 = write_file(tmp / "managed2.toml", """
approval_policy = "manual"
sandbox_mode = "none"
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


def test_render_rollback_managed_preserves_comments_and_user_content() -> None:
    """Render rollback restores managed fields without mutating the installed file."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(
            tmp / "backup.toml",
            """
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip(),
        )
        installed = write_file(
            tmp / "installed.toml",
            """# User model
model = "claude-4-sonnet"
approval_policy = "manual"
sandbox_mode = "workspace-write"

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
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(backup), "--render-rollback-managed")
        assert result.returncode == 0, f"rollback failed: {result.stderr}"
        check_no_markers(result.stderr, "stderr")

        assert installed.read_text(encoding="utf-8") == before
        content = result.stdout
        assert "# User model" in content
        assert "# keep this blank line" in content
        assert 'model = "claude-4-sonnet"' in content
        assert "private-mcp-token-codex-777" in content
        assert 'profile = "custom"' in content
        assert 'approval_policy = "auto"' in content


def test_render_rollback_managed_malformed_current_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(tmp / "backup.toml", 'profile = "safe"\n')
        installed = write_file(tmp / "installed.toml", "<<<NOT TOML>>>")
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(backup), "--render-rollback-managed")
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_render_rollback_managed_malformed_backup_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(tmp / "backup.toml", "<<<NOT TOML>>>")
        installed = write_file(tmp / "installed.toml", 'profile = "safe"\n')
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(backup), "--render-rollback-managed")
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_top_level_managed_inline_comment_preserved_on_apply() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'approval_policy = "manual"  # keep this comment\n',
        )
        managed = write_file(tmp / "managed.toml", 'approval_policy = "auto"\n')
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        assert installed.read_text(encoding="utf-8") == 'approval_policy = "auto"  # keep this comment\n'


def test_legacy_profile_table_removed_on_apply() -> None:
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
approval_policy = "auto"
sandbox_mode = "none"
""".lstrip(),
        )
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert "[profiles.safe]" not in content
        assert 'approval_policy = "auto"' in content


def test_hash_inside_quoted_string_not_treated_as_comment() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'approval_policy = "manual#not-a-comment"  # real trailing comment\n',
        )
        managed = write_file(tmp / "managed.toml", 'approval_policy = "auto"\n')
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'approval_policy = "auto"  # real trailing comment' in content
        assert "manual#not-a-comment" not in content


def test_escaped_quote_before_hash_preserved() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'approval_policy = "manual\\"#still-value"  # real comment\n',
        )
        managed = write_file(tmp / "managed.toml", 'approval_policy = "auto"\n')
        backup = tmp / "backups"
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'approval_policy = "auto"  # real comment' in content


def test_ambiguous_multiline_scalar_refused_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(
            tmp / "installed.toml",
            'profile = """\nopen multiline\n',
        )
        managed = write_file(tmp / "managed.toml", 'approval_policy = "auto"\n')
        backup = tmp / "backups"
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_malformed_quoted_value_refused_zero_mutation() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        installed = write_file(tmp / "installed.toml", 'profile = "unterminated\n')
        managed = write_file(tmp / "managed.toml", 'approval_policy = "auto"\n')
        backup = tmp / "backups"
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(managed), "--apply", "--backup-dir", str(backup))
        assert result.returncode != 0
        assert installed.read_text(encoding="utf-8") == before


def test_render_rollback_preserves_same_line_inline_comment() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        backup = write_file(tmp / "backup.toml", 'approval_policy = "auto"\n')
        installed = write_file(
            tmp / "installed.toml",
            'approval_policy = "manual"  # keep this comment\n',
        )
        before = installed.read_text(encoding="utf-8")
        result = run_script(str(installed), str(backup), "--render-rollback-managed")
        assert result.returncode == 0, result.stderr
        assert installed.read_text(encoding="utf-8") == before
        assert result.stdout == 'approval_policy = "auto"  # keep this comment\n'


# ── Fallback parser tests (tomllib-compat subset) ──

# Import the fallback parser from the main module
import importlib.util
sys.dont_write_bytecode = True
_mod_spec = importlib.util.spec_from_file_location("_merge_codex_module", str(SCRIPT))
_merge_mod = importlib.util.module_from_spec(_mod_spec)
_mod_spec.loader.exec_module(_merge_mod)
parse_minimal_toml = _merge_mod.parse_minimal_toml


def test_fallback_parser_basic_scalars() -> None:
    result = parse_minimal_toml('model = "gpt-5.5"\n')
    assert result["model"] == "gpt-5.5"


def test_fallback_parser_all_scalars() -> None:
    text = """
model = "gpt-5.5"
model_reasoning_effort = "high"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
""".strip()
    result = parse_minimal_toml(text)
    assert result["model"] == "gpt-5.5"
    assert result["model_reasoning_effort"] == "high"
    assert result["approval_policy"] == "on-request"
    assert result["approvals_reviewer"] == "user"
    assert result["sandbox_mode"] == "workspace-write"


def test_fallback_parser_dotted_keys() -> None:
    text = """
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
""".strip()
    result = parse_minimal_toml(text)
    assert result["apps"]["_default"]["approvals_reviewer"] == "user"
    assert result["apps"]["_default"]["default_tools_approval_mode"] == "prompt"


def test_fallback_parser_simple_tables() -> None:
    text = """
[mcp_servers]
[profiles.safe]
[apps._default]
""".strip()
    result = parse_minimal_toml(text)
    assert isinstance(result["mcp_servers"], dict)
    assert isinstance(result["profiles"]["safe"], dict)
    assert isinstance(result["apps"]["_default"], dict)


def test_fallback_parser_inline_comment_after_string() -> None:
    text = 'model = "gpt-5.5" # fast model\n'
    result = parse_minimal_toml(text)
    assert result["model"] == "gpt-5.5"


def test_fallback_parser_hash_inside_quoted_string() -> None:
    code_value = "safe#not-a-comment"
    text = f'profile = "{code_value}"\n'
    result = parse_minimal_toml(text)
    assert result["profile"] == code_value


def test_fallback_parser_boolean() -> None:
    text = "enabled = true\ndisabled = false\n"
    result = parse_minimal_toml(text)
    assert result["enabled"] is True
    assert result["disabled"] is False


def test_fallback_parser_integer() -> None:
    text = "timeout = 42\n"
    result = parse_minimal_toml(text)
    assert result["timeout"] == 42


def test_fallback_parser_float() -> None:
    text = "temperature = 0.7\n"
    result = parse_minimal_toml(text)
    assert isinstance(result["temperature"], float)


def test_fallback_parser_empty_array() -> None:
    text = "items = []\n"
    result = parse_minimal_toml(text)
    assert result["items"] == []


def test_fallback_parser_skip_comments() -> None:
    text = """
# This is a comment
model = "gpt-5.5"
# Another comment
""".strip()
    result = parse_minimal_toml(text)
    assert result["model"] == "gpt-5.5"
    assert "model" in result


def test_fallback_parser_mixed_content_with_unknown_tables() -> None:
    text = """
model = "gpt-5.5"
approvals_reviewer = "user"

[env]
PATH = "/usr/bin"

[mcp_servers.custom]
url = "https://example.com"
""".strip()
    result = parse_minimal_toml(text)
    assert result["model"] == "gpt-5.5"
    assert result["approvals_reviewer"] == "user"
    assert result["env"]["PATH"] == "/usr/bin"
    assert result["mcp_servers"]["custom"]["url"] == "https://example.com"


def test_fallback_parser_dotted_in_table() -> None:
    text = """
[apps]
_default.approvals_reviewer = "user"
""".strip()
    result = parse_minimal_toml(text)
    assert result["apps"]["_default"]["approvals_reviewer"] == "user"


def test_fallback_parser_table_with_comment_line_after() -> None:
    text = """
[mcp_servers]
# this is a comment after the table header
enabled = true
""".strip()
    result = parse_minimal_toml(text)
    assert result["mcp_servers"]["enabled"] is True


def test_fallback_parser_inline_table() -> None:
    text = 'custom_server = { url = "https://example.com", token = "t#1", nested = { a = 1 } } # c\n'
    result = parse_minimal_toml(text)
    assert result["custom_server"] == {
        "url": "https://example.com",
        "token": "t#1",
        "nested": {"a": 1},
    }


def test_fallback_parser_inline_table_inside_table() -> None:
    text = """
[mcp.servers]
custom_server = { url = "https://example.com", enabled = true }
""".strip()
    result = parse_minimal_toml(text)
    assert result["mcp"]["servers"]["custom_server"] == {
        "url": "https://example.com",
        "enabled": True,
    }


def test_fallback_parser_array_values() -> None:
    text = 'args = ["-y", "pkg, with comma", 3]\nmixed = [{ a = 1 }, [true]]\nempty = {}\n'
    result = parse_minimal_toml(text)
    assert result["args"] == ["-y", "pkg, with comma", 3]
    assert result["mixed"] == [{"a": 1}, [True]]
    assert result["empty"] == {}


LITERAL_STRINGS = """approval_policy = 'on-request'
profile = 'safe#not-a-comment' # a comment
args = ['a, b', "c"]
multi = '''raw \\n text'''
[apps._default]
approvals_reviewer = 'user'
"""


def _load_routing_module():
    spec = importlib.util.spec_from_file_location(
        "_routing_module", str(Path(__file__).resolve().parent / "ensure-codex-routing-defaults.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fallback_parsers_read_single_quoted_literal_strings() -> None:
    for parse in (parse_minimal_toml, _load_routing_module().parse_minimal_toml):
        result = parse(LITERAL_STRINGS)
        assert result["approval_policy"] == "on-request", result
        assert result["profile"] == "safe#not-a-comment", result
        assert result["args"] == ["a, b", "c"], result
        assert result["multi"] == "raw \\n text", result
        assert result["apps"]["_default"]["approvals_reviewer"] == "user", result


def test_line_patchers_keep_a_hash_inside_a_literal_string() -> None:
    line = "profile = 'safe#x' # note"
    assert _merge_mod.split_managed_scalar_assignment(line, "profile") == ("profile = ", " # note")
    routing = _load_routing_module()
    assert routing.split_scalar_assignment(line, "profile") == ("profile = ", " # note")


# ── Routing defaults: model and reasoning effort are create-only ──

ROUTING_SCRIPT = Path(__file__).resolve().parent / "ensure-codex-routing-defaults.py"

ROUTING_TEMPLATE = """model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"""

ROUTING_ENFORCED_ONLY = """approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"""


def run_routing(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(ROUTING_SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def test_routing_user_model_and_effort_are_not_drift() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        managed = write_file(tmp / "managed.toml", ROUTING_TEMPLATE)
        installed = write_file(
            tmp / "installed.toml",
            'model = "gpt-5.4"\nmodel_reasoning_effort = "low"\n' + ROUTING_ENFORCED_ONLY,
        )
        assert run_routing(str(installed), str(managed), "--managed-match").returncode == 0
        diff = run_routing(str(installed), str(managed), "--diff")
        assert "synced" in diff.stdout, diff.stdout


def test_routing_enforced_value_differing_is_drift() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        managed = write_file(tmp / "managed.toml", ROUTING_TEMPLATE)
        installed = write_file(
            tmp / "installed.toml",
            'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n'
            + ROUTING_ENFORCED_ONLY.replace("on-request", "never"),
        )
        assert run_routing(str(installed), str(managed), "--managed-match").returncode == 1


def test_routing_absent_model_and_effort_are_drift_until_written() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        managed = write_file(tmp / "managed.toml", ROUTING_TEMPLATE)
        installed = write_file(tmp / "installed.toml", ROUTING_ENFORCED_ONLY)
        assert run_routing(str(installed), str(managed), "--managed-match").returncode == 1
        diff = run_routing(str(installed), str(managed), "--diff")
        assert '"model" would be set' in diff.stdout, diff.stdout
        assert '"model_reasoning_effort" would be set' in diff.stdout, diff.stdout


def test_routing_apply_writes_absent_model_and_effort_only() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        managed = write_file(tmp / "managed.toml", ROUTING_TEMPLATE)
        installed = write_file(
            tmp / "installed.toml",
            "# user comment\n" + ROUTING_ENFORCED_ONLY + '\n[mcp_servers.custom]\ncommand = "echo"\n',
        )
        result = run_routing(
            str(installed), str(managed), "--apply", "--backup-dir", str(tmp / "backup")
        )
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'model = "gpt-6.1-sol"' in content
        assert 'model_reasoning_effort = "xhigh"' in content
        assert "# user comment" in content
        assert "[mcp_servers.custom]" in content
        assert run_routing(str(installed), str(managed), "--managed-match").returncode == 0


def test_routing_apply_preserves_user_model_and_updates_enforced_values() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        managed = write_file(tmp / "managed.toml", ROUTING_TEMPLATE)
        installed = write_file(
            tmp / "installed.toml",
            'model = "gpt-5.4" # my pick\nmodel_reasoning_effort = "low"\n'
            + ROUTING_ENFORCED_ONLY.replace("on-request", "never"),
        )
        result = run_routing(
            str(installed), str(managed), "--apply", "--backup-dir", str(tmp / "backup")
        )
        assert result.returncode == 0, result.stderr
        content = installed.read_text(encoding="utf-8")
        assert 'model = "gpt-5.4" # my pick' in content
        assert 'model_reasoning_effort = "low"' in content
        assert 'approval_policy = "on-request"' in content
        assert "gpt-6.1-sol" not in content
        assert "xhigh" not in content


def test_routing_apply_seeds_model_and_effort_in_new_config() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        managed = write_file(tmp / "managed.toml", ROUTING_TEMPLATE)
        target = tmp / "new" / "config.toml"
        result = run_routing(str(target), str(managed), "--apply")
        assert result.returncode == 0, result.stderr
        content = target.read_text(encoding="utf-8")
        assert 'model = "gpt-6.1-sol"' in content
        assert 'model_reasoning_effort = "xhigh"' in content


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
