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
            "targets": targets,
        }
    if not discovered:
        fail("no canonical skills found")
    return dict(sorted(discovered.items()))


def load_overlay(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    return text.strip() + "\n"


def overlay_sources(skills: dict[str, dict[str, object]]) -> dict[tuple[str, str | None], str]:
    overlays: dict[tuple[str, str | None], str] = {}
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


def compose_adapter(canonical: str, harness: str, skill_name: str, overlays: dict[tuple[str, str | None], str]) -> str:
    content = canonical if canonical.endswith("\n") else canonical + "\n"
    sections = [
        "<!-- Generated by scripts/generate-skill-adapters.py. Do not edit directly. -->\n",
        "## Harness Adapter\n\n",
    ]
    global_overlay = overlays.get((harness, None))
    skill_overlay = overlays.get((harness, skill_name))
    if global_overlay:
        sections.append(global_overlay)
        sections.append("\n")
    if skill_overlay:
        sections.append(skill_overlay)
        sections.append("\n")
    if not global_overlay and not skill_overlay:
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
        canonical = str(info["text"])
        skill_outputs: dict[str, str] = {}
        skill_overlays: dict[str, list[str]] = {}
        for harness in targets:
            output = adapter_path(harness, skill_name)
            outputs[output] = compose_adapter(canonical, harness, skill_name, overlays)
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
