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
    if config.get("profile") != "safe":
        fail("templates/codex/config.toml must default to safe profile")

    profiles = config.get("profiles")
    if not isinstance(profiles, dict):
        fail("templates/codex/config.toml must define [profiles.*] sections")
    for name in ("safe", "workspace-write"):
        profile = profiles.get(name)
        if not isinstance(profile, dict):
            fail(f"templates/codex/config.toml missing [profiles.{name}]")
        if profile.get("approval_policy") != "on-request":
            fail(f"[profiles.{name}] must keep approval_policy on-request")
        if profile.get("sandbox_mode") != "workspace-write":
            fail(f"[profiles.{name}] must keep sandbox_mode workspace-write")

    load_toml(CODEX / "mcp" / "playwright.toml")
    ok("Codex config template valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
