#!/usr/bin/env python3
"""The kit listing probe reads each harness's output correctly, keeps the caller's environment and
home away from it, and exits 2 instead of reporting on the kit when it cannot trust a run."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("kit_listing_probe", ROOT / "scripts/kit_listing_probe.py")
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
sys.modules["kit_listing_probe"] = probe
SPEC.loader.exec_module(probe)

KIT = {
    "alpha": probe.Skill("A" * 280, False),
    "beta": probe.Skill("Beta does b. Use when b.", False),
    "retro": probe.Skill("Retro does r. Use when r.", True),
}


def claude_output(overview: str = "", rows: str = "", window: str = "1m", cost: float = 0, turns: int = 0) -> str:
    result = f"**Tokens:** 17k / {window} (2%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n{overview}\n### Skills\n\n| Skill | Source | Tokens |\n|---|---|---|\n{rows}\n### Next\n| other | User | ~50 |\n"
    return json.dumps({"is_error": False, "total_cost_usd": cost, "num_turns": turns, "result": result})


class ParserTest(unittest.TestCase):
    def test_claude_row_size_tells_full_from_shortened_and_name_only(self) -> None:
        rows = "| alpha | User | ~70 |\n| beta | User | < 20 |\n| retro | User | ~40 |\n| security-review | Built-in | ~20 |\n"
        statuses = probe.parse_claude_context(claude_output(rows=rows), KIT).statuses
        self.assertEqual(statuses, {"alpha": probe.FULL, "beta": probe.NAME_ONLY, "retro": probe.FULL})
        cut = probe.parse_claude_context(claude_output(rows="| alpha | User | ~40 |\n"), KIT).statuses
        self.assertEqual(cut, {"alpha": probe.SHORTENED})

    def test_claude_size_is_the_skills_and_rules_rows_not_the_total(self) -> None:
        overview = "| System tools | 13k | 1% |\n| Memory files | 2.7k | 0.3% |\n| Skills | 4.6k | 0.5% |\n"
        listing = probe.parse_claude_context(claude_output(overview), KIT)
        self.assertEqual((round(listing.size), listing.rules_tokens, listing.window), (7300, 2700, "1m"))

    def test_claude_rows_from_outside_the_kit_are_kept_so_a_control_can_see_them(self) -> None:
        rows = "| leaked | Project | ~80 |\n"
        self.assertEqual(probe.parse_claude_context(claude_output(rows=rows), KIT).statuses, {"leaked": "not in kit"})

    def test_claude_charge_turn_error_or_missing_field_makes_the_run_invalid(self) -> None:
        for kwargs in ({"cost": 0.01}, {"turns": 1}):
            with self.assertRaisesRegex(probe.ProbeError, "no charge"):
                probe.parse_claude_context(claude_output(**kwargs), KIT)
        with self.assertRaisesRegex(probe.ProbeError, "no charge"):
            probe.parse_claude_context(json.dumps({"result": ""}), KIT)
        with self.assertRaisesRegex(probe.ProbeError, "error"):
            probe.parse_claude_context(json.dumps({"is_error": True}), KIT)

    def test_claude_without_a_tokens_line_is_invalid(self) -> None:
        output = json.dumps({"is_error": False, "total_cost_usd": 0, "num_turns": 0, "result": "### Skills\n"})
        with self.assertRaisesRegex(probe.ProbeError, "Tokens"):
            probe.parse_claude_context(output, KIT)

    def test_codex_compares_lines_in_the_skills_block_with_the_source(self) -> None:
        block = textwrap.dedent(
            f"""\
            <skills_instructions>
            - alpha: {KIT["alpha"].description} (file: r0/alpha/SKILL.md)
            - beta: Beta does  (file: r0/beta/SKILL.md)
            - retro: (file: r0/retro/SKILL.md)
            - openai-docs: Not ours. (file: r1/openai-docs/SKILL.md)
            </skills_instructions>
            """
        )
        elsewhere = {"text": "- alpha: Mentioned elsewhere. (file: r0/alpha/SKILL.md)"}
        raw = json.dumps([{"type": "additional_tools"}, {"content": [elsewhere, {"text": block}]}])
        listing = probe.parse_codex_prompt(raw, KIT)
        self.assertEqual(listing.statuses, {"alpha": probe.FULL, "beta": probe.SHORTENED, "retro": probe.NAME_ONLY})
        self.assertEqual(probe.parse_codex_prompt(json.dumps([{"content": [elsewhere]}]), KIT).statuses, {})

    def test_discovery_ignores_built_ins_and_flags_a_changed_description(self) -> None:
        raw = json.dumps(
            [
                {"name": "alpha", "description": KIT["alpha"].description, "location": "/h/.agents/skills/alpha/SKILL.md"},
                {"name": "beta", "description": "Rewritten.", "location": "/h/.claude/skills/beta/SKILL.md"},
                {"name": "retro", "description": "Built-in with our name.", "location": "<built-in>"},
            ]
        )
        self.assertEqual(probe.parse_skill_discovery(raw, "kilo", KIT).statuses, {"alpha": probe.FULL, "beta": "differs"})


class ExpectationTest(unittest.TestCase):
    def test_a_harness_honoring_the_flag_must_hide_user_only_skills(self) -> None:
        statuses = {"alpha": probe.FULL, "beta": probe.FULL}
        self.assertEqual(probe.not_listed_in_full(KIT, statuses, honors_user_only=True), [])
        self.assertEqual(
            probe.not_listed_in_full(KIT, {**statuses, "retro": probe.FULL}, honors_user_only=True),
            ["retro: user-only but listed"],
        )

    def test_other_harnesses_must_list_everything_in_full(self) -> None:
        statuses = {"alpha": probe.FULL, "beta": probe.NAME_ONLY}
        self.assertEqual(
            probe.not_listed_in_full(KIT, statuses, honors_user_only=False),
            ["beta: name-only", "retro: missing"],
        )

    def test_read_kit_takes_description_and_flag_from_frontmatter(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            skill = Path(folder) / "retro"
            skill.mkdir()
            (skill / "SKILL.md").write_text(
                '---\nname: retro\ndescription: "Quoted. Use when r."\ndisable-model-invocation: true\n---\nBody --- text\n',
                encoding="utf-8",
            )
            self.assertEqual(probe.read_kit(Path(folder)), {"retro": probe.Skill("Quoted. Use when r.", True)})


class BaseFolderTest(unittest.TestCase):
    def test_refuses_a_temp_folder_inside_the_home_or_below_a_project(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            base = root / "tmp" / "run"
            base.mkdir(parents=True)
            probe.refuse_unsafe_base(base, root / "home")
            with self.assertRaisesRegex(probe.ProbeError, "inside the real home"):
                probe.refuse_unsafe_base(base, root)
            for marker in (".git", ".agents", "CLAUDE.md", "AGENTS.md"):
                (root / marker).touch()
                with self.assertRaisesRegex(probe.ProbeError, "above the temp folder"):
                    probe.refuse_unsafe_base(base, root / "home")
                (root / marker).unlink()


PRELUDE = """#!{python}
import json, os, sys
with open({seen!r}, "a") as out:
    out.write(json.dumps({{"env": dict(os.environ), "argv": sys.argv, "cwd": os.getcwd()}}) + "\\n")
home = os.environ["HOME"]
kit_skills = os.path.isdir(os.path.join(home, ".agents/skills"))
"""
CLAUDE_BODY = """
model = sys.argv[sys.argv.index("--model") + 1]
window = "1m" if "5-5" in model else "200k"
rules = os.path.exists(os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "CLAUDE.md"))
rows = {kit_rows!r} if kit_skills else ""
if os.environ.get("SLASH_COMMAND_TOOL_CHAR_BUDGET"):
    rows = {tiny_rows!r}
overview = "| Skills | " + ("4k" if kit_skills else "1k") + " | 1% |\\n" + ("| Memory files | 2k | 1% |\\n" if rules else "")
result = "**Tokens:** 17k / " + window + " (2%)\\n" + overview + "### Skills\\n" + rows
print(json.dumps({{"is_error": False, "total_cost_usd": 0, "num_turns": 0, "result": result}}))
"""
CODEX_BODY = """
short = any("max_context_tokens" in arg for arg in sys.argv)
rules = os.path.exists(os.path.join(os.environ["CODEX_HOME"], "AGENTS.md"))
lines = {kit_lines!r} if kit_skills else []
if short:
    lines = {short_lines!r}
text = "<skills_instructions>\\n" + "\\n".join(lines) + "\\n</skills_instructions>" + ("x" * 500 if rules else "")
print(json.dumps([{{"content": [{{"text": text}}]}}]))
"""
DISCOVERY_BODY = """
entries = {entries!r} if kit_skills else [{{"name": "builtin", "description": "x", "location": "<built-in>"}}]
print(json.dumps(entries))
"""


class FakeHarnessTest(unittest.TestCase):
    """Runs the real probe flow against stand-in executables on PATH."""

    SMALL_KIT = {"alpha": "Alpha does a. Use when a.", "retro": "Retro does r. Use when r."}

    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.seen = self.root / "seen.jsonl"
        self.skills = self.root / "skills"
        for name, description in self.SMALL_KIT.items():
            (self.skills / name).mkdir(parents=True)
            flag = "disable-model-invocation: true\n" if name == "retro" else ""
            (self.skills / name / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {description}\n{flag}---\n", encoding="utf-8")
        self.discovered = [
            {"name": name, "description": description, "location": f"/h/.agents/skills/{name}/SKILL.md"}
            for name, description in self.SMALL_KIT.items()
        ]

    def install(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(PRELUDE.format(python=sys.executable, seen=str(self.seen)) + body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def install_claude(self, kit_rows: str = "| alpha | User | ~80 |\n", tiny_rows: str = "| alpha | User | < 20 |\n") -> None:
        self.install("claude", CLAUDE_BODY.format(kit_rows=kit_rows, tiny_rows=tiny_rows))

    def install_codex(self, kit_lines: list[str] | None = None, short_lines: list[str] | None = None) -> None:
        full = [f"- {name}: {description} (file: r0/{name}/SKILL.md)" for name, description in self.SMALL_KIT.items()]
        cut = ["- alpha: Alpha  (file: r0/alpha/SKILL.md)"]
        self.install("codex", CODEX_BODY.format(kit_lines=full if kit_lines is None else kit_lines, short_lines=cut if short_lines is None else short_lines))

    def install_discovery(self, name: str = "kilo", entries: list[dict[str, str]] | None = None) -> None:
        self.install(name, DISCOVERY_BODY.format(entries=self.discovered if entries is None else entries))

    def main(self, harness: str) -> tuple[int, str, str]:
        environ = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "SECRET_FROM_CALLER": "canary", "HOME": str(self.root / "real-home")}
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, environ, clear=True), mock.patch.object(probe, "KIT_SKILLS", self.skills):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = probe.main(["--harness", harness])
        return code, out.getvalue(), err.getvalue()

    def calls(self) -> list[dict]:
        return [json.loads(line) for line in self.seen.read_text(encoding="utf-8").splitlines()]

    def test_every_harness_gets_only_a_throwaway_home_and_no_caller_environment(self) -> None:
        self.install_claude()
        self.install_codex()
        self.install_discovery("opencode")
        self.install_discovery("kilo")
        code, _, err = self.main("claude,codex,opencode,kilo")
        self.assertEqual((code, err), (0, ""))
        calls = self.calls()
        self.assertGreaterEqual(len(calls), 11)
        for call in calls:
            env = call["env"]
            self.assertNotIn("SECRET_FROM_CALLER", env)
            self.assertIn("riggverk-kit-probe-", call["cwd"])
            self.assertEqual(env["ANTHROPIC_API_KEY"], probe.PLACEHOLDER_KEY)
            self.assertEqual(env["ANTHROPIC_BASE_URL"], probe.DEAD_BASE_URL)
            for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"):
                self.assertTrue(env[key].startswith(env["HOME"]), key)
            self.assertIn("riggverk-kit-probe-", env["HOME"])

    def test_claude_passes_and_reports_size_and_the_small_window_limit(self) -> None:
        self.install_claude()
        code, out, _ = self.main("claude")
        self.assertEqual(code, 0)
        self.assertIn("1,000 without the kit, 6,000 with it (+5,000)", out)
        self.assertIn("claude-sonnet-4-6 (known limit, 200k window): 1 full", out)

    def test_claude_default_model_losing_a_description_exits_1(self) -> None:
        self.install_claude(kit_rows="| alpha | User | < 20 |\n")
        code, _, err = self.main("claude")
        self.assertEqual(code, 1)
        self.assertIn("claude claude-opus-5-5: alpha: name-only", err)

    def test_claude_tiny_budget_that_shortens_nothing_exits_2(self) -> None:
        self.install_claude(tiny_rows="| alpha | User | ~80 |\n")
        code, _, err = self.main("claude")
        self.assertEqual(code, 2)
        self.assertIn("cannot see shortening", err)

    def test_claude_empty_home_with_any_project_skill_exits_2(self) -> None:
        self.install_claude()
        script = (self.bin / "claude").read_text(encoding="utf-8").replace('rows = \'| alpha | User | ~80 |\\n\' if kit_skills else ""', "rows = '| leaked | Project | ~80 |\\n'")
        self.assertIn("leaked", script)
        (self.bin / "claude").write_text(script, encoding="utf-8")
        code, _, err = self.main("claude")
        self.assertEqual(code, 2)
        self.assertIn("no kit lists", err)

    def test_claude_empty_home_with_any_rules_exits_2(self) -> None:
        self.install_claude()
        script = (self.bin / "claude").read_text(encoding="utf-8").replace('if rules else ""', 'if True else ""')
        (self.bin / "claude").write_text(script, encoding="utf-8")
        code, _, err = self.main("claude")
        self.assertEqual(code, 2)
        self.assertIn("tokens of rules", err)

    def test_claude_kit_gone_from_the_output_exits_2(self) -> None:
        self.install_claude(kit_rows="")
        code, _, err = self.main("claude")
        self.assertEqual(code, 2)
        self.assertIn("not visible", err)

    def test_claude_retired_default_model_exits_2_not_1(self) -> None:
        self.install_claude()
        with mock.patch.object(probe, "CLAUDE_DEFAULT_MODELS", {"claude-retired-4-0": "1m"}):
            code, _, err = self.main("claude")
        self.assertEqual(code, 2)
        self.assertIn("update the models", err)

    def test_codex_passes_and_reports_prompt_growth(self) -> None:
        self.install_codex()
        code, out, _ = self.main("codex")
        self.assertEqual(code, 0)
        self.assertIn("characters in the whole prompt", out)
        self.assertRegex(out, r"\(\+[\d,]{3,}\)")

    def test_codex_shortened_description_exits_1(self) -> None:
        self.install_codex(kit_lines=["- alpha: Alpha  (file: r0/alpha/SKILL.md)", "- retro: Retro does r. Use when r. (file: r0/retro/SKILL.md)"])
        code, _, err = self.main("codex")
        self.assertEqual(code, 1)
        self.assertIn("codex: alpha: shortened", err)

    def test_codex_user_only_skill_must_be_listed_because_codex_ignores_the_flag(self) -> None:
        self.install_codex(kit_lines=[f"- alpha: {self.SMALL_KIT['alpha']} (file: r0/alpha/SKILL.md)"])
        code, _, err = self.main("codex")
        self.assertEqual(code, 1)
        self.assertIn("codex: retro: missing", err)

    def test_codex_controls_exit_2(self) -> None:
        full = [f"- {name}: {description} (file: r0/{name}/SKILL.md)" for name, description in self.SMALL_KIT.items()]
        self.install_codex(short_lines=full)
        self.assertIn("cannot see shortening", self.main("codex")[2])
        self.install_codex(kit_lines=[])
        self.assertIn("not visible", self.main("codex")[2])
        self.install_codex()
        script = (self.bin / "codex").read_text(encoding="utf-8").replace("if kit_skills else []", "if True else []")
        (self.bin / "codex").write_text(script, encoding="utf-8")
        self.assertIn("no kit lists", self.main("codex")[2])

    def test_discovery_passes_fails_and_controls(self) -> None:
        self.install_discovery()
        self.assertEqual(self.main("kilo")[0], 0)
        self.install_discovery(entries=self.discovered[:1])
        code, _, err = self.main("kilo")
        self.assertEqual(code, 1)
        self.assertIn("kilo: retro: missing", err)
        self.install_discovery(entries=[])
        code, _, err = self.main("kilo")
        self.assertEqual(code, 2)
        self.assertIn("not visible", err)
        script = (self.bin / "kilo").read_text(encoding="utf-8").replace("if kit_skills else", "if True else").replace("[] if True", f"{self.discovered!r} if True")
        (self.bin / "kilo").write_text(script, encoding="utf-8")
        code, _, err = self.main("kilo")
        self.assertEqual(code, 2)
        self.assertIn("no kit lists", err)

    def test_harness_failures_and_crashes_exit_2_never_1(self) -> None:
        bodies = {
            "nonzero exit after good output": f"print(json.dumps({self.discovered!r} if kit_skills else []))\nsys.exit(3 if kit_skills else 0)\n",
            "not json": "print('nope')\n",
            "wrong shape": "print('{}')\n",
            "shape that crashes a parser": "print('[1]')\n",
            "not utf-8": "sys.stdout.buffer.write(b'\\xff\\xfe')\n",
        }
        for label, body in bodies.items():
            with self.subTest(label):
                self.install("kilo", body)
                self.assertEqual(self.main("kilo")[0], 2)

    def test_a_hanging_harness_times_out_and_exits_2(self) -> None:
        self.install("kilo", "import time\ntime.sleep(30)\n")
        with mock.patch.object(probe, "TIMEOUT_SECONDS", 1):
            code, _, err = self.main("kilo")
        self.assertEqual(code, 2)
        self.assertIn("timed out", err)

    def test_a_missing_harness_makes_the_whole_run_invalid(self) -> None:
        self.install_discovery("kilo")
        with mock.patch.object(probe.shutil, "which", side_effect=lambda name: str(self.bin / name) if name == "kilo" else None):
            code, _, err = self.main("kilo,opencode")
        self.assertEqual(code, 2)
        self.assertIn("not on PATH: opencode", err)

    def test_a_temp_folder_inside_the_real_home_exits_2(self) -> None:
        self.install_discovery("kilo")
        inside = self.root / "real-home" / "tmp"
        inside.mkdir(parents=True)
        with mock.patch.object(tempfile, "tempdir", str(inside)):
            code, _, err = self.main("kilo")
        self.assertEqual(code, 2)
        self.assertIn("inside the real home", err)
        self.assertFalse(self.seen.exists())

    def test_a_repeated_harness_runs_once(self) -> None:
        self.install_discovery("kilo")
        self.assertEqual(self.main("kilo,kilo")[0], 0)

    def test_output_longer_than_a_pipe_buffer_arrives_whole(self) -> None:
        big = [{**entry, "content": "x" * 200_000} for entry in self.discovered]
        self.install_discovery(entries=big)
        self.assertEqual(self.main("kilo")[0], 0)


if __name__ == "__main__":
    unittest.main()
