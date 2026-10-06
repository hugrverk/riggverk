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


def display(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def read_source(path: Path) -> str:
    """Read a canonical or overlay source, refusing BOM and CR line endings.

    Text-mode reads translate CRLF, so a CRLF source would pass --check while
    shipping scripts that split on LF would fail on it. Refuse instead.
    """
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        fail(f"{display(path)}: remove the UTF-8 BOM")
    if b"\r" in raw:
        fail(f"{display(path)}: use LF line endings (found CR)")
    return raw.decode("utf-8")


def parse_frontmatter(path: Path, text: str) -> tuple[dict[str, str], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        fail(f"{display(path)}: missing canonical frontmatter")
    end = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = index
            break
    if end is None:
        fail(f"{display(path)}: missing canonical frontmatter closing delimiter")

    fm_lines = [line + "\n" for line in lines[1:end]]
    fields: dict[str, str] = {}
    for index, line in enumerate(fm_lines):
        if line[:1] in (" ", "\t"):
            continue
        match = FIELD_RE.match(line.strip())
        if match:
            fields[match.group(1)] = field_text(fm_lines, index)
    frontmatter = "".join(fm_lines)
    return fields, frontmatter


def parse_targets(path: Path, raw: str) -> tuple[str, ...]:
    if not raw:
        fail(f"{display(path)}: missing targets frontmatter")
    value = raw.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    targets = tuple(
        item.strip().strip('"').strip("'")
        for item in value.split(",")
        if item.strip()
    )
    if not targets:
        fail(f"{display(path)}: empty targets frontmatter")
    unknown = sorted(set(targets) - set(VALID_HARNESSES))
    if unknown:
        fail(f"{display(path)}: unknown harness target(s): {unknown}")
    return targets


def validate_skill_name(path: Path, name: str) -> None:
    if not NAME_RE.fullmatch(name):
        fail(f"{display(path)}: invalid skill name: {name!r}")


def split_canonical(path: Path, text: str) -> tuple[list[str], str]:
    """Split canonical text into frontmatter lines (keepends) and body.

    Reconstruction must be byte-exact so untransformed adapters stay stable.
    """
    lines = text.splitlines(keepends=True)
    if not lines or lines[0] != "---\n":
        fail(f"{display(path)}: canonical frontmatter must open with '---'")
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            fm_lines = lines[1:index]
            body = "".join(lines[index + 1:])
            if "---\n" + "".join(fm_lines) + "---\n" + body != text:
                fail(f"{display(path)}: canonical frontmatter delimiters are not plain '---' lines")
            return fm_lines, body
    fail(f"{display(path)}: canonical frontmatter never closes")
    raise AssertionError("unreachable")


WHEN_TO_USE_HEADER = "## When To Use"
WHEN_TO_USE_CHAR_CAP = 1536


def field_block_end(fm_lines: list[str], index: int) -> int:
    """Return the index after a frontmatter field and its indented continuation.

    Block scalars (`>`, `|`) and multi-line plain scalars continue on indented
    or blank lines; a new field must not be inserted inside them.
    """
    end = index + 1
    while end < len(fm_lines) and (not fm_lines[end].strip() or fm_lines[end][:1] in (" ", "\t")):
        end += 1
    while end > index + 1 and not fm_lines[end - 1].strip():
        end -= 1
    return end


def field_text(fm_lines: list[str], index: int) -> str:
    """Return the logical text of the field at `index`, folding continuation lines."""
    match = FIELD_RE.match(fm_lines[index].strip())
    value = match.group(2) if match else ""
    end = field_block_end(fm_lines, index)
    continuation = [line.strip() for line in fm_lines[index + 1:end] if line.strip()]
    if value[:1] in (">", "|"):
        value = ""
    return " ".join([part for part in [value, *continuation] if part])


def find_field(fm_lines: list[str], key: str) -> int | None:
    for index, line in enumerate(fm_lines):
        if line[:1] in (" ", "\t"):
            continue
        match = FIELD_RE.match(line.strip())
        if match and match.group(1) == key:
            return index
    return None


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
        fail(f"{display(path)}: '{WHEN_TO_USE_HEADER}' section has no bullets to hoist")
    when_to_use = " ".join(item if item.endswith(".") else item + "." for item in bullets)
    description_index = find_field(fm_lines, "description")
    if description_index is None:
        fail(f"{display(path)}: cannot hoist when_to_use without a description field")
        raise AssertionError("unreachable")
    if find_field(fm_lines, "when_to_use") is not None:
        fail(f"{display(path)}: canonical frontmatter already has when_to_use; remove it or the '{WHEN_TO_USE_HEADER}' section")
    description = field_text(fm_lines, description_index)
    if len(description) + len(when_to_use) > WHEN_TO_USE_CHAR_CAP:
        fail(
            f"{display(path)}: description + when_to_use is "
            f"{len(description) + len(when_to_use)} chars (cap {WHEN_TO_USE_CHAR_CAP}); trim the section"
        )
    insert_at = field_block_end(fm_lines, description_index)
    new_fm = [*fm_lines[:insert_at], f"when_to_use: {json.dumps(when_to_use)}\n", *fm_lines[insert_at:]]
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
            fail(f"{display(skill_md)}: unsupported skill nesting")
        if any(part.startswith(".") for part in relative_parts):
            continue
        for candidate in (skill_md, *skill_md.parents):
            if candidate == SKILLS_ROOT.parent:
                break
            if candidate.exists() and candidate.is_symlink():
                fail(f"{display(candidate)}: refusing symlink skill path")

        text = read_source(skill_md)
        fields, frontmatter = parse_frontmatter(skill_md, text)
        fm_lines, body = split_canonical(skill_md, text)
        name = fields.get("name", "")
        description = fields.get("description", "")
        if not name:
            fail(f"{display(skill_md)}: missing name frontmatter")
        if not description:
            fail(f"{display(skill_md)}: missing description frontmatter")
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
    text = read_source(path)
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
            fail(f"{display(path)}: overlay frontmatter never closes")
        fm_lines = lines[1:closing]
        for line in fm_lines:
            if not FIELD_RE.match(line.strip()):
                fail(f"{display(path)}: overlay frontmatter line is not 'key: value': {line.strip()!r}")
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
                fail(f"{display(path)}: unknown overlay target {harness!r}")
            overlays[(harness, None)] = load_overlay(path)

    skills_dir = OVERLAY_ROOT / "skills"
    if skills_dir.exists():
        for skill_dir in sorted(child for child in skills_dir.iterdir() if child.is_dir()):
            skill_name = skill_dir.name
            if skill_name not in skills:
                fail(f"{display(skill_dir)}: unknown overlay skill {skill_name!r}")
            for path in sorted(skill_dir.glob("*.md")):
                harness = path.stem
                if harness not in VALID_HARNESSES:
                    fail(f"{display(path)}: unknown overlay target {harness!r}")
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
                match = FIELD_RE.match(line) if line[:1] not in (" ", "\t") else None
                if match:
                    existing.add(match.group(1))
            for line in overlay_fm:
                match = FIELD_RE.match(line.strip())
                key = match.group(1) if match else ""
                if key in existing:
                    fail(f"{display(path)}: overlay frontmatter key {key!r} collides with existing frontmatter")  # type: ignore[union-attr]
                existing.add(key)
                fm_lines.append(line if line.endswith("\n") else line + "\n")
        content = "---\n" + "".join(fm_lines) + "---\n" + body
    else:
        content = str(info["text"])
    if not content.endswith("\n"):
        content += "\n"

    sections = ["<!-- Generated by scripts/generate-skill-adapters.py. Do not edit directly. -->\n"]
    global_body = global_overlay[1] if global_overlay else ""
    skill_body = skill_overlay[1] if skill_overlay else ""
    if global_body or skill_body:
        sections.append("## Harness Adapter\n\n")
    if global_body:
        sections.append(global_body)
        sections.append("\n")
    if skill_body:
        sections.append(skill_body)
        sections.append("\n")
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
    MANIFEST_PATH.write_bytes((json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8"))


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
            stale.append(f"missing {display(path)}")
        elif path.read_bytes() != expected.encode("utf-8"):
            stale.append(f"stale {display(path)}")

    extras = unexpected_outputs(expected_paths)
    for path in extras:
        stale.append(f"unexpected {display(path)}")

    expected_manifest = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if not MANIFEST_PATH.is_file():
        stale.append(f"missing {display(MANIFEST_PATH)}")
    elif MANIFEST_PATH.read_bytes() != expected_manifest.encode("utf-8"):
        stale.append(f"stale {display(MANIFEST_PATH)}")

    if args.write:
        for path in extras:
            path.unlink()
            try:
                path.parent.rmdir()
            except OSError:
                pass
        for path, content in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.encode("utf-8"))
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
