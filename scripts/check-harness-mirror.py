#!/usr/bin/env python3
"""Check that the harness ids agree across the Rust backend, the TypeScript UI and the light descriptor.

The app keeps one list of harnesses in several places that no compiler connects:

  Rust   `HarnessId` (agent_targets.rs): the variants, `ALL`, `DEFAULT_ON`, `as_str`, `is_light`
  Rust   the skill read folders and load flags (skill_roots.rs, skill_loads.rs), the setup surfaces
         (setup_lifecycle.rs) and the target registry (agent_targets.rs `targets()`)
  JSON   resources/default-workspace/metadata/light-harnesses.json: the light tier's label and CLI
  TS     `CENTRAL_AGENTS`, `LIGHT_AGENTS`, `INSTALL_AGENTS` (types.ts), the surface, label and tab
         tables (harnessInstallation.ts), the view definitions (shell/views.ts), the page wiring
         (App.tsx)

A harness added in one place and forgotten in another shows up as a tab that renders nothing, a
Settings toggle that cannot be saved or a health row that never loads. This check compares them
and names the first mismatch of each kind. It only reads files; run it from anywhere.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

RUST_TARGETS = "src-tauri/src/agent_targets.rs"
RUST_LIFECYCLE = "src-tauri/src/setup_lifecycle.rs"
RUST_ROOTS = "src-tauri/src/skill_roots.rs"
RUST_LOADS = "src-tauri/src/skill_loads.rs"
RUST_LIB = "src-tauri/src/lib.rs"
DESCRIPTOR = "resources/default-workspace/metadata/light-harnesses.json"
TS_TYPES = "src/types.ts"
TS_INSTALL = "src/lib/harnessInstallation.ts"
TS_VIEWS = "src/shell/views.ts"
TS_APP = "src/App.tsx"
TS_HEALTH = "src/hooks/useWorkspaceHealthController.ts"

INPUTS = (
    RUST_TARGETS,
    RUST_LIFECYCLE,
    RUST_ROOTS,
    RUST_LOADS,
    RUST_LIB,
    DESCRIPTOR,
    TS_TYPES,
    TS_INSTALL,
    TS_VIEWS,
    TS_APP,
    TS_HEALTH,
)


class Mismatch(Exception):
    """One thing the checker could not find or that disagrees."""


# ── Rust ──


def snake_case(name: str) -> str:
    """serde's `rename_all = "snake_case"` for a CamelCase variant."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def serde_name(name: str, rename_all: str) -> str:
    if rename_all == "snake_case":
        return snake_case(name)
    if rename_all == "lowercase":
        return name.lower()
    raise Mismatch(f"unsupported serde rename_all {rename_all!r}")


def rust_enum(text: str, enum: str, where: str) -> tuple[list[str], str]:
    """Variant names (declaration order) and the `rename_all` rule of `pub enum <enum>`."""
    match = re.search(
        rf'((?:#\[[^\]]*\]\s*)*)pub enum {enum}\s*\{{(.*?)\n\}}', text, re.DOTALL
    )
    if not match:
        raise Mismatch(f"{where}: cannot find `pub enum {enum}`")
    rename = re.search(r'rename_all\s*=\s*"(\w+)"', match.group(1))
    if not rename:
        raise Mismatch(f"{where}: `{enum}` has no serde rename_all rule")
    body = re.sub(r"^\s*///.*$", "", match.group(2), flags=re.MULTILINE)
    body = re.sub(r"#\[[^\]]*\]", "", body)
    variants = re.findall(r"^\s*([A-Z]\w*)\s*[,(\{]", body, flags=re.MULTILINE)
    if not variants:
        raise Mismatch(f"{where}: `{enum}` has no variants")
    return variants, rename.group(1)


def rust_const_list(text: str, enum: str, const: str, where: str) -> list[str]:
    """`<enum>::X` entries, in order, of `const <const>: ... <enum> ... = [ ... ];`."""
    match = re.search(
        rf"const\s+{const}\s*:[^=]*\b{enum}\b[^=]*=\s*&?\[(.*?)\]\s*;", text, re.DOTALL
    )
    if not match:
        raise Mismatch(f"{where}: cannot find `const {const}` of {enum}")
    return re.findall(rf"{enum}::(\w+)", match.group(1))


def rust_fn_body(text: str, signature: str, where: str) -> str:
    start = text.find(signature)
    if start < 0:
        raise Mismatch(f"{where}: cannot find `{signature}`")
    depth, index = 0, text.index("{", start)
    for end in range(index, len(text)):
        depth += {"{": 1, "}": -1}.get(text[end], 0)
        if depth == 0:
            return text[index : end + 1]
    raise Mismatch(f"{where}: unbalanced braces after `{signature}`")


# ── TypeScript ──


def ts_union(text: str, name: str, where: str) -> list[str]:
    match = re.search(rf"export type {name}\s*=\s*(.*?);", text, re.DOTALL)
    if not match:
        raise Mismatch(f"{where}: cannot find `export type {name}`")
    return re.findall(r'"([^"]+)"', match.group(1))


def ts_array(text: str, name: str, where: str, known: dict[str, list[str]] | None = None) -> list[str]:
    """Strings of `export const NAME ... = [ "a", ...OTHER ]`; `...OTHER` resolves through `known`."""
    match = re.search(rf"(?:export )?const {name}\b[^=]*=\s*\[(.*?)\]", text, re.DOTALL)
    if not match:
        raise Mismatch(f"{where}: cannot find `const {name}`")
    values: list[str] = []
    for item in (part.strip() for part in match.group(1).split(",")):
        if not item:
            continue
        if item.startswith("..."):
            other = item[3:].strip()
            if known is None or other not in known:
                raise Mismatch(f"{where}: `{name}` spreads {other}, which is not a known list")
            values.extend(known[other])
        else:
            quoted = re.fullmatch(r'"([^"]+)"', item)
            if not quoted:
                raise Mismatch(f"{where}: `{name}` has an entry that is not a plain string: {item}")
            values.append(quoted.group(1))
    return values


def ts_record_keys(text: str, name: str, where: str) -> list[str]:
    """Keys of `export const NAME ... = { key: ..., }` (declared at two-space indent)."""
    match = re.search(rf"(?:export )?const {name}\b[^=]*=\s*\{{", text)
    if not match:
        raise Mismatch(f"{where}: cannot find `const {name}`")
    depth, start = 0, match.end() - 1
    for end in range(start, len(text)):
        depth += {"{": 1, "}": -1}.get(text[end], 0)
        if depth == 0:
            block = text[start : end + 1]
            return re.findall(r"^  (\w+):", block, flags=re.MULTILINE)
    raise Mismatch(f"{where}: unbalanced braces in `{name}`")


# ── The checks ──


def same_sequence(label: str, left_name: str, left: list[str], right_name: str, right: list[str]) -> None:
    if left != right:
        raise Mismatch(f"{label}: {left_name} {left} != {right_name} {right}")


def same_set(label: str, left_name: str, left: list[str], right_name: str, right: list[str]) -> None:
    if len(left) != len(set(left)):
        raise Mismatch(f"{label}: {left_name} lists a name twice: {left}")
    if len(right) != len(set(right)):
        raise Mismatch(f"{label}: {right_name} lists a name twice: {right}")
    if set(left) != set(right):
        only_left = sorted(set(left) - set(right))
        only_right = sorted(set(right) - set(left))
        raise Mismatch(
            f"{label}: {left_name} and {right_name} differ"
            f" (only in {left_name}: {only_left}; only in {right_name}: {only_right})"
        )


def check_harness_ids(root: Path) -> list[str]:
    """Returns the notes of a passing check; raises Mismatch."""

    def read(rel: str) -> str:
        return (root / rel).read_text(encoding="utf-8")

    targets = read(RUST_TARGETS)

    # Rust: the ids and which tier each is in.
    variants, rename = rust_enum(targets, "HarnessId", RUST_TARGETS)
    all_ids = rust_const_list(targets, "HarnessId", "ALL", RUST_TARGETS)
    same_sequence("HarnessId::ALL", "ALL", all_ids, "the enum", variants)
    default_on = rust_const_list(targets, "HarnessId", "DEFAULT_ON", RUST_TARGETS)
    as_str = rust_fn_body(targets, "pub fn as_str(self)", RUST_TARGETS)
    names = dict(re.findall(r'HarnessId::(\w+)\s*=>\s*"([^"]+)"', as_str))
    for variant in variants:
        if names.get(variant) != serde_name(variant, rename):
            raise Mismatch(
                f"HarnessId::as_str: {variant} is {names.get(variant)!r}, serde writes {serde_name(variant, rename)!r}"
            )
    light_body = rust_fn_body(targets, "pub fn is_light(self)", RUST_TARGETS)
    light = re.findall(r"HarnessId::(\w+)", light_body)
    same_set("HarnessId tiers", "DEFAULT_ON + is_light", default_on + light, "ALL", all_ids)
    wire = [names[variant] for variant in all_ids]
    wire_default = [names[variant] for variant in default_on]
    wire_light = [names[variant] for variant in all_ids if variant in light]

    # TypeScript: the same lists.
    types = read(TS_TYPES)
    central_ts = ts_array(types, "CENTRAL_AGENTS", TS_TYPES)
    light_ts = ts_array(types, "LIGHT_AGENTS", TS_TYPES)
    install_ts = ts_array(types, "INSTALL_AGENTS", TS_TYPES, {"CENTRAL_AGENTS": central_ts, "LIGHT_AGENTS": light_ts})
    same_sequence("INSTALL_AGENTS", "INSTALL_AGENTS", install_ts, "HarnessId::ALL", wire)
    same_sequence("CENTRAL_AGENTS", "CENTRAL_AGENTS", central_ts, "HarnessId::DEFAULT_ON", wire_default)
    same_sequence("LIGHT_AGENTS", "LIGHT_AGENTS", light_ts, "the light HarnessIds", wire_light)

    install = read(TS_INSTALL)
    if not re.search(
        r"export const DEFAULT_ENABLED_HARNESS_IDS\b[^=]*=\s*CENTRAL_AGENTS\s*;", install
    ):
        raise Mismatch(f"{TS_INSTALL}: DEFAULT_ENABLED_HARNESS_IDS must be CENTRAL_AGENTS (Rust HarnessId::DEFAULT_ON)")
    for table in ("HARNESS_SURFACES", "HARNESS_LABELS"):
        same_set(table, table, ts_record_keys(install, table, TS_INSTALL), "INSTALL_AGENTS", install_ts)
    nav = ts_array(install, "HARNESS_NAV_ORDER", TS_INSTALL)
    same_set("HARNESS_NAV_ORDER", "HARNESS_NAV_ORDER", nav, "INSTALL_AGENTS", install_ts)
    if [name for name in nav if name in light_ts] != light_ts or any(
        nav.index(name) < nav.index(central) for name in light_ts for central in central_ts
    ):
        raise Mismatch(
            f"HARNESS_NAV_ORDER {nav}: the light tier must follow the central harnesses, in LIGHT_AGENTS order,"
            " so the first tabs keep their numbers"
        )

    views = read(TS_VIEWS)
    same_set(
        "AppView",
        "AppView harness pages",
        [name for name in ts_union(views, "AppView", TS_VIEWS) if name in install_ts],
        "INSTALL_AGENTS",
        install_ts,
    )
    same_set("HARNESS_SHORT", "HARNESS_SHORT", ts_record_keys(views, "HARNESS_SHORT", TS_VIEWS), "INSTALL_AGENTS", install_ts)

    # The light descriptor.
    pairs: list[tuple[str, object]] = []

    def collect(items: list[tuple[str, object]]) -> dict[str, object]:
        pairs.extend(items)
        return dict(items)

    descriptor = json.loads(read(DESCRIPTOR), object_pairs_hook=collect)
    if descriptor.get("version") != 1:
        raise Mismatch(f"{DESCRIPTOR}: version must be 1")
    harnesses = descriptor.get("harnesses")
    if not isinstance(harnesses, dict):
        raise Mismatch(f"{DESCRIPTOR}: `harnesses` must be an object")
    keys = [key for key, value in pairs if isinstance(value, dict) and "cli" in value]
    same_set("light descriptor", "light-harnesses.json", keys, "LIGHT_AGENTS", light_ts)
    labels = dict(re.findall(r'^  (\w+):\s*"([^"]+)"', _block(install, "HARNESS_LABELS", TS_INSTALL), flags=re.MULTILINE))
    for key in light_ts:
        entry = harnesses[key]
        if entry.get("label") != labels.get(key):
            raise Mismatch(
                f"label of {key}: {DESCRIPTOR} says {entry.get('label')!r}, HARNESS_LABELS says {labels.get(key)!r}"
            )
        program = entry.get("cli", {}).get("program")
        if not isinstance(program, str) or not program:
            raise Mismatch(f"{DESCRIPTOR}: {key} has no cli.program")

    # Skills reach: the folders and flags the UI types must name.
    roots = read(RUST_ROOTS)
    folders, folder_rename = rust_enum(roots, "ReadFolder", RUST_ROOTS)
    folders_all = rust_const_list(roots, "ReadFolder", "ALL", RUST_ROOTS)
    same_set("ReadFolder::ALL", "ALL", folders_all, "the enum", folders)
    folders_wire = [serde_name(name, folder_rename) for name in folders]
    same_set("SkillReadFolder", "SkillReadFolder", ts_union(types, "SkillReadFolder", TS_TYPES), "ReadFolder", folders_wire)
    flags, flag_rename = rust_enum(read(RUST_LOADS), "SkillLoadFlag", RUST_LOADS)
    flags_wire = [serde_name(name, flag_rename) for name in flags]
    same_set("SkillLoadFlag", "SkillLoadFlag", ts_union(types, "SkillLoadFlag", TS_TYPES), "the Rust flags", flags_wire)

    # Surfaces and targets.
    surfaces, surface_rename = rust_enum(read(RUST_LIFECYCLE), "SetupSurfaceId", RUST_LIFECYCLE)
    surfaces_all = rust_const_list(read(RUST_LIFECYCLE), "SetupSurfaceId", "ALL", RUST_LIFECYCLE)
    if not set(surfaces_all) <= set(surfaces):
        raise Mismatch("SetupSurfaceId::ALL names a variant the enum does not have")
    same_set(
        "SetupSurfaceId",
        "TS SetupSurfaceId",
        ts_union(types, "SetupSurfaceId", TS_TYPES),
        "SetupSurfaceId::ALL",
        [serde_name(name, surface_rename) for name in surfaces_all],
    )
    registry = re.findall(r'^\s*id:\s*"(\w+)"', rust_fn_body(targets, "pub fn targets()", RUST_TARGETS), flags=re.MULTILINE)
    target_union = ts_union(install, "SetupTargetId", TS_INSTALL)
    same_set("SetupTargetId", "SetupTargetId", target_union, "targets()", registry)
    same_sequence(
        "TARGET_IDS_REGISTRY_ORDER",
        "TARGET_IDS_REGISTRY_ORDER",
        ts_array(install, "TARGET_IDS_REGISTRY_ORDER", TS_INSTALL),
        "targets()",
        registry,
    )
    same_set("TARGET_SURFACES", "TARGET_SURFACES", ts_record_keys(install, "TARGET_SURFACES", TS_INSTALL), "SetupTargetId", target_union)

    # Wiring: the page, the health loader and the command exist for every light harness.
    app = read(TS_APP)
    if "LightHarnessView" not in app or "LIGHT_AGENTS" not in app:
        raise Mismatch(f"{TS_APP}: the light harness pages must render through LightHarnessView over LIGHT_AGENTS")
    for key in light_ts:
        if not re.search(rf"\b{key}:\s*generation\s*=>\s*loadLightRuntimeHealth\(\"{key}\"", app):
            raise Mismatch(f"{TS_APP}: the health loader map has no entry for {key}")
    if "get_light_runtime_health" not in read(RUST_LIB) or "get_light_runtime_health" not in read(TS_HEALTH):
        raise Mismatch("get_light_runtime_health must be registered in lib.rs and invoked by the health controller")

    return [
        f"{len(wire)} harnesses ({len(wire_default)} central, {len(wire_light)} light) agree across Rust, TypeScript and the descriptor",
        f"{len(folders_wire)} skill folders, {len(flags_wire)} load flags, {len(surfaces_all)} surfaces, {len(registry)} targets",
    ]


def _block(text: str, name: str, where: str) -> str:
    match = re.search(rf"(?:export )?const {name}\b[^=]*=\s*\{{", text)
    if not match:
        raise Mismatch(f"{where}: cannot find `const {name}`")
    depth, start = 0, match.end() - 1
    for end in range(start, len(text)):
        depth += {"{": 1, "}": -1}.get(text[end], 0)
        if depth == 0:
            return text[start : end + 1]
    raise Mismatch(f"{where}: unbalanced braces in `{name}`")


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else REPO_ROOT
    missing = [rel for rel in INPUTS if not (root / rel).is_file()]
    if missing:
        print(f"FAIL: harness mirror inputs missing: {', '.join(missing)}", file=sys.stderr)
        return 1
    try:
        notes = check_harness_ids(root)
    except Mismatch as error:
        print(f"FAIL: harness mirror: {error}", file=sys.stderr)
        return 1
    for note in notes:
        print(f"  harness mirror: {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
