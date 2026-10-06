#!/usr/bin/env python3
"""Generate harness-native agent adapters from shared agent-specs.

Usage:
  python3 scripts/generate-agent-adapters.py --check
  python3 scripts/generate-agent-adapters.py --write
"""

from __future__ import annotations

import argparse
import json
import sys
import tomllib
from pathlib import Path

from opencode_policy_compose import compose_opencode_header
from validate_opencode_permissions import validate as validate_opencode_permissions

REPO_ROOT = Path(__file__).resolve().parent.parent
WS_ROOT = REPO_ROOT / "resources" / "default-workspace"
SPECS_DIR = WS_ROOT / "agent-specs"
MANIFEST_PATH = WS_ROOT / "metadata" / "agent-adapters.json"

ROLES = {
    "architect": {"spec": "architect.body.md", "harnesses": {"opencode": {"output": "agents/architect.md", "role": "templates/opencode/agents/architect.role.json"}}},
    "repo-scout": {"spec": "repo-scout.body.md", "harnesses": {
        "opencode": {"output": "agents/repo-scout.md", "role": "templates/opencode/agents/repo-scout.role.json"},
        "claude": {"output": "templates/claude/agents/repo-scout.md", "header": "templates/claude/agents/repo-scout.header.yaml"},
        "codex": {"output": "templates/codex/agents/repo_scout.toml", "meta": "templates/codex/agents/repo_scout.meta.json"},
        "cursor": {"output": "templates/cursor/agents/repo-scout.md", "header": "templates/cursor/agents/repo-scout.header.yaml"},
    }},
    "inspector": {"spec": "inspector.body.md", "harnesses": {
        "opencode": {"output": "agents/inspector.md", "role": "templates/opencode/agents/inspector.role.json"},
        "claude": {"output": "templates/claude/agents/inspector.md", "header": "templates/claude/agents/inspector.header.yaml", "line_replacements": {"Review only.": "Review only. Do not edit files or expose sensitive configuration or authentication material."}},
        "codex": {"output": "templates/codex/agents/inspector.toml", "meta": "templates/codex/agents/inspector.meta.json"},
        "cursor": {"output": "templates/cursor/agents/inspector.md", "header": "templates/cursor/agents/inspector.header.yaml"},
    }},
    "sentinel": {"spec": "sentinel.body.md", "harnesses": {
        "opencode": {"output": "agents/sentinel.md", "role": "templates/opencode/agents/sentinel.role.json"},
        "claude": {"output": "templates/claude/agents/sentinel.md", "header": "templates/claude/agents/sentinel.header.yaml", "line_replacements": {"- Any path that could": "- Any path that could expose sensitive configuration or authentication material."}},
        "codex": {"output": "templates/codex/agents/security_reviewer.toml", "meta": "templates/codex/agents/security_reviewer.meta.json"},
    }},
    "scribe": {"spec": "scribe.body.md", "harnesses": {
        "opencode": {"output": "agents/scribe.md", "role": "templates/opencode/agents/scribe.role.json"},
        "claude": {"output": "templates/claude/agents/scribe.md", "header": "templates/claude/agents/scribe.header.yaml"},
    }},
    "verifier": {"spec": "verifier.body.md", "harnesses": {
        "opencode": {"output": "agents/verifier.md", "role": "templates/opencode/agents/verifier.role.json"},
        "claude": {"output": "templates/claude/agents/verifier.md", "header": "templates/claude/agents/verifier.header.yaml", "line_replacements": {"- Inspect or print": "- Expose sensitive configuration or authentication material."}},
        "codex": {"output": "templates/codex/agents/verifier.toml", "meta": "templates/codex/agents/verifier.meta.json"},
        "cursor": {"output": "templates/cursor/agents/verifier.md", "header": "templates/cursor/agents/verifier.header.yaml"},
    }},
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_body(spec_name: str) -> str:
    path = SPECS_DIR / spec_name
    if not path.is_file():
        fail(f"missing agent spec: {path}")
    text = path.read_text(encoding="utf-8")
    return text if text.endswith("\n") else text + "\n"


def load_role(role_rel: str) -> Path:
    path = WS_ROOT / role_rel
    if not path.is_file():
        fail(f"missing adapter role: {path}")
    return path


def compose_opencode_markdown(role_rel: str, body: str) -> str:
    header = compose_opencode_header(load_role(role_rel))
    return f"---\n{header}---\n\n{body}"


def adapt_body(body: str, replacements: dict[str, str] | None) -> str:
    if not replacements:
        return body
    lines = body.splitlines()
    for prefix, replacement in replacements.items():
        matches = [index for index, line in enumerate(lines) if line.startswith(prefix)]
        if len(matches) != 1:
            fail(f"body replacement prefix {prefix!r} matched {len(matches)} lines")
        lines[matches[0]] = replacement
    return "\n".join(lines) + "\n"


def load_header(header_rel: str) -> str:
    path = WS_ROOT / header_rel
    if not path.is_file():
        fail(f"missing adapter header: {path}")
    return path.read_text(encoding="utf-8").strip("\n") + "\n"


def compose_markdown(header_rel: str, body: str) -> str:
    return f"---\n{load_header(header_rel)}---\n\n{body}"


# ── Frontmatter validation for generated Markdown adapters ──

CLAUDE_READONLY_TOOLS = frozenset(["Read", "Grep", "Glob"])
CLAUDE_READONLY_ROLES = frozenset(["repo-scout", "inspector", "sentinel"])
CLAUDE_AGENT_MODELS = frozenset(["haiku", "sonnet"])
CLAUDE_PERMISSION_MODES = frozenset(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"])


def _parse_frontmatter_fields(text: str) -> dict[str, str]:
    """Parse simple YAML-like frontmatter between --- markers.

    Handles only the subset used by agent adapter headers:
        key: value
    Multiline values, lists, and nested structures are not supported.
    Returns a dict of key->value (stripped). Keys are case-sensitive.
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}
    end = 1
    while end < len(lines) and lines[end].strip() != "---":
        end += 1
    if end >= len(lines):
        return {}
    fields: dict[str, str] = {}
    for line in lines[1:end]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        fields[key.strip()] = value.strip()
    return fields


def _frontmatter_tools(fields: dict[str, str]) -> set[str]:
    raw = fields.get("tools", "")
    return {t.strip() for t in raw.split(",") if t.strip()}


def _frontmatter_disallowed(fields: dict[str, str]) -> set[str]:
    raw = fields.get("disallowedTools", "")
    return {t.strip() for t in raw.split(",") if t.strip()}


def _validate_markdown_frontmatter(
    path: Path, content: str, role_name: str, harness: str,
) -> list[str]:
    """Validate a generated Markdown adapter's frontmatter contract.

    Returns a list of error messages (empty = valid).
    """
    errors: list[str] = []
    rel = path.relative_to(REPO_ROOT)

    # Must have --- delimiters
    if not content.startswith("---\n"):
        errors.append(f"{rel}: missing opening frontmatter delimiter")
        return errors

    fields = _parse_frontmatter_fields(content)

    # Required fields
    for required in ("name", "description"):
        if required not in fields:
            errors.append(f"{rel}: missing required frontmatter field '{required}'")

    # Header values are written as plain YAML scalars; ': ' or ' #' would corrupt them.
    for key in ("name", "description"):
        value = fields.get(key, "")
        if ": " in value or " #" in value or value.endswith(":"):
            errors.append(f"{rel}: frontmatter '{key}' contains ': ' or ' #' and is not a valid plain YAML scalar")

    # Claude-specific checks
    if harness == "claude":
        # No unsupported 'readonly' field
        if "readonly" in fields:
            errors.append(f"{rel}: Claude adapter must not contain unsupported 'readonly' frontmatter")

        # Every Claude agent declares an explicit tool list; a missing list means all tools.
        tools = _frontmatter_tools(fields)
        disallowed = _frontmatter_disallowed(fields)
        if not tools:
            errors.append(f"{rel}: Claude agent '{role_name}' must declare an explicit non-empty 'tools:' list")

        # Subagents pin a cost-appropriate model (keeps judgment in the main thread).
        model = fields.get("model", "")
        if model not in CLAUDE_AGENT_MODELS:
            errors.append(
                f"{rel}: Claude agent '{role_name}' must pin model to one of "
                f"{', '.join(sorted(CLAUDE_AGENT_MODELS))}, found {model or 'none'!r}"
            )

        # permissionMode, when present, must be a known value and never bypass permissions.
        permission_mode = fields.get("permissionMode")
        if permission_mode is not None:
            if permission_mode not in CLAUDE_PERMISSION_MODES:
                errors.append(
                    f"{rel}: invalid permissionMode {permission_mode!r}; "
                    f"expected one of {', '.join(sorted(CLAUDE_PERMISSION_MODES))}"
                )
            elif permission_mode == "bypassPermissions":
                errors.append(f"{rel}: permissionMode must not be bypassPermissions")

        # Read-only roles: Read/Grep/Glob only, plan mode, no shell. Reviewers receive the diff in the prompt.
        if role_name in CLAUDE_READONLY_ROLES:
            unexpected = tools - CLAUDE_READONLY_TOOLS
            if unexpected:
                errors.append(
                    f"{rel}: role '{role_name}' must only use read-only tools "
                    f"({', '.join(sorted(CLAUDE_READONLY_TOOLS))}), "
                    f"but has: {', '.join(sorted(unexpected))}"
                )
            if permission_mode != "plan":
                errors.append(f"{rel}: read-only role '{role_name}' must set permissionMode: plan")

        # Verifier may use Bash for checks but must not be able to write or edit.
        if role_name == "verifier":
            for tool in ("Write", "Edit"):
                if tool in tools:
                    errors.append(f"{rel}: verifier must not list {tool} in tools")
                if tool not in disallowed:
                    errors.append(f"{rel}: verifier must list {tool} in disallowedTools")

    return errors


# ── Preflight checks ──

def preflight_check() -> list[str]:
    """Run bounded preflight checks before generation or validation.

    Returns list of error messages. Empty list = all checks pass.
    """
    errors: list[str] = []

    # 1. Check all referenced spec files exist
    for role_name, role in ROLES.items():
        spec_path = SPECS_DIR / role["spec"]
        if not spec_path.is_file():
            errors.append(f"missing agent spec: {spec_path}")
        for harness_name, harness in role["harnesses"].items():
            if "header" in harness:
                header_path = WS_ROOT / harness["header"]
                if not header_path.is_file():
                    errors.append(f"missing adapter header: {header_path}")
            if "role" in harness:
                role_path = WS_ROOT / harness["role"]
                if not role_path.is_file():
                    errors.append(f"missing adapter role: {role_path}")
            if "meta" in harness:
                meta_path = WS_ROOT / harness["meta"]
                if not meta_path.is_file():
                    errors.append(f"missing codex adapter meta: {meta_path}")

    # 2. Check for duplicate output paths
    seen_outputs: dict[str, str] = {}
    for role_name, role in ROLES.items():
        for harness_name, harness in role["harnesses"].items():
            rel = harness["output"]
            prev = seen_outputs.get(rel)
            if prev is not None:
                errors.append(
                    f"duplicate output path '{rel}' for role '{role_name}' "
                    f"(harness '{harness_name}') — already claimed by '{prev}'"
                )
            seen_outputs[rel] = f"{role_name} ({harness_name})"

    return errors


def validate_generated_content(outputs: dict[Path, str]) -> list[str]:
    """Validate all generated content after generation.

    Returns list of error messages. Empty list = all validations pass.
    """
    errors: list[str] = []

    for path, content in sorted(outputs.items()):
        rel = path.relative_to(REPO_ROOT)

        # TOML validation (already parsed in main, but validate content here)
        if path.suffix == ".toml":
            try:
                tomllib.loads(content)
            except tomllib.TOMLDecodeError as exc:
                errors.append(f"{rel}: invalid TOML: {exc}")

        # Markdown frontmatter validation
        if path.suffix == ".md":
            # Determine role and harness from the path
            role_name = "unknown"
            harness_name = "unknown"
            for rn, role in ROLES.items():
                for hn, harness in role["harnesses"].items():
                    if harness["output"] == path.relative_to(WS_ROOT).as_posix():
                        role_name = rn
                        harness_name = hn
                        break
            try:
                fm_errors = _validate_markdown_frontmatter(path, content, role_name, harness_name)
                errors.extend(fm_errors)
            except Exception as exc:
                errors.append(f"{rel}: frontmatter validation error: {exc}")

    # 3. Manifest contract check
    expected_manifest = json.dumps({"version": 1, "roles": manifest_roles()}, indent=2) + "\n"
    if MANIFEST_PATH.is_file():
        current_manifest = MANIFEST_PATH.read_text(encoding="utf-8")
        if current_manifest != expected_manifest:
            errors.append(
                f"manifest {MANIFEST_PATH.relative_to(REPO_ROOT)} differs from generator contract; "
                "run --write to update"
            )

    return errors


def compose_codex_toml(meta_rel: str, body: str) -> str:
    meta_path = WS_ROOT / meta_rel
    if not meta_path.is_file():
        fail(f"missing codex adapter meta: {meta_path}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    for key in ("name", "description"):
        if key not in meta:
            fail(f"{meta_path}: missing required field {key}")
    lines = [
        f'name = {json.dumps(meta["name"])}',
        "description = \"\"\"",
        str(meta["description"]).strip(),
        "\"\"\"",
        "developer_instructions = \"\"\"",
        body.strip(),
        "\"\"\"",
    ]
    if meta.get("sandbox_mode"):
        lines.append(f'sandbox_mode = {json.dumps(meta["sandbox_mode"])}')
    return "\n".join(lines) + "\n"


def generated_outputs() -> dict[Path, str]:
    outputs: dict[Path, str] = {}
    for role in ROLES.values():
        body = load_body(role["spec"])
        for harness_name, harness in role["harnesses"].items():
            out = WS_ROOT / harness["output"]
            adapted = adapt_body(body, harness.get("line_replacements"))
            if harness_name == "codex":
                content = compose_codex_toml(harness["meta"], adapted)
            elif harness_name == "opencode" and "role" in harness:
                content = compose_opencode_markdown(harness["role"], adapted)
            else:
                content = compose_markdown(harness["header"], adapted)
            outputs[out] = content
    return outputs


def manifest_roles() -> dict[str, object]:
    public_roles = json.loads(json.dumps(ROLES))
    for role in public_roles.values():
        for harness in role["harnesses"].values():
            harness.pop("line_replacements", None)
    return public_roles


def write_manifest() -> None:
    MANIFEST_PATH.write_text(json.dumps({"version": 1, "roles": manifest_roles()}, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    args = parser.parse_args()

    # ── Preflight checks ──
    preflight_errors = preflight_check()
    if preflight_errors:
        print("FAIL: preflight checks failed:", file=sys.stderr)
        for err in preflight_errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    outputs = generated_outputs()

    stale: list[str] = []
    for path, expected in sorted(outputs.items()):
        rel = path.relative_to(REPO_ROOT)
        if not path.exists():
            stale.append(f"missing {rel}")
        elif path.read_text(encoding="utf-8") != expected:
            stale.append(f"stale {rel}")

    if args.write:
        write_manifest()
        for path, content in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        legacy_scout = WS_ROOT / "agents" / "scout.md"
        if legacy_scout.exists():
            legacy_scout.unlink()
        print(f"wrote {len(outputs)} harness adapter files")
        if stale:
            print("updated stale outputs:", ", ".join(stale))

    # ── Semantic OpenCode permission contract ──
    permission_errors = validate_opencode_permissions()
    if permission_errors:
        print("FAIL: OpenCode permission contract validation failed:", file=sys.stderr)
        for err in permission_errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    # ── Content validation (runs on both check and write) ──
    content_errors = validate_generated_content(outputs)
    if content_errors:
        print("FAIL: generated content validation failed:", file=sys.stderr)
        for err in content_errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    if args.write:
        return

    if stale:
        print("FAIL: generated agent adapters are stale:", file=sys.stderr)
        for item in stale:
            print(f"  - {item}", file=sys.stderr)
        print("Run: python3 scripts/generate-agent-adapters.py --write", file=sys.stderr)
        sys.exit(1)

    print(f"PASS: {len(outputs)} harness adapter files are current")


if __name__ == "__main__":
    main()
