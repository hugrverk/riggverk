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

REPO_ROOT = Path(__file__).resolve().parent.parent
WS_ROOT = REPO_ROOT / "resources" / "default-workspace"
SPECS_DIR = WS_ROOT / "agent-specs"
MANIFEST_PATH = WS_ROOT / "metadata" / "agent-adapters.json"

ROLES = {
    "architect": {"spec": "architect.body.md", "harnesses": {"opencode": {"output": "agents/architect.md", "header": "templates/opencode/agents/architect.header.yaml"}}},
    "repo-scout": {"spec": "repo-scout.body.md", "harnesses": {
        "opencode": {"output": "agents/repo-scout.md", "header": "templates/opencode/agents/repo-scout.header.yaml"},
        "claude": {"output": "templates/claude/agents/repo-scout.md", "header": "templates/claude/agents/repo-scout.header.yaml"},
        "codex": {"output": "templates/codex/agents/repo_scout.toml", "meta": "templates/codex/agents/repo_scout.meta.json"},
        "cursor": {"output": "templates/cursor/agents/repo-scout.md", "header": "templates/cursor/agents/repo-scout.header.yaml"},
    }},
    "inspector": {"spec": "inspector.body.md", "harnesses": {
        "opencode": {"output": "agents/inspector.md", "header": "templates/opencode/agents/inspector.header.yaml"},
        "claude": {"output": "templates/claude/agents/inspector.md", "header": "templates/claude/agents/inspector.header.yaml", "line_replacements": {"Review only.": "Review only. Do not edit files or expose sensitive configuration or authentication material."}},
        "codex": {"output": "templates/codex/agents/inspector.toml", "meta": "templates/codex/agents/inspector.meta.json"},
        "cursor": {"output": "templates/cursor/agents/inspector.md", "header": "templates/cursor/agents/inspector.header.yaml"},
    }},
    "sentinel": {"spec": "sentinel.body.md", "harnesses": {
        "opencode": {"output": "agents/sentinel.md", "header": "templates/opencode/agents/sentinel.header.yaml"},
        "claude": {"output": "templates/claude/agents/sentinel.md", "header": "templates/claude/agents/sentinel.header.yaml", "line_replacements": {"- Any path that could": "- Any path that could expose sensitive configuration or authentication material."}},
        "codex": {"output": "templates/codex/agents/security_reviewer.toml", "meta": "templates/codex/agents/security_reviewer.meta.json"},
    }},
    "scribe": {"spec": "scribe.body.md", "harnesses": {
        "opencode": {"output": "agents/scribe.md", "header": "templates/opencode/agents/scribe.header.yaml"},
        "claude": {"output": "templates/claude/agents/scribe.md", "header": "templates/claude/agents/scribe.header.yaml"},
    }},
    "verifier": {"spec": "verifier.body.md", "harnesses": {
        "opencode": {"output": "agents/verifier.md", "header": "templates/opencode/agents/verifier.header.yaml"},
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


def load_header(header_rel: str) -> str:
    path = WS_ROOT / header_rel
    if not path.is_file():
        fail(f"missing adapter header: {path}")
    return path.read_text(encoding="utf-8").strip("\n") + "\n"


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


def compose_markdown(header_rel: str, body: str) -> str:
    return f"---\n{load_header(header_rel)}---\n\n{body}"


# ── Frontmatter validation for generated Markdown adapters ──

CLAUDE_READONLY_TOOLS = frozenset(["Read", "Grep", "Glob"])


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

    # Claude-specific checks
    if harness == "claude":
        # No unsupported 'readonly' field
        if "readonly" in fields:
            errors.append(f"{rel}: Claude adapter must not contain unsupported 'readonly' frontmatter")

        # Tool boundary checks for specific roles
        if role_name in ("repo-scout", "inspector", "sentinel"):
            tools = _frontmatter_tools(fields)
            unexpected = tools - CLAUDE_READONLY_TOOLS
            if unexpected:
                errors.append(
                    f"{rel}: role '{role_name}' must only use read-only tools "
                    f"({', '.join(sorted(CLAUDE_READONLY_TOOLS))}), "
                    f"but has: {', '.join(sorted(unexpected))}"
                )

        if role_name == "verifier":
            tools = _frontmatter_tools(fields)
            disallowed = _frontmatter_disallowed(fields)
            can_write = "Write" in tools or "Edit" in tools
            write_disallowed = "Write" in disallowed or "Edit" in disallowed
            if can_write and write_disallowed:
                # Both in tools and disallowedTools is inconsistent
                pass
            if not can_write and not write_disallowed:
                # Neither in tools nor disallowedTools -> not explicitly prevented
                # But the role should have tool access for bash-based verification
                pass
            # Verifier may have Bash in tools, which is acceptable for running commands
            # The key requirement: verifier should not have unrestricted Write/Edit
            # Having them in disallowedTools is the correct safe state
            if "Write" in tools and "Write" not in disallowed:
                errors.append(
                    f"{rel}: verifier must not have direct Write access without disallowedTools guard"
                )
            if "Edit" in tools and "Edit" not in disallowed:
                errors.append(
                    f"{rel}: verifier must not have direct Edit access without disallowedTools guard"
                )

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
            outputs[out] = compose_codex_toml(harness["meta"], adapted) if harness_name == "codex" else compose_markdown(harness["header"], adapted)
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

    # ── Content validation (runs on both check and write) ──
    content_errors = validate_generated_content(outputs)
    if content_errors:
        print("FAIL: generated content validation failed:", file=sys.stderr)
        for err in content_errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

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
