#!/usr/bin/env python3
"""Guard what ships in resources/default-workspace.

The app bundles the whole directory as it is on disk, ignored files included, so every check
here reads the directory on disk rather than the git index. Groups: Codex templates, manifest
files present, no symlinks, strict JSON, Playwright MCP guardrails, the Playwright MCP pin
(every bundled template and doc names the version the app writes and every entry passes
`--browser chrome --isolated --no-webmcp`; an old release only warns),
OpenCode and TUI defaults, the shared agents, retired OpenCode headers, the private-context
boundary and the Cursor user rules wording.

Usage: python3 scripts/check-bundle-content.py [--group NAME[,NAME]] [--root PATH]
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 11):
    sys.exit(
        "FAIL: python3 3.11 or newer is required by scripts/check-bundle-content.py "
        f"(found: Python {sys.version.split()[0]}); put a newer python3 first on PATH"
    )

import argparse
import json
import os
import re
import tomllib
from collections.abc import Callable
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retired_workspace_files as frozen  # noqa: E402
from guards import Rule, check, walk  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = "resources/default-workspace"
W = f"{BUNDLE}/"
FROZEN_LIST_RS = frozen.RUST_MODULE

# --- codex -----------------------------------------------------------------------------------
CODEX_TEMPLATES = (
    "templates/codex/README.md",
    "templates/codex/config.toml",
    "templates/codex/mcp/README.md",
    "templates/codex/mcp/playwright.toml",
)
TOKENISH = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|Basic\s+\S+|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-)", re.I
)


def codex(root: Path, files: list[str]) -> list[str]:
    errors: list[str] = []
    for rel in CODEX_TEMPLATES:
        path = root / BUNDLE / rel
        if not path.is_file():
            errors.append(f"missing Codex template: {W}{rel}")
            continue
        text = path.read_text(encoding="utf-8")
        if TOKENISH.search(text):
            errors.append(f"Codex template contains a credential-like literal: {W}{rel}")
        if path.suffix == ".toml":
            try:
                tomllib.loads(text)
            except tomllib.TOMLDecodeError as exc:
                errors.append(f"Codex template is not valid TOML: {W}{rel}: {exc}")
    config_path = root / BUNDLE / "templates/codex/config.toml"
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return errors
    if config.get("approval_policy") != "on-request":
        errors.append("Codex config must default approval_policy to on-request")
    if config.get("sandbox_mode") != "workspace-write":
        errors.append("Codex config must default sandbox_mode to workspace-write")
    # Codex 0.134+ rejects the legacy top-level profile selector and ignores [profiles.*] tables.
    if "profile" in config:
        errors.append("Codex config template must not use the legacy profile selector")
    if "profiles" in config:
        errors.append("Codex config template must not define legacy [profiles.*] tables")
    return errors


# --- nonempty --------------------------------------------------------------------------------
# The bundled user docs. Deleting one is a product decision: remove it here in the same change.
DOC_FLOOR = frozenset(
    f"docs/{name}.md"
    for name in (
        "START_HERE",
        "CONCEPTS",
        "USING_THE_APP",
        "GIT_VERSIONING",
        "WORKFLOWS",
        "SECURITY_BASELINE",
        "SKILLS",
        "AGENT_RULES",
        "OPENCODE_CONFIG",
        "CODEX_CONFIG",
        "TROUBLESHOOTING",
    )
)


def nonempty(root: Path, files: list[str]) -> list[str]:
    try:
        frozen_list = frozen.load(root)
    except ValueError as error:
        return [str(error)]
    if not frozen_list.files:
        return [f"{FROZEN_LIST_RS}: RETIRED_WORKSPACE_FILES lists no files"]
    # A listed path the bundle dropped on purpose is documented in the Rust tests and has no file.
    listed = set(frozen_list.copy_paths()) - set(frozen_list.retired_from_bundle)
    errors = []
    for rel in sorted(listed | DOC_FLOOR):
        path = root / BUNDLE / rel
        if not path.is_file() or path.stat().st_size == 0:
            errors.append(f"bundled file missing or empty: {W}{rel}")
    return errors


# --- symlinks --------------------------------------------------------------------------------
def symlinks(root: Path, files: list[str]) -> list[str]:
    errors = []
    for current, dirs, names in os.walk(root / BUNDLE):
        for name in sorted(dirs + names):
            path = Path(current) / name
            if path.is_symlink():
                errors.append(f"symlink in the bundled workspace: {path.relative_to(root).as_posix()}")
    return errors


# --- json ------------------------------------------------------------------------------------
def _reject_constant(name: str) -> None:
    raise ValueError(f"non-standard JSON constant {name}")


def strict_json(root: Path, files: list[str]) -> list[str]:
    errors = []
    for rel in files:
        if not rel.endswith(".json"):
            continue
        try:
            json.loads((root / rel).read_text(encoding="utf-8"), parse_constant=_reject_constant)
        except (OSError, ValueError) as exc:
            errors.append(f"not strict JSON: {rel}: {exc}")
    return errors


# --- playwright ------------------------------------------------------------------------------
SHIPPED_CODE = (f"{W}templates/", f"{W}scripts/")
PLAYWRIGHT_RULES = (
    Rule(
        "playwright-latest",
        "forbid",
        r"@playwright/mcp@latest",
        SHIPPED_CODE,
        "the Playwright MCP package must be pinned, not @latest",
        '"args": ["@playwright/mcp@latest"]',
    ),
    # The Copilot, Pi and Kilo entries choose the browser with inline flags only: the sidecar
    # config belongs to the OpenCode config surface, and a missing file crashes the server at start.
    Rule(
        "playwright-sidecar",
        "forbid",
        r"(--config|__PLAYWRIGHT_MCP_CONFIG_PATH__|playwright-mcp)",
        (f"{W}templates/mcp/",),
        "templates/mcp entries must not depend on the Playwright MCP sidecar config",
        '"--config", "__PLAYWRIGHT_MCP_CONFIG_PATH__"',
    ),
    Rule(
        "playwright-browsers-path",
        "forbid",
        r"PLAYWRIGHT_BROWSERS_PATH=0",
        SHIPPED_CODE,
        "PLAYWRIGHT_BROWSERS_PATH=0 must not ship",
        "PLAYWRIGHT_BROWSERS_PATH=0 npx",
    ),
    # Neutral example paths such as /Users/example are allowed.
    Rule(
        "hardcoded-home",
        "forbid",
        r"/(Users|home)/[A-Za-z0-9._-]+",
        SHIPPED_CODE,
        "hardcoded /Users/<name> or /home/<name> path in shipped templates/scripts",
        '{"path": "/Users/someone-else/project"}',
        allow=r"/(Users|home)/(example|Shared|user|username|you)",
    ),
    Rule(
        "playwright-chromium",
        "require",
        r'"browserName"\s*:\s*"chromium"',
        (f"{W}templates/playwright-mcp.config.json",),
        "playwright MCP config must default browserName to chromium",
        '"browserName": "chromium"',
    ),
)

# --- playwright-pin --------------------------------------------------------------------------
# One version and its npm release day live in a constant of the Rust app (the app writes it into
# the OpenCode, Cursor and light-harness entries); the bundled templates and docs repeat it and
# must agree. Every entry also carries the same flags after the package: the system Google Chrome
# (`--browser chrome`, so no Playwright Chromium download), a profile kept in memory, and no
# tools registered by a page (`--no-webmcp`; WebMCP is on by default since 0.0.81). A pin older
# than PIN_MAX_AGE_DAYS only warns, from the recorded day and the local clock, so the check needs
# no network and never fails offline.
PIN_SOURCE = "src-tauri/src/commands/cursor_profile.rs"
PIN_LINE = re.compile(r'PLAYWRIGHT_MCP_VERSION: &str = "([^"]+)";\s*// released (\d{4}-\d{2}-\d{2})')
PINNED = re.compile(r"@playwright/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)")
# Template -> where the argument list of the Playwright entry sits in it.
PIN_ENTRIES: dict[str, tuple[str, ...]] = {
    "templates/opencode.base.json": ("mcp", "playwright", "command"),
    "templates/opencode.json": ("mcp", "playwright", "command"),
    "templates/cursor/mcp/playwright.mcp.json": ("mcpServers", "playwright", "args"),
    "templates/codex/mcp/playwright.toml": ("mcp_servers", "playwright", "args"),
    "templates/mcp/copilot.playwright.json": ("args",),
    "templates/mcp/pi.playwright.json": ("args",),
    "templates/mcp/kilo.playwright.json": ("command",),
    "templates/mcp/antigravity.playwright.json": ("args",),
    "templates/mcp/grok.playwright.json": ("args",),
}
PIN_TEMPLATES = tuple(PIN_ENTRIES)
PIN_OUTSIDE_DOCS = ("README.md", "docs/*.md")
PIN_MAX_AGE_DAYS = 183  # about six months


def read_pin(root: Path) -> tuple[str, date] | str:
    """The pinned version and its release day, or a message saying why they cannot be read."""
    try:
        text = (root / PIN_SOURCE).read_text(encoding="utf-8")
    except OSError:
        return f"missing the Playwright MCP pin source: {PIN_SOURCE}"
    match = PIN_LINE.search(text)
    if match is None:
        return f'{PIN_SOURCE}: no `PLAYWRIGHT_MCP_VERSION: &str = "x.y.z"; // released YYYY-MM-DD` line'
    try:
        return match.group(1), date.fromisoformat(match.group(2))
    except ValueError:
        return f"{PIN_SOURCE}: the release day {match.group(2)} is not a date"


def playwright_pin(root: Path, files: list[str]) -> list[str]:
    pin = read_pin(root)
    if isinstance(pin, str):
        return [pin]
    version = pin[0]
    outside = sorted(path.relative_to(root).as_posix() for pattern in PIN_OUTSIDE_DOCS for path in root.glob(pattern))
    errors = []
    for rel in [*files, *outside]:
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            errors += [
                f"{rel}:{number}: names @playwright/mcp@{found}, the app pins {version} ({PIN_SOURCE})"
                for found in PINNED.findall(line)
                if found != version
            ]
    for rel, location in PIN_ENTRIES.items():
        path = root / BUNDLE / rel
        if path.is_file():
            errors += pin_entry_errors(path, rel, location, version)
    return errors


def entry_arguments(path: Path, location: tuple[str, ...]) -> list[str] | str:
    """The argument list of the Playwright entry in a template, or a message saying why not."""
    try:
        text = path.read_text(encoding="utf-8")
        node: object = tomllib.loads(text) if path.suffix == ".toml" else json.loads(text)
    except (OSError, UnicodeDecodeError, ValueError):
        return "cannot be read as the entry template it is"
    for key in location:
        if not isinstance(node, dict) or key not in node:
            return f"has no {'.'.join(location)} entry"
        node = node[key]
    if not isinstance(node, list) or not all(isinstance(word, str) for word in node):
        return f"{'.'.join(location)} is not a list of strings"
    return node


def pin_entry_errors(path: Path, rel: str, location: tuple[str, ...], version: str) -> list[str]:
    arguments = entry_arguments(path, location)
    if isinstance(arguments, str):
        return [f"{W}{rel}: {arguments}"]
    errors = []
    if f"@playwright/mcp@{version}" not in arguments:
        errors.append(f"{W}{rel}: does not pin @playwright/mcp@{version} ({PIN_SOURCE})")
    if ("--browser", "chrome") not in list(zip(arguments, arguments[1:])):
        errors.append(
            f"{W}{rel}: does not select the system Chrome: pass `--browser chrome` "
            "(a browser named in a config file or `chromium` makes Playwright use its own Chromium, "
            "which needs a download)"
        )
    if "--isolated" not in arguments:
        errors.append(f"{W}{rel}: does not pass `--isolated` (the profile stays in memory)")
    if "--no-webmcp" not in arguments:
        errors.append(
            f"{W}{rel}: does not pass `--no-webmcp`: a page could register tools that the model "
            "would see as webmcp_* tools"
        )
    return errors


def pin_warnings(root: Path, today: date | None = None) -> list[str]:
    """A warning when the pinned release is older than PIN_MAX_AGE_DAYS; nothing when unreadable."""
    pin = read_pin(root)
    if isinstance(pin, str):
        return []
    version, released = pin
    age = ((today or date.today()) - released).days
    if age <= PIN_MAX_AGE_DAYS:
        return []
    return [
        f"@playwright/mcp@{version} was released on {released} ({age} days ago, the limit is "
        f"{PIN_MAX_AGE_DAYS}): bump it to the newest stable release that is at least 14 days old "
        f"(npm view @playwright/mcp time), in {PIN_SOURCE} and the templates and docs that repeat it"
    ]


# --- opencode-defaults / tui-defaults --------------------------------------------------------
OPENCODE_LITERALS = {"lsp": True, "autoupdate": "notify", "snapshot": True}
TUI_DEFAULTS = {
    "theme": "system",
    "diff_style": "auto",
    "mouse": True,
    "leader_timeout": 2000,
    "scroll_acceleration.enabled": True,
}

def _load_json(root: Path, rel: str, errors: list[str]) -> dict | None:
    try:
        data = json.loads((root / BUNDLE / rel).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors.append(f"cannot read {W}{rel}: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{W}{rel} must be a JSON object")
        return None
    return data


def _lookup(data: dict, dotted: str) -> object:
    value: object = data
    for part in dotted.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def opencode_defaults(root: Path, files: list[str]) -> list[str]:
    errors: list[str] = []
    config = _load_json(root, "templates/opencode.json", errors)
    if config is None:
        return errors
    for key, expected in OPENCODE_LITERALS.items():
        if config.get(key) != expected:
            errors.append(f"templates/opencode.json {key} must be {expected!r}, found {config.get(key)!r}")
    for key in ("model", "small_model"):
        if key in config:
            errors.append(f"templates/opencode.json must not set {key}")
    base = _load_json(root, "templates/opencode.base.json", errors)
    if base is not None:
        for key in ("model", "small_model"):
            if key in base:
                errors.append(f"templates/opencode.base.json must not set {key}")
    return errors


def tui_defaults(root: Path, files: list[str]) -> list[str]:
    errors: list[str] = []
    config = _load_json(root, "templates/tui.json", errors)
    if config is None:
        return errors
    for key, expected in TUI_DEFAULTS.items():
        if _lookup(config, key) != expected:
            errors.append(f"templates/tui.json {key} must be {expected!r}, found {_lookup(config, key)!r}")
    return errors


# --- agents ----------------------------------------------------------------------------------
def frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    fields = {}
    for line in text[4:end].splitlines():
        if not line.startswith(" ") and ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    return fields


def agents(root: Path, files: list[str]) -> list[str]:
    errors: list[str] = []
    meta = _load_json(root, "metadata/agents.json", errors)
    adapters = _load_json(root, "metadata/agent-adapters.json", errors)
    config = _load_json(root, "templates/opencode.json", errors)
    if meta is None or adapters is None or config is None:
        return errors
    expected = set(meta.get("agents", {}))
    if not expected:
        return ["metadata/agents.json lists no agents"]
    generated = {
        Path(entry["harnesses"]["opencode"]["output"]).name
        for entry in adapters.get("roles", {}).values()
        if "opencode" in entry.get("harnesses", {})
    }
    if expected != generated:
        errors.append(
            "metadata/agents.json keys must match the OpenCode outputs in metadata/agent-adapters.json; "
            f"only in agents.json={sorted(expected - generated)} only in adapters={sorted(generated - expected)}"
        )
    agents_dir = root / BUNDLE / "agents"
    on_disk = {path.name for path in agents_dir.glob("*.md")}
    if on_disk != expected:
        errors.append(
            f"{W}agents/*.md must equal metadata/agents.json; "
            f"missing={sorted(expected - on_disk)} extra={sorted(on_disk - expected)}"
        )
    primaries = []
    for name in sorted(on_disk & expected):
        path = agents_dir / name
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            errors.append(f"bundled agent is empty: {W}agents/{name}")
            continue
        # Agents are model-agnostic: model selection is centralized in templates/opencode.json.
        if re.search(r"^model:", text, re.MULTILINE):
            errors.append(f"bundled agent has model frontmatter (keep agents model-agnostic): {W}agents/{name}")
        mode = frontmatter(text).get("mode")
        if mode == "primary":
            primaries.append(path.stem)
        elif mode != "subagent":
            errors.append(f"bundled agent mode must be primary or subagent, found {mode!r}: {W}agents/{name}")
    default_agent = config.get("default_agent")
    if primaries != [default_agent]:
        errors.append(
            f"exactly one bundled agent must be mode: primary and it must be opencode.json "
            f"default_agent {default_agent!r}; primary agents: {primaries}"
        )
    return errors


# --- opencode-headers ------------------------------------------------------------------------
def opencode_headers(root: Path, files: list[str]) -> list[str]:
    return [
        f"hand-maintained OpenCode agent header (use role.json + policy compose): {rel}"
        for rel in files
        if rel.startswith(f"{W}templates/opencode/agents/") and rel.endswith(".header.yaml")
    ]


# --- boundary --------------------------------------------------------------------------------
PRIVATE_FILES = ("saved-memory.md", "USER_CONTEXT.md", "skill-routing-brain-setup.md")
PRIVATE_DIRS = ("private-context",)
# Built from fragments so this file does not itself contain the names it bans.
_FIRST = "C" "arl"
PRIVATE_NAMES = (
    _FIRST,
    "Dis" "chornan",
    "Disch" "örnan",
    "Hantverks" "registret",
    "Account cred" "its",
    "personal mod" "el",
)
BOUNDARY_RULES = (
    Rule(
        "private-context-paths",
        "forbid",
        r"(^|[^/])saved-memory\.md|docs/USER_CONTEXT\.md|skill-routing-brain-setup\.md|templates/context/",
        (W,),
        "the bundle must not reference private context paths",
        "see docs/USER_CONTEXT.md",
    ),
    Rule(
        "private-context-markers",
        "forbid",
        f"{_FIRST}'s private|{_FIRST}-specific personal|private-context repo",
        (W,),
        "the bundle must not carry private context markers",
        "kept in the private-context repo",
    ),
    Rule(
        "private-names",
        "forbid",
        r"(?<!\w)(?:" + "|".join(map(re.escape, PRIVATE_NAMES)) + r")(?!\w)",
        (W,),
        "the bundle must not contain private names",
        f"ask {PRIVATE_NAMES[3]} first",
    ),
)


def boundary(root: Path, files: list[str]) -> list[str]:
    errors = []
    for current, dirs, names in os.walk(root / BUNDLE):
        rel = Path(current).relative_to(root).as_posix()
        errors += [f"private context file in the bundle: {rel}/{name}" for name in names if name in PRIVATE_FILES]
        errors += [f"private context directory in the bundle: {rel}/{name}" for name in dirs if name in PRIVATE_DIRS]
    return errors


# --- cursor-user-rules -----------------------------------------------------------------------
USER_RULES_PHRASES = (
    "Cursor rules, skills, subagents, and MCP are separate surfaces",
    "Use subagents only when they reduce risk, context load, or verification burden",
    "Do not duplicate workflow instructions across all surfaces",
)
USER_RULES_RULES = tuple(
    Rule(
        f"cursor-user-rules-{index}",
        "require",
        re.escape(phrase),
        (f"{W}templates/cursor/user-rules.md",),
        f"templates/cursor/user-rules.md must keep the subagent guidance: {phrase}",
        phrase,
    )
    for index, phrase in enumerate(USER_RULES_PHRASES, 1)
)

Check = Callable[[Path, list[str]], list[str]]
GROUPS: dict[str, tuple[tuple[Rule, ...], Check | None]] = {
    "codex": ((), codex),
    "nonempty": ((), nonempty),
    "symlinks": ((), symlinks),
    "json": ((), strict_json),
    "playwright": (PLAYWRIGHT_RULES, None),
    "playwright-pin": ((), playwright_pin),
    "opencode-defaults": ((), opencode_defaults),
    "tui-defaults": ((), tui_defaults),
    "agents": ((), agents),
    "opencode-headers": ((), opencode_headers),
    "boundary": (BOUNDARY_RULES, boundary),
    "cursor-user-rules": (USER_RULES_RULES, None),
}
RULES = tuple(rule for rules, _ in GROUPS.values() for rule in rules)


def bundle_files(root: Path) -> list[str]:
    """Every file on disk under the bundle, repo-relative; symlinks are reported, not followed."""
    base = root / BUNDLE
    return [f"{W}{rel}" for rel in walk(base) if not (base / rel).is_symlink()]


def run(root: Path, groups: list[str]) -> list[str]:
    files = bundle_files(root)
    failures = []
    for name in groups:
        rules, extra = GROUPS[name]
        failures += [f"[{name}] {message}" for message in check(root, rules, files)]
        if extra is not None:
            failures += [f"[{name}] {message}" for message in extra(root, files)]
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--group", action="append", default=[], help="comma-separated group names")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    groups = [name for value in args.group for name in value.split(",") if name] or list(GROUPS)
    unknown = sorted(set(groups) - set(GROUPS))
    if unknown:
        parser.error(f"unknown group(s) {unknown}; known: {', '.join(GROUPS)}")
    if not (args.root / BUNDLE).is_dir():
        print(f"FAIL: bundled workspace not found: {args.root / BUNDLE}", file=sys.stderr)
        return 1
    root = args.root.resolve()
    failures = run(root, groups)
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    if "playwright-pin" in groups:
        for warning in pin_warnings(root):
            print(f"WARN {warning}", file=sys.stderr)
    if failures:
        return 1
    print(f"  bundle content checks passed: {', '.join(groups)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
