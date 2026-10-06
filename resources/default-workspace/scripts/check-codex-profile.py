#!/usr/bin/env python3
"""Validate Codex config templates without reading installed user data."""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import ast as _ast
    class tomllib:  # type: ignore[no-redef]
        TOMLDecodeError = ValueError
        @staticmethod
        def loads(text: str) -> dict:
            root: dict = {}
            current = root
            for raw_line in text.splitlines():
                s = raw_line.strip()
                if not s or s.startswith("#"):
                    continue
                if s.startswith("[") and s.endswith("]"):
                    parts = [p.strip().strip('"') for p in s[1:-1].split(".")]
                    if not parts or any(not p for p in parts):
                        continue
                    c = root
                    for p in parts:
                        c = c.setdefault(p, {})
                    current = c
                    continue
                if "=" not in s:
                    continue
                k, v = s.split("=", 1)
                v = v.strip()
                in_q = False
                esc = False
                for i, ch in enumerate(v):
                    if esc:
                        esc = False
                        continue
                    if ch == "\\":
                        esc = True
                        continue
                    if ch == '"':
                        in_q = not in_q
                        continue
                    if ch == "#" and not in_q:
                        v = v[:i].rstrip()
                        break
                if v == "true":
                    val = True
                elif v == "false":
                    val = False
                elif v.startswith('"'):
                    val = _ast.literal_eval(v)
                else:
                    try:
                        val = int(v)
                    except ValueError:
                        try:
                            val = float(v)
                        except ValueError:
                            val = v
                kk = k.strip()
                if "." in kk:
                    ks = [p.strip().strip('"') for p in kk.split(".")]
                    c = root
                    for p in ks[:-1]:
                        c = c.setdefault(p, {})
                    c[ks[-1]] = val
                else:
                    current[kk] = val
            return root

ROOT = Path(__file__).resolve().parents[1]
CODEX = ROOT / "templates" / "codex"
TOKENISH = re.compile(r"(sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|Basic\s+\S+|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-)", re.I)


# `model` and `model_reasoning_effort` are create-only seeds: the installer writes
# them only while config.toml has no value, so the template must still carry them.
EXPECTED_TOP_LEVEL = {
    "model": "gpt-6.1-sol",
    "model_reasoning_effort": "xhigh",
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
