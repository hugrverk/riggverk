#!/usr/bin/env python3
"""Validate Codex config templates without reading installed user data."""

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CODEX = ROOT / "templates" / "codex"
TOKENISH = re.compile(r"(sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|Basic\s+\S+|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-)", re.I)


EXPECTED_TOP_LEVEL = {
    "model": "gpt-5.5",
    "model_reasoning_effort": "high",
    "approval_policy": "on-request",
    "approvals_reviewer": "user",
    "sandbox_mode": "workspace-write",
}

EXPECTED_APP_DEFAULTS = {
    "approvals_reviewer": "user",
    "default_tools_approval_mode": "prompt",
}


def fail(message: str) -> None:
    print(f"FAIL {message}")
    raise SystemExit(1)


def ok(message: str) -> None:
    print(f"PASS {message}")


def load_toml(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
        if TOKENISH.search(text):
            fail(f"{path.relative_to(ROOT)} contains credential-like literal")
        return tomllib.loads(text)
    except Exception as exc:
        fail(f"{path.relative_to(ROOT)} invalid TOML: {exc}")


def main() -> int:
    required = [
        CODEX / "README.md",
        CODEX / "config.toml",
        CODEX / "mcp" / "README.md",
        CODEX / "mcp" / "playwright.toml",
    ]
    for path in required:
        if not path.exists():
            fail(f"missing {path.relative_to(ROOT)}")

    config = load_toml(CODEX / "config.toml")
    for key, expected in EXPECTED_TOP_LEVEL.items():
        if config.get(key) != expected:
            fail(f"templates/codex/config.toml must set {key} = {expected!r}")

    apps = config.get("apps")
    if not isinstance(apps, dict) or not isinstance(apps.get("_default"), dict):
        fail("templates/codex/config.toml must define apps._default routing defaults")
    for key, expected in EXPECTED_APP_DEFAULTS.items():
        if apps["_default"].get(key) != expected:
            fail(f"templates/codex/config.toml must set apps._default.{key} = {expected!r}")

    if "profile" in config or "profiles" in config:
        fail("templates/codex/config.toml must not reintroduce legacy profile selectors")

    load_toml(CODEX / "mcp" / "playwright.toml")
    ok("Codex config template valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
