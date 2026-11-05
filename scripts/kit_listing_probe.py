#!/usr/bin/env python3
"""Ask each harness what it lists of the bundled skills, with no model call.

Runs Claude Code, Codex, OpenCode and Kilo from a throwaway HOME holding only the bundled kit, and
reports per skill whether the description is full, shortened, gone or the skill is missing, plus
what the kit adds to the always-loaded prompt. check-skill-routing.py counts the kit's own
characters; this shows what a harness does with them.

How far each answer goes: Codex shows the prompt itself. Claude Code shows token estimates, so its
"full" means the row is about the size of the description. OpenCode and Kilo show what they
discovered, not what reaches the prompt.

Harnesses can still contact their vendors (model catalogs, telemetry) with a placeholder key.

Not part of release-check.sh: it depends on the installed harnesses and their output formats. Run
it before a release and after upgrading a harness (docs/MAINTAINING.md).

Exit codes: 0 pass, 1 a default setup does not list the kit in full, 2 the probe itself is invalid
(a harness is missing, a control failed, a model was retired, or the output was unreadable).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT_SKILLS = ROOT / "resources/default-workspace/skills"
SYNC_RULES = ROOT / "resources/default-workspace/templates/sync"
TIMEOUT_SECONDS = 120

# Never a usable credential, and an address nothing listens on: a call that tried to reach a model
# would fail instead of being charged.
PLACEHOLDER_KEY = "placeholder-not-a-key"
DEAD_BASE_URL = "http://127.0.0.1:9"

# Model name and the context window it must report. A retired or mistyped name still answers, with
# another window and every description gone, so the window tells that apart from a kit problem.
CLAUDE_DEFAULT_MODELS = {"claude-opus-5-5": "1m", "claude-sonnet-5-5": "1m"}
# Claude Code's skill listing budget is 1% of the window, shared with its built-in skills, so on
# these most descriptions drop. Reported as a known limit (docs/TROUBLESHOOTING.md).
CLAUDE_SMALL_WINDOW_MODELS = {"claude-sonnet-4-6": "200k", "claude-haiku-4-5": "200k"}
CODEX_DEFAULT_MODEL = "gpt-6.1-terra"
HARNESSES = ("claude", "codex", "opencode", "kilo")

FULL, SHORTENED, NAME_ONLY = "full", "shortened", "name-only"
# Harnesses walk up from their working folder and would load any of these above it.
PROJECT_MARKERS = (".git", ".claude", ".agents", ".codex", ".opencode", ".kilo", "CLAUDE.md", "AGENTS.md")
CODEX_SKILL_LINE = re.compile(r"^- ([a-z0-9][a-z0-9-]*):\s*(.*?)\s*\(file: [^)]*\)$", re.MULTILINE)
CLAUDE_WINDOW = re.compile(r"\*\*Tokens:\*\*\s*[\d.]+[km]?\s*/\s*([\d.]+[km]?)")
TOKEN_COUNT = re.compile(r"([\d.]+)([km]?)")


class ProbeError(Exception):
    """The probe cannot trust this run; says nothing about the kit."""


@dataclass
class Skill:
    description: str
    user_only: bool


@dataclass
class Listing:
    statuses: dict[str, str] = field(default_factory=dict)
    size: float = 0
    window: str = ""
    rules_tokens: float = 0


def read_kit(skills_dir: Path) -> dict[str, Skill]:
    kit: dict[str, Skill] = {}
    for skill_file in sorted(skills_dir.glob("*/SKILL.md")):
        parts = skill_file.read_text(encoding="utf-8").split("---", 2)
        if len(parts) < 3:
            raise ProbeError(f"no frontmatter in {skill_file}")
        match = re.search(r"^description:\s*(.*)$", parts[1], re.MULTILINE)
        if not match:
            raise ProbeError(f"no description in {skill_file}")
        kit[skill_file.parent.name] = Skill(
            description=match.group(1).strip().strip("\"'"),
            user_only=re.search(r"^disable-model-invocation:\s*true\s*$", parts[1], re.MULTILINE) is not None,
        )
    if not kit:
        raise ProbeError(f"no skills under {skills_dir}")
    return kit


def compare_description(listed: str, source: str) -> str:
    listed = listed.strip()
    if listed == source:
        return FULL
    if not listed:
        return NAME_ONLY
    return SHORTENED if source.startswith(listed) else "differs"


def tokens(cell: str) -> float:
    match = TOKEN_COUNT.search(cell)
    if not match:
        raise ProbeError(f"claude: unreadable token count {cell!r}")
    return float(match.group(1)) * {"": 1, "k": 1_000, "m": 1_000_000}[match.group(2)]


def claude_row_status(name: str, cell: str, kit: dict[str, Skill]) -> str:
    """`< 20` tokens means only the name is left: a listing keeps names and drops descriptions over
    budget. Rows are estimates rounded to tens, about a quarter of the characters, so this catches
    a description cut to a third of its length, not a small cut."""
    if name not in kit:
        return "not in kit"
    if cell.startswith("<"):
        return NAME_ONLY
    return FULL if tokens(cell) + 10 >= len(kit[name].description) / 4 else SHORTENED


def parse_claude_context(raw: str, kit: dict[str, Skill]) -> Listing:
    """Skills and rules come from their own rows: the Tokens total does not follow them."""
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise ProbeError(f"claude: output is not JSON ({error})") from error
    if data.get("is_error"):
        raise ProbeError("claude: reported an error")
    if data.get("total_cost_usd") != 0 or data.get("num_turns") != 0:
        raise ProbeError(f"claude: expected no charge and no turns, got {data.get('total_cost_usd')} and {data.get('num_turns')}")
    text = data.get("result", "")
    window = CLAUDE_WINDOW.search(text)
    if not window:
        raise ProbeError("claude: /context has no Tokens line")
    listing = Listing(window=window.group(1))
    overview, _, skills = text.partition("### Skills")
    for line in overview.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) == 3 and cells[0] == "Skills":
            listing.size += tokens(cells[1])
        elif len(cells) == 3 and cells[0] == "Memory files":
            listing.size += tokens(cells[1])
            listing.rules_tokens = tokens(cells[1])
    for line in skills.split("\n###", 1)[0].splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) == 3 and cells[2] != "Tokens" and not cells[2].startswith("-") and cells[1] != "Built-in":
            listing.statuses[cells[0]] = claude_row_status(cells[0], cells[2], kit)
    return listing


def parse_codex_prompt(raw: str, kit: dict[str, Skill]) -> Listing:
    try:
        items = json.loads(raw)
    except ValueError as error:
        raise ProbeError(f"codex: output is not JSON ({error})") from error
    if not isinstance(items, list):
        raise ProbeError("codex: expected a list of prompt items")
    listing = Listing(size=len(raw))
    for item in items:
        for part in item.get("content") or [] if isinstance(item, dict) else []:
            text = part.get("text", "") if isinstance(part, dict) else ""
            if "<skills_instructions>" not in text:
                continue
            for name, listed in CODEX_SKILL_LINE.findall(text):
                if name in kit:
                    listing.statuses[name] = compare_description(listed, kit[name].description)
    return listing


def parse_skill_discovery(raw: str, harness: str, kit: dict[str, Skill]) -> Listing:
    """`debug skill` shows what was discovered, not what reaches the prompt: no size, no budget."""
    try:
        entries = json.loads(raw)
    except ValueError as error:
        raise ProbeError(f"{harness}: output is not JSON ({error})") from error
    if not isinstance(entries, list):
        raise ProbeError(f"{harness}: expected a list of skills")
    listing = Listing()
    for entry in entries:
        name = entry.get("name", "")
        if name in kit and entry.get("location", "").endswith(f"/{name}/SKILL.md"):
            listing.statuses[name] = compare_description(entry.get("description", ""), kit[name].description)
    return listing


def not_listed_in_full(kit: dict[str, Skill], statuses: dict[str, str], honors_user_only: bool) -> list[str]:
    """What a harness should show: everything, minus user-only skills if it honors the flag."""
    problems = []
    for name, skill in kit.items():
        status = statuses.get(name, "missing")
        if honors_user_only and skill.user_only:
            if status != "missing":
                problems.append(f"{name}: user-only but listed")
        elif status != FULL:
            problems.append(f"{name}: {status}")
    return problems


def count(statuses: dict[str, str]) -> str:
    totals: dict[str, int] = {}
    for status in statuses.values():
        totals[status] = totals.get(status, 0) + 1
    return ", ".join(f"{totals[key]} {key}" for key in sorted(totals)) or "none"


def refuse_unsafe_base(base: Path, real_home: Path) -> None:
    if base.is_relative_to(real_home):
        raise ProbeError(f"isolation: temp folder {base} is inside the real home; set TMPDIR elsewhere")
    for parent in base.parents:
        for marker in PROJECT_MARKERS:
            if (parent / marker).exists():
                raise ProbeError(f"isolation: harnesses would load {parent / marker} above the temp folder; set TMPDIR elsewhere")


class Sandbox:
    """A throwaway HOME and an empty working folder. Nothing from the caller's environment passes
    except PATH, so a harness cannot see real credentials, config or a real Riggverk."""

    def __init__(self, base: Path, label: str, with_kit: bool, skills_dir: Path, rules: dict[str, str]) -> None:
        self.base = base
        self.home = base / label / "home"
        self.cwd = base / label / "cwd"
        self.home.mkdir(parents=True)
        self.cwd.mkdir()
        (self.home / ".codex").mkdir()
        (self.home / ".claude").mkdir()
        if with_kit:
            for folder in (".claude/skills", ".agents/skills"):
                shutil.copytree(skills_dir, self.home / folder)
            for relative, template in rules.items():
                shutil.copyfile(SYNC_RULES / template, self.home / relative)

    def env(self) -> dict[str, str]:
        return {
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", ""),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_STATE_HOME": str(self.home / ".local/state"),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "CODEX_HOME": str(self.home / ".codex"),
            # Also what Claude Code keys its keychain entry on, so it is not the real one.
            "CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
            "ANTHROPIC_API_KEY": PLACEHOLDER_KEY,
            "ANTHROPIC_BASE_URL": DEAD_BASE_URL,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        }

    def run(self, argv: list[str], extra: dict[str, str] | None = None) -> str:
        # To a file, not a pipe: OpenCode cuts its output off when stdout is a pipe.
        output = self.base / "stdout.txt"
        with output.open("wb") as stdout:
            try:
                done = subprocess.run(
                    argv,
                    cwd=self.cwd,
                    env={**self.env(), **(extra or {})},
                    stdin=subprocess.DEVNULL,
                    stdout=stdout,
                    stderr=subprocess.DEVNULL,
                    timeout=TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired as error:
                raise ProbeError(f"{Path(argv[0]).name}: timed out after {TIMEOUT_SECONDS} s") from error
        if done.returncode != 0:
            raise ProbeError(f"{Path(argv[0]).name}: exit {done.returncode}")
        return output.read_text(encoding="utf-8")


@dataclass
class Report:
    failures: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)

    def record(self, setup: str, listing: Listing) -> None:
        self.lines.append(f"  {setup}: {count(listing.statuses)}")

    def record_size(self, what: str, with_kit: Listing, without_kit: Listing) -> None:
        added = with_kit.size - without_kit.size
        self.lines.append(f"  {what}: {without_kit.size:,.0f} without the kit, {with_kit.size:,.0f} with it (+{added:,.0f})")


def require_empty(listing: Listing, harness: str) -> None:
    if listing.statuses or listing.rules_tokens:
        raise ProbeError(f"{harness}: control failed, a home with no kit lists {sorted(listing.statuses)} and {listing.rules_tokens:.0f} tokens of rules")


def require_kit_visible(listing: Listing, harness: str) -> None:
    if not listing.statuses:
        raise ProbeError(f"{harness}: control failed, the kit is not visible at all, so the output format may have changed")


def require_shortened(listing: Listing, harness: str) -> None:
    if not set(listing.statuses.values()) - {FULL}:
        raise ProbeError(f"{harness}: control failed, a tiny listing budget shortened nothing, so this probe cannot see shortening")


def probe_claude(binary: str, base: Path, skills_dir: Path, kit: dict[str, Skill], report: Report) -> None:
    rules = {".claude/CLAUDE.md": "claude-rules.md"}
    kit_box = Sandbox(base, "claude-kit", True, skills_dir, rules)
    empty_box = Sandbox(base, "claude-empty", False, skills_dir, rules)

    def context(box: Sandbox, model: str, window: str, extra: dict[str, str] | None = None) -> Listing:
        listing = parse_claude_context(box.run([binary, "-p", "/context", "--output-format", "json", "--model", model], extra), kit)
        if listing.window != window:
            raise ProbeError(f"claude: {model} reports a {listing.window} window, expected {window}; if it was retired or changed, update the models in this script")
        return listing

    first_model, first_window = next(iter(CLAUDE_DEFAULT_MODELS.items()))
    empty = context(empty_box, first_model, first_window)
    require_empty(empty, "claude")
    require_shortened(context(kit_box, first_model, first_window, {"SLASH_COMMAND_TOOL_CHAR_BUDGET": "100"}), "claude")

    for model, window in CLAUDE_DEFAULT_MODELS.items():
        listing = context(kit_box, model, window)
        require_kit_visible(listing, "claude")
        report.record(model, listing)
        report.failures += [f"claude {model}: {problem}" for problem in not_listed_in_full(kit, listing.statuses, honors_user_only=True)]
        if model == first_model:
            report.record_size("tokens for skills and rules, estimated", listing, empty)
    for model, window in CLAUDE_SMALL_WINDOW_MODELS.items():
        listing = context(kit_box, model, window)
        require_kit_visible(listing, "claude")
        report.record(f"{model} (known limit, {window} window)", listing)


def probe_codex(binary: str, base: Path, skills_dir: Path, kit: dict[str, Skill], report: Report) -> None:
    rules = {".codex/AGENTS.md": "codex-rules.md"}
    kit_box = Sandbox(base, "codex-kit", True, skills_dir, rules)
    empty_box = Sandbox(base, "codex-empty", False, skills_dir, rules)

    def prompt(box: Sandbox, *config: str) -> Listing:
        argv = [binary, "debug", "prompt-input", "-c", f'model="{CODEX_DEFAULT_MODEL}"']
        for item in config:
            argv += ["-c", item]
        return parse_codex_prompt(box.run([*argv, "probe"]), kit)

    empty = prompt(empty_box)
    require_empty(empty, "codex")
    require_shortened(prompt(kit_box, "skills.max_context_tokens=1000"), "codex")
    listing = prompt(kit_box)
    require_kit_visible(listing, "codex")
    report.record(CODEX_DEFAULT_MODEL, listing)
    report.record_size("characters in the whole prompt", listing, empty)
    report.failures += [f"codex: {problem}" for problem in not_listed_in_full(kit, listing.statuses, honors_user_only=False)]


def probe_discovery(harness: str, binary: str, base: Path, skills_dir: Path, kit: dict[str, Skill], report: Report) -> None:
    kit_box = Sandbox(base, f"{harness}-kit", True, skills_dir, {})
    empty_box = Sandbox(base, f"{harness}-empty", False, skills_dir, {})
    require_empty(parse_skill_discovery(empty_box.run([binary, "debug", "skill"]), harness, kit), harness)
    listing = parse_skill_discovery(kit_box.run([binary, "debug", "skill"]), harness, kit)
    require_kit_visible(listing, harness)
    report.record("discovered", listing)
    report.failures += [f"{harness}: {problem}" for problem in not_listed_in_full(kit, listing.statuses, honors_user_only=False)]


def run_probe(names: tuple[str, ...], skills_dir: Path, report: Report) -> None:
    kit = read_kit(skills_dir)
    binaries = {name: shutil.which(name) for name in names}
    missing = [name for name, binary in binaries.items() if not binary]
    if missing:
        raise ProbeError(f"not on PATH: {', '.join(missing)}. A partial run is not a pass; choose what to run with --harness")
    with tempfile.TemporaryDirectory(prefix="riggverk-kit-probe-") as folder:
        base = Path(folder).resolve()
        refuse_unsafe_base(base, Path.home().resolve())
        for name, binary in binaries.items():
            report.lines.append(f"{name}:")
            if name == "claude":
                probe_claude(binary, base, skills_dir, kit, report)
            elif name == "codex":
                probe_codex(binary, base, skills_dir, kit, report)
            else:
                probe_discovery(name, binary, base, skills_dir, kit, report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--harness", default=",".join(HARNESSES), help="comma-separated, default all four")
    args = parser.parse_args(argv)
    names = tuple(name for name in args.harness.split(",") if name)
    unknown = sorted(set(names) - set(HARNESSES))
    if unknown or not names:
        parser.error(f"choose from {', '.join(HARNESSES)}")

    report = Report()
    try:
        run_probe(names, KIT_SKILLS, report)
    except Exception as error:  # Any crash says nothing about the kit, so it must not exit 1.
        print("\n".join(report.lines))
        print(f"INVALID: {error}", file=sys.stderr)
        return 2
    print("\n".join(report.lines))
    if report.failures:
        print("FAIL:", *report.failures, sep="\n  ", file=sys.stderr)
        return 1
    print(f"kit listing probe passed: {', '.join(dict.fromkeys(names))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
