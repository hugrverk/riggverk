#!/usr/bin/env python3
"""Generate harness-specific single-file skill adapters.

Usage:
  python3 scripts/generate-skill-adapters.py --check
  python3 scripts/generate-skill-adapters.py --write
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WS_ROOT = REPO_ROOT / "resources" / "default-workspace"
SKILLS_ROOT = WS_ROOT / "skills"
TEMPLATE_SKILLS_ROOT = WS_ROOT / "templates" / "skills"
OVERLAY_ROOT = TEMPLATE_SKILLS_ROOT / "_overlays"
MANIFEST_PATH = WS_ROOT / "metadata" / "skill-adapters.json"

VALID_HARNESSES = ("codex", "claude", "opencode", "cursor")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
FIELD_RE = re.compile(r"^([a-zA-Z0-9_-]+):\s*(.*?)\s*$")


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def rel(path: Path) -> str:
    return path.relative_to(WS_ROOT).as_posix()


def parse_frontmatter(path: Path, text: str) -> tuple[dict[str, str], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        fail(f"{path.relative_to(REPO_ROOT)}: missing canonical frontmatter")
    end = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = index
            break
    if end is None:
        fail(f"{path.relative_to(REPO_ROOT)}: missing canonical frontmatter closing delimiter")

    fields: dict[str, str] = {}
    for line in lines[1:end]:
        match = FIELD_RE.match(line.strip())
        if match:
            fields[match.group(1)] = match.group(2).strip()
    frontmatter = "\n".join(lines[1:end]) + "\n"
    return fields, frontmatter


def parse_targets(path: Path, raw: str) -> tuple[str, ...]:
    if not raw:
        fail(f"{path.relative_to(REPO_ROOT)}: missing targets frontmatter")
    value = raw.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    targets = tuple(
        item.strip().strip('"').strip("'")
        for item in value.split(",")
        if item.strip()
    )
    if not targets:
        fail(f"{path.relative_to(REPO_ROOT)}: empty targets frontmatter")
    unknown = sorted(set(targets) - set(VALID_HARNESSES))
    if unknown:
        fail(f"{path.relative_to(REPO_ROOT)}: unknown harness target(s): {unknown}")
    return targets


def validate_skill_name(path: Path, name: str) -> None:
    if not NAME_RE.fullmatch(name):
        fail(f"{path.relative_to(REPO_ROOT)}: invalid skill name: {name!r}")


def split_canonical(path: Path, text: str) -> tuple[list[str], str]:
    """Split canonical text into frontmatter lines (keepends) and body.

    Reconstruction must be byte-exact so untransformed adapters stay stable.
    """
    lines = text.splitlines(keepends=True)
    if not lines or lines[0] != "---\n":
        fail(f"{path.relative_to(REPO_ROOT)}: canonical frontmatter must open with '---'")
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            fm_lines = lines[1:index]
            body = "".join(lines[index + 1:])
            if "---\n" + "".join(fm_lines) + "---\n" + body != text:
                fail(f"{path.relative_to(REPO_ROOT)}: canonical frontmatter delimiters are not plain '---' lines")
            return fm_lines, body
    fail(f"{path.relative_to(REPO_ROOT)}: canonical frontmatter never closes")
    raise AssertionError("unreachable")


WHEN_TO_USE_HEADER = "## When To Use"
WHEN_TO_USE_CHAR_CAP = 1536


def hoist_when_to_use(path: Path, fm_lines: list[str], body: str) -> tuple[list[str], str]:
    """Move the '## When To Use' body section into when_to_use frontmatter.

    Claude Code appends when_to_use to the description in the skill listing,
    which is where invocation decisions happen; the body loads too late.
    """
    lines = body.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip() == WHEN_TO_USE_HEADER), None)
    if start is None:
        return fm_lines, body
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    bullets = [line.strip()[2:].strip() for line in lines[start + 1:end] if line.strip().startswith("- ")]
    if not bullets:
        fail(f"{path.relative_to(REPO_ROOT)}: '{WHEN_TO_USE_HEADER}' section has no bullets to hoist")
    when_to_use = " ".join(item if item.endswith(".") else item + "." for item in bullets)
    description = ""
    for line in fm_lines:
        match = FIELD_RE.match(line.strip())
        if match and match.group(1) == "description":
            description = match.group(2)
            break
    if len(description) + len(when_to_use) > WHEN_TO_USE_CHAR_CAP:
        fail(
            f"{path.relative_to(REPO_ROOT)}: description + when_to_use is "
            f"{len(description) + len(when_to_use)} chars (cap {WHEN_TO_USE_CHAR_CAP}); trim the section"
        )
    new_fm: list[str] = []
    inserted = False
    for line in fm_lines:
        new_fm.append(line)
        match = FIELD_RE.match(line.strip())
        if not inserted and match and match.group(1) == "description":
            new_fm.append(f"when_to_use: {json.dumps(when_to_use)}\n")
            inserted = True
    if not inserted:
        fail(f"{path.relative_to(REPO_ROOT)}: cannot hoist when_to_use without a description field")
    del lines[start:end]
    new_body = "\n".join(lines)
    if body.endswith("\n"):
        new_body += "\n"
    return new_fm, new_body


def discover_skills() -> dict[str, dict[str, object]]:
    if not SKILLS_ROOT.is_dir():
        fail(f"skills root not found: {SKILLS_ROOT}")

    discovered: dict[str, dict[str, object]] = {}
    for skill_md in sorted(SKILLS_ROOT.rglob("SKILL.md")):
        relative_parts = skill_md.relative_to(SKILLS_ROOT).parts
        if len(relative_parts) not in (2, 3):
            fail(f"{skill_md.relative_to(REPO_ROOT)}: unsupported skill nesting")
        if any(part.startswith(".") for part in relative_parts):
            continue
        for candidate in (skill_md, *skill_md.parents):
            if candidate == SKILLS_ROOT.parent:
                break
            if candidate.exists() and candidate.is_symlink():
                fail(f"{candidate.relative_to(REPO_ROOT)}: refusing symlink skill path")

        text = skill_md.read_text(encoding="utf-8")
        fields, frontmatter = parse_frontmatter(skill_md, text)
        fm_lines, body = split_canonical(skill_md, text)
        name = fields.get("name", "")
        description = fields.get("description", "")
        if not name:
            fail(f"{skill_md.relative_to(REPO_ROOT)}: missing name frontmatter")
        if not description:
            fail(f"{skill_md.relative_to(REPO_ROOT)}: missing description frontmatter")
        validate_skill_name(skill_md, name)
        if name in discovered:
            fail(f"duplicate skill name: {name}")
        targets = parse_targets(skill_md, fields.get("targets", ""))
        discovered[name] = {
            "path": skill_md,
            "text": text,
            "frontmatter": frontmatter,
            "fm_lines": fm_lines,
            "body": body,
            "targets": targets,
        }
    if not discovered:
        fail("no canonical skills found")
    return dict(sorted(discovered.items()))


def load_overlay(path: Path) -> tuple[list[str], str]:
    """Load an overlay file as (frontmatter override lines, body).

    An overlay may open with a '---' block whose `key: value` lines are merged
    into the adapter frontmatter (collisions with canonical fields fail).
    """
    text = path.read_text(encoding="utf-8")
    fm_lines: list[str] = []
    body = text
    if text.startswith("---\n"):
        lines = text.splitlines(keepends=True)
        closing = None
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                closing = index
                break
        if closing is None:
            fail(f"{path.relative_to(REPO_ROOT)}: overlay frontmatter never closes")
        fm_lines = lines[1:closing]
        for line in fm_lines:
            if not FIELD_RE.match(line.strip()):
                fail(f"{path.relative_to(REPO_ROOT)}: overlay frontmatter line is not 'key: value': {line.strip()!r}")
        body = "".join(lines[closing + 1:])
    return fm_lines, body.strip() + "\n"


def overlay_sources(skills: dict[str, dict[str, object]]) -> dict[tuple[str, str | None], tuple[list[str], str]]:
    overlays: dict[tuple[str, str | None], tuple[list[str], str]] = {}
    if not OVERLAY_ROOT.exists():
        return overlays

    global_dir = OVERLAY_ROOT / "global"
    if global_dir.exists():
        for path in sorted(global_dir.glob("*.md")):
            harness = path.stem
            if harness not in VALID_HARNESSES:
                fail(f"{path.relative_to(REPO_ROOT)}: unknown overlay target {harness!r}")
            overlays[(harness, None)] = load_overlay(path)

    skills_dir = OVERLAY_ROOT / "skills"
    if skills_dir.exists():
        for skill_dir in sorted(child for child in skills_dir.iterdir() if child.is_dir()):
            skill_name = skill_dir.name
            if skill_name not in skills:
                fail(f"{skill_dir.relative_to(REPO_ROOT)}: unknown overlay skill {skill_name!r}")
            for path in sorted(skill_dir.glob("*.md")):
                harness = path.stem
                if harness not in VALID_HARNESSES:
                    fail(f"{path.relative_to(REPO_ROOT)}: unknown overlay target {harness!r}")
                overlays[(harness, skill_name)] = load_overlay(path)
    return overlays


def adapter_path(harness: str, skill_name: str) -> Path:
    if harness not in VALID_HARNESSES:
        fail(f"unknown harness: {harness}")
    validate_skill_name(Path(skill_name), skill_name)
    return TEMPLATE_SKILLS_ROOT / harness / skill_name / "SKILL.md"


def compose_adapter(info: dict[str, object], harness: str, skill_name: str, overlays: dict[tuple[str, str | None], tuple[list[str], str]]) -> str:
    global_overlay = overlays.get((harness, None))
    skill_overlay = overlays.get((harness, skill_name))
    overlay_fm: list[str] = []
    for overlay in (global_overlay, skill_overlay):
        if overlay:
            overlay_fm.extend(overlay[0])

    path = info["path"]  # type: ignore[assignment]
    if harness == "claude" or overlay_fm:
        fm_lines = list(info["fm_lines"])  # type: ignore[arg-type]
        body = str(info["body"])
        if harness == "claude":
            fm_lines, body = hoist_when_to_use(path, fm_lines, body)  # type: ignore[arg-type]
        if overlay_fm:
            existing: set[str] = set()
            for line in fm_lines:
                match = FIELD_RE.match(line.strip())
                if match:
                    existing.add(match.group(1))
            for line in overlay_fm:
                match = FIELD_RE.match(line.strip())
                key = match.group(1) if match else ""
                if key in existing:
                    fail(f"{path.relative_to(REPO_ROOT)}: overlay frontmatter key {key!r} collides with existing frontmatter")  # type: ignore[union-attr]
                existing.add(key)
                fm_lines.append(line if line.endswith("\n") else line + "\n")
        content = "---\n" + "".join(fm_lines) + "---\n" + body
    else:
        content = str(info["text"])
    if not content.endswith("\n"):
        content += "\n"

    sections = [
        "<!-- Generated by scripts/generate-skill-adapters.py. Do not edit directly. -->\n",
        "## Harness Adapter\n\n",
    ]
    global_body = global_overlay[1] if global_overlay else ""
    skill_body = skill_overlay[1] if skill_overlay else ""
    if global_body:
        sections.append(global_body)
        sections.append("\n")
    if skill_body:
        sections.append(skill_body)
        sections.append("\n")
    if not global_body and not skill_body:
        sections.append(f"### {harness}\n\nUse the canonical skill instructions above for this harness.\n")
    return content + "\n" + "".join(sections).rstrip() + "\n"


def generated_outputs() -> tuple[dict[Path, str], dict[str, object]]:
    skills = discover_skills()
    overlays = overlay_sources(skills)
    outputs: dict[Path, str] = {}
    manifest_skills: dict[str, object] = {}

    for skill_name, info in skills.items():
        targets = tuple(info["targets"])  # type: ignore[arg-type]
        source_path = info["path"]  # type: ignore[assignment]
        skill_outputs: dict[str, str] = {}
        skill_overlays: dict[str, list[str]] = {}
        for harness in targets:
            output = adapter_path(harness, skill_name)
            outputs[output] = compose_adapter(info, harness, skill_name, overlays)
            skill_outputs[harness] = rel(output)
            paths: list[str] = []
            global_path = OVERLAY_ROOT / "global" / f"{harness}.md"
            skill_path = OVERLAY_ROOT / "skills" / skill_name / f"{harness}.md"
            if global_path.is_file():
                paths.append(rel(global_path))
            if skill_path.is_file():
                paths.append(rel(skill_path))
            skill_overlays[harness] = paths
        manifest_skills[skill_name] = {
            "canonical": rel(source_path),  # type: ignore[arg-type]
            "targets": list(targets),
            "outputs": skill_outputs,
            "overlays": skill_overlays,
        }

    manifest = {
        "version": 1,
        "canonical_root": "skills",
        "overlay_root": rel(OVERLAY_ROOT),
        "targets": list(VALID_HARNESSES),
        "skills": manifest_skills,
    }
    return dict(sorted(outputs.items(), key=lambda item: rel(item[0]))), manifest


def unexpected_outputs(expected: set[Path]) -> list[Path]:
    extras: list[Path] = []
    for harness in VALID_HARNESSES:
        root = TEMPLATE_SKILLS_ROOT / harness
        if not root.exists():
            continue
        for path in sorted(root.rglob("SKILL.md")):
            if path not in expected:
                extras.append(path)
    return extras


def write_manifest(manifest: dict[str, object]) -> None:
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--write", action="store_true")
    args = parser.parse_args()

    outputs, manifest = generated_outputs()
    expected_paths = set(outputs)
    stale: list[str] = []

    for path, expected in outputs.items():
        if not path.is_file():
            stale.append(f"missing {path.relative_to(REPO_ROOT)}")
        elif path.read_text(encoding="utf-8") != expected:
            stale.append(f"stale {path.relative_to(REPO_ROOT)}")

    extras = unexpected_outputs(expected_paths)
    for path in extras:
        stale.append(f"unexpected {path.relative_to(REPO_ROOT)}")

    expected_manifest = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if not MANIFEST_PATH.is_file():
        stale.append(f"missing {MANIFEST_PATH.relative_to(REPO_ROOT)}")
    elif MANIFEST_PATH.read_text(encoding="utf-8") != expected_manifest:
        stale.append(f"stale {MANIFEST_PATH.relative_to(REPO_ROOT)}")

    if args.write:
        for path in extras:
            path.unlink()
            try:
                path.parent.rmdir()
            except OSError:
                pass
        for path, content in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
        write_manifest(manifest)
        print(f"wrote {len(outputs)} skill adapter files")
        if stale:
            print("updated stale outputs:", ", ".join(stale))
        return

    if stale:
        print("FAIL: generated skill adapters are stale:", file=sys.stderr)
        for item in stale:
            print(f"  - {item}", file=sys.stderr)
        print("Run: python3 scripts/generate-skill-adapters.py --write", file=sys.stderr)
        sys.exit(1)

    print(f"PASS: {len(outputs)} skill adapter files are current")


if __name__ == "__main__":
    main()
