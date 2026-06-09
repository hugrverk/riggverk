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
    "architect": {
        "spec": "architect.body.md",
        "harnesses": {
            "opencode": {
                "output": "agents/architect.md",
                "header": "templates/opencode/agents/architect.header.yaml",
            }
        },
    },
    "repo-scout": {
        "spec": "repo-scout.body.md",
        "harnesses": {
            "opencode": {
                "output": "agents/repo-scout.md",
                "header": "templates/opencode/agents/repo-scout.header.yaml",
            },
            "claude": {
                "output": "templates/claude/agents/repo-scout.md",
                "header": "templates/claude/agents/repo-scout.header.yaml",
            },
            "codex": {
                "output": "templates/codex/agents/repo_scout.toml",
                "meta": "templates/codex/agents/repo_scout.meta.json",
            },
            "cursor": {
                "output": "templates/cursor/agents/repo-scout.md",
                "header": "templates/cursor/agents/repo-scout.header.yaml",
            },
        },
    },
    "inspector": {
        "spec": "inspector.body.md",
        "harnesses": {
            "opencode": {
                "output": "agents/inspector.md",
                "header": "templates/opencode/agents/inspector.header.yaml",
            },
            "claude": {
                "output": "templates/claude/agents/inspector.md",
                "header": "templates/claude/agents/inspector.header.yaml",
                "line_replacements": {
                    "Review only.": "Review only. Do not edit files or expose sensitive configuration or authentication material."
                },
            },
            "codex": {
                "output": "templates/codex/agents/inspector.toml",
                "meta": "templates/codex/agents/inspector.meta.json",
            },
            "cursor": {
                "output": "templates/cursor/agents/inspector.md",
                "header": "templates/cursor/agents/inspector.header.yaml",
            },
        },
    },
    "sentinel": {
        "spec": "sentinel.body.md",
        "harnesses": {
            "opencode": {
                "output": "agents/sentinel.md",
                "header": "templates/opencode/agents/sentinel.header.yaml",
            },
            "claude": {
                "output": "templates/claude/agents/sentinel.md",
                "header": "templates/claude/agents/sentinel.header.yaml",
                "line_replacements": {
                    "- Any path that could": "- Any path that could expose sensitive configuration or authentication material."
                },
            },
            "codex": {
                "output": "templates/codex/agents/security_reviewer.toml",
                "meta": "templates/codex/agents/security_reviewer.meta.json",
            },
        },
    },
    "scribe": {
        "spec": "scribe.body.md",
        "harnesses": {
            "opencode": {
                "output": "agents/scribe.md",
                "header": "templates/opencode/agents/scribe.header.yaml",
            },
            "claude": {
                "output": "templates/claude/agents/scribe.md",
                "header": "templates/claude/agents/scribe.header.yaml",
            },
        },
    },
    "verifier": {
        "spec": "verifier.body.md",
        "harnesses": {
            "opencode": {
                "output": "agents/verifier.md",
                "header": "templates/opencode/agents/verifier.header.yaml",
            },
            "claude": {
                "output": "templates/claude/agents/verifier.md",
                "header": "templates/claude/agents/verifier.header.yaml",
                "line_replacements": {
                    "- Inspect or print": "- Expose sensitive configuration or authentication material."
                },
            },
            "codex": {
                "output": "templates/codex/agents/verifier.toml",
                "meta": "templates/codex/agents/verifier.meta.json",
            },
            "cursor": {
                "output": "templates/cursor/agents/verifier.md",
                "header": "templates/cursor/agents/verifier.header.yaml",
            },
        },
    },
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
    header = load_header(header_rel)
    return f"---\n{header}---\n\n{body}"


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
    sandbox = meta.get("sandbox_mode")
    if sandbox:
        lines.append(f'sandbox_mode = {json.dumps(sandbox)}')
    return "\n".join(lines) + "\n"


def generated_outputs() -> dict[Path, str]:
    outputs: dict[Path, str] = {}
    for role in ROLES.values():
        body = load_body(role["spec"])
        for harness_name, harness in role["harnesses"].items():
            out = WS_ROOT / harness["output"]
            adapted_body = adapt_body(body, harness.get("line_replacements"))
            if harness_name == "codex":
                content = compose_codex_toml(harness["meta"], adapted_body)
            else:
                content = compose_markdown(harness["header"], adapted_body)
            outputs[out] = content
    return outputs


def write_manifest() -> None:
    MANIFEST_PATH.write_text(
        json.dumps({"version": 1, "roles": ROLES}, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    args = parser.parse_args()

    outputs = generated_outputs()
    stale: list[str] = []

    for path, expected in sorted(outputs.items()):
        rel = path.relative_to(REPO_ROOT)
        if not path.exists():
            stale.append(f"missing {rel}")
            continue
        actual = path.read_text(encoding="utf-8")
        if actual != expected:
            stale.append(f"stale {rel}")

    for path, content in outputs.items():
        if path.suffix == ".toml":
            tomllib.loads(content)

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
        sys.exit(0)

    if stale:
        print("FAIL: generated agent adapters are stale:", file=sys.stderr)
        for item in stale:
            print(f"  - {item}", file=sys.stderr)
        print("Run: python3 scripts/generate-agent-adapters.py --write", file=sys.stderr)
        sys.exit(1)

    print(f"PASS: {len(outputs)} harness adapter files are current")


if __name__ == "__main__":
    main()
