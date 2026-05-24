#!/usr/bin/env python3
"""Validate the Cursor profile template without reading installed user data."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURSOR = ROOT / "templates" / "cursor"
MANIFEST = CURSOR / "manifest.json"
MCP_EXAMPLE = CURSOR / "mcp" / "mcp.example.json"
MCP_DIR = CURSOR / "mcp"
SANDBOX_DIR = CURSOR / "sandbox"
PERMISSIONS_DIR = CURSOR / "permissions"
GLOBAL_PROFILE = CURSOR / "global-profile.json"

ALLOWED_AGENT_KEYS = {"name", "description", "model", "readonly", "is_background"}
OPENCODE_ONLY_KEYS = {"permission", "mode", "temperature", "steps", "hidden"}
AUTH_KEYS = re.compile(r"(api[_-]?key|apikey|token|secret|password|authorization|cookie)", re.I)
SUSPICIOUS_VALUE = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-|Bearer\s+\S+|Basic\s+\S+|AKIA[0-9A-Z]{16})",
    re.I,
)
DOC_ONLY_KEYS = frozenset(
    {"description", "notes", "warnings", "excluded_capabilities", "validation_todo"}
)
ENV_PLACEHOLDER = re.compile(r"\$\{env:[A-Z0-9_]+\}")
PRIVATE_URL = re.compile(r"https?://[^/\s]*(localhost|127\.0\.0\.1|\.local|internal|private|corp)[^/\s]*", re.I)
COMMAND_ALLOWLIST_DENY = {"npx", "npm", "node", "playwright", "chrome", "chromium", "google-chrome"}
MCP_BROAD = re.compile(r"^[a-z0-9_-]+:\*$", re.I)
FAKE_USER_RULES_PATH = re.compile(
    r"(\.cursor/AGENTS\.md|\$HOME/\.cursor/AGENTS\.md|~/.cursor/AGENTS\.md|global\s+Cursor\s+User\s+Rules\s+file)",
    re.I,
)


def fail(message: str) -> None:
    print(f"FAIL {message}")
    raise SystemExit(1)


def warn(message: str) -> None:
    print(f"WARN {message}")


def ok(message: str) -> None:
    print(f"PASS {message}")


def load_json(path: Path) -> object:
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        fail(f"{path.relative_to(ROOT)} invalid JSON: {exc}")


def parse_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        fail(f"{path.relative_to(ROOT)} missing YAML frontmatter")
    end = text.find("\n---", 4)
    if end == -1:
        fail(f"{path.relative_to(ROOT)} unterminated YAML frontmatter")
    result: dict[str, str] = {}
    for raw in text[4:end].splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            fail(f"{path.relative_to(ROOT)} frontmatter line missing colon: {line}")
        key, value = line.split(":", 1)
        result[key.strip()] = value.strip()
    return result


def resolve_manifest_path(raw: str) -> Path:
    path = ROOT / raw
    if not path.exists():
        fail(f"manifest path missing: {raw}")
    return path


def validate_manifest() -> dict:
    data = load_json(MANIFEST)
    if not isinstance(data, dict):
        fail("manifest root must be an object")
    for key in [
        "schema_version",
        "profile",
        "global_profile",
        "user_rules",
        "agents_dir",
        "rules_dir",
        "mcp_examples_dir",
        "permissions_dir",
        "legacy_sandbox_profiles_dir",
        "recommended_pinned_skills",
        "agents",
        "rules",
        "mcp_examples",
        "permissions_templates",
        "legacy_sandbox_profiles",
        "notes",
    ]:
        if key not in data:
            fail(f"manifest missing key: {key}")
    for path_key in [
        "global_profile",
        "user_rules",
        "agents_dir",
        "rules_dir",
        "mcp_examples_dir",
        "permissions_dir",
        "legacy_sandbox_profiles_dir",
    ]:
        if not isinstance(data[path_key], str):
            fail(f"manifest {path_key} must be a string")
        resolve_manifest_path(data[path_key])
    ok("templates/cursor/manifest.json valid")
    return data


def validate_agents(manifest: dict) -> None:
    agents_dir = ROOT / manifest["agents_dir"]
    listed = manifest.get("agents", [])
    if not isinstance(listed, list) or not listed:
        fail("manifest agents must be a non-empty list")
    actual = sorted(p.name for p in agents_dir.glob("*.md"))
    if sorted(listed) != actual:
        fail(f"manifest agents do not match files: listed={sorted(listed)} actual={actual}")
    for name in listed:
        path = agents_dir / name
        fm = parse_frontmatter(path)
        unknown = set(fm) - ALLOWED_AGENT_KEYS
        opencode = set(fm) & OPENCODE_ONLY_KEYS
        if unknown:
            fail(f"{path.relative_to(ROOT)} has unsupported Cursor frontmatter keys: {sorted(unknown)}")
        if opencode:
            fail(f"{path.relative_to(ROOT)} has OpenCode-only frontmatter keys: {sorted(opencode)}")
        for required in ["name", "description", "model", "readonly"]:
            if required not in fm:
                fail(f"{path.relative_to(ROOT)} missing frontmatter key: {required}")
        if "secrets" not in path.read_text(encoding="utf-8").lower():
            fail(f"{path.relative_to(ROOT)} must explicitly mention not inspecting or printing secrets")
    ok("Cursor agents valid")


def validate_rules(manifest: dict) -> None:
    rules_dir = ROOT / manifest["rules_dir"]
    listed = manifest.get("rules", [])
    if not isinstance(listed, list) or not listed:
        fail("manifest rules must be a non-empty list")
    actual = sorted(p.name for p in rules_dir.iterdir() if p.is_file() and p.suffix in {".md", ".mdc"})
    if sorted(listed) != actual:
        fail(f"manifest rules do not match files: listed={sorted(listed)} actual={actual}")
    always = 0
    for name in listed:
        path = rules_dir / name
        if path.suffix not in {".md", ".mdc"}:
            fail(f"{path.relative_to(ROOT)} must be .md or .mdc")
        if path.suffix != ".mdc":
            warn(f"{path.relative_to(ROOT)} should prefer .mdc for frontmatter-controlled rules")
        fm = parse_frontmatter(path)
        if fm.get("alwaysApply") == "true":
            always += 1
    if always < 1:
        fail("at least one Cursor rule must be always-apply")
    if always == len(listed):
        fail("not all Cursor rules may be always-apply")
    ok("Cursor rules valid")


def walk_values(value: object, path: str = "") -> list[tuple[str, object]]:
    items = [(path, value)]
    if isinstance(value, dict):
        for key, child in value.items():
            if key in DOC_ONLY_KEYS:
                continue
            items.extend(walk_values(child, f"{path}.{key}" if path else str(key)))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            items.extend(walk_values(child, f"{path}[{i}]"))
    return items


def path_has_doc_only_segment(json_path: str) -> bool:
    if not json_path:
        return False
    parts = []
    for segment in json_path.split("."):
        if segment.endswith("]"):
            segment = segment[: segment.index("[")]
        parts.append(segment)
    return any(part in DOC_ONLY_KEYS for part in parts)


def validate_structured_credentials(data: object, rel_path: Path, *, label: str) -> None:
    for json_path, value in walk_values(data):
        if path_has_doc_only_segment(json_path):
            continue
        if not isinstance(value, str):
            continue
        if SUSPICIOUS_VALUE.search(value):
            fail(f"{rel_path} {label} has credential-like value at {json_path or '<root>'}")
        if PRIVATE_URL.search(value):
            fail(f"{rel_path} {label} has private URL at {json_path or '<root>'}")
        leaf = json_path.rsplit(".", 1)[-1] if json_path else ""
        if leaf and AUTH_KEYS.search(leaf) and not ENV_PLACEHOLDER.fullmatch(value):
            fail(f"{rel_path} {label} auth-like value must use ${{env:...}} at {json_path}")


def validate_mcp_file(path: Path) -> None:
    data = load_json(path)
    validate_structured_credentials(data, path.relative_to(ROOT), label="MCP example")


def validate_mcp(manifest: dict) -> None:
    listed = manifest.get("mcp_examples", [])
    actual = sorted(p.name for p in MCP_DIR.iterdir() if p.is_file())
    if sorted(listed) != actual:
        fail(f"manifest MCP examples do not match files: listed={sorted(listed)} actual={actual}")
    for name in listed:
        path = MCP_DIR / name
        if path.suffix == ".json":
            validate_mcp_file(path)
    ok("Cursor MCP example valid")


def validate_permissions_templates(manifest: dict) -> None:
    listed = manifest.get("permissions_templates", [])
    if not isinstance(listed, list) or not listed:
        fail("manifest permissions_templates must be a non-empty list")
    actual = sorted(p.name for p in PERMISSIONS_DIR.glob("*.json"))
    if sorted(listed) != actual:
        fail(
            "manifest permissions templates do not match files: "
            f"listed={sorted(listed)} actual={actual}"
        )
    for name in listed:
        path = PERMISSIONS_DIR / name
        data = load_json(path)
        validate_structured_credentials(data, path.relative_to(ROOT), label="permissions template")
        if not isinstance(data, dict):
            fail(f"{path.relative_to(ROOT)} root must be an object")
        allowlist = data.get("mcpAllowlist", [])
        if not isinstance(allowlist, list) or "playwright:*" not in [str(x) for x in allowlist]:
            fail(f"{path.relative_to(ROOT)} must include playwright:* in mcpAllowlist")
        if data.get("terminalAllowlist"):
            fail(f"{path.relative_to(ROOT)} must not define terminalAllowlist")
    profile = load_json(GLOBAL_PROFILE)
    if profile.get("id") != "global-playwright":
        fail("global-profile.json id must be global-playwright")
    if profile.get("project_writes") is not False:
        fail("global-profile.json must set project_writes false")
    ok("Cursor permissions templates valid")


def validate_sandbox_profiles(manifest: dict) -> None:
    listed = manifest.get("legacy_sandbox_profiles", [])
    if not isinstance(listed, list) or not listed:
        fail("manifest legacy_sandbox_profiles must be a non-empty list")
    actual = sorted(p.name for p in SANDBOX_DIR.iterdir() if p.is_file())
    if sorted(listed) != actual:
        fail(f"manifest sandbox profiles do not match files: listed={sorted(listed)} actual={actual}")
    for name in listed:
        path = SANDBOX_DIR / name
        if path.suffix != ".json":
            continue
        data = load_json(path)
        validate_structured_credentials(data, path.relative_to(ROOT), label="sandbox profile")
        if not isinstance(data, dict):
            fail(f"{path.relative_to(ROOT)} root must be an object")
        profile = str(data.get("profile", ""))
        commands = data.get("command_allowlist", [])
        if not isinstance(commands, list):
            fail(f"{path.relative_to(ROOT)} command_allowlist must be an array")
        for command in commands:
            value = str(command).strip().lower()
            if value in COMMAND_ALLOWLIST_DENY:
                fail(f"{path.relative_to(ROOT)} must not command-allowlist {value} for MCP support")
        mcp_allowlist = data.get("mcp_allowlist", [])
        if not isinstance(mcp_allowlist, list):
            fail(f"{path.relative_to(ROOT)} mcp_allowlist must be an array")
        for item in mcp_allowlist:
            value = str(item)
            if value.lower().startswith("fetch:*") and profile != "playwright-full":
                fail(f"{path.relative_to(ROOT)} has broad fetch wildcard outside full profile")
            if MCP_BROAD.match(value) and profile != "playwright-full":
                warn(f"{path.relative_to(ROOT)} has broad MCP allowlist entry: {value}")
        if profile.startswith("playwright"):
            requires = data.get("playwright_mcp", {}).get("requires_command_allowlist")
            if requires is not False:
                fail(f"{path.relative_to(ROOT)} must confirm Playwright MCP does not require command allowlist entries")
    ok("Cursor sandbox profiles valid")


def validate_no_fake_user_rules_path() -> None:
    for base in [CURSOR, ROOT / "docs", ROOT / "README.md", ROOT / "scripts"]:
        paths = [base] if base.is_file() else list(base.rglob("*"))
        for path in paths:
            if not path.is_file():
                continue
            if path == Path(__file__).resolve():
                continue
            if path.name.startswith(".env"):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if FAKE_USER_RULES_PATH.search(text):
                fail(f"fake global Cursor User Rules path documented in {path.relative_to(ROOT)}")
    ok("No fake global Cursor User Rules path documented")


def main() -> int:
    manifest = validate_manifest()
    validate_agents(manifest)
    validate_rules(manifest)
    validate_mcp(manifest)
    validate_permissions_templates(manifest)
    validate_sandbox_profiles(manifest)
    validate_no_fake_user_rules_path()
    return 0


if __name__ == "__main__":
    sys.exit(main())
