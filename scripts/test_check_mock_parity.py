#!/usr/bin/env python3
"""Tests for scripts/check-mock-parity.py.

Each case builds a small tree with a `generate_handler!` list, one Rust command file and a mock
dispatcher, breaks exactly one thing and asserts the check names it. One case runs the check on the
repository itself.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check-mock-parity.py"

_spec = importlib.util.spec_from_file_location("check_mock_parity", SCRIPT)
assert _spec and _spec.loader
parity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(parity)

LIB = """
fn run() {
    builder.invoke_handler(tauri::generate_handler![
        list_things,
        // a comment between entries
        save_thing,
    ]);
}
"""

COMMANDS = """
/// Lists.
#[tauri::command(async)]
pub fn list_things() -> Vec<String> { vec![] }

#[tauri::command]
pub async fn save_thing<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Shared>,
    thing_id: String,
    expected_revision: Option<Vec<(String, u8)>>,
) -> Result<(), String> { Ok(()) }
"""

MOCK = """\
async function handle(cmd: string, args: Args): Promise<unknown> {
  if (cmd === "list_things") {
    return [];
  }
  switch (cmd) {
    case "save_thing": {
      const id = arg<string>(args, "thingId");
      requireRevision(arg<string>(args, "expectedRevision"));
      return id;
    }
    default:
      throw new Error("unhandled");
  }
}
"""


class CheckMockParityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.write("src-tauri/src/lib.rs", LIB)
        self.write("src-tauri/src/commands.rs", COMMANDS)
        self.write("src/dev/mockBackend.ts", MOCK)

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def edit(self, rel: str, old: str, new: str) -> None:
        path = self.root / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"{rel} no longer contains {old!r}: update the test")
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def problems(self, unread: dict[tuple[str, str], str] | None = None) -> list[str]:
        return parity.check(self.root, unread or {})

    def test_agreeing_trees_pass(self) -> None:
        self.assertEqual(self.problems(), [])

    def test_the_repository_agrees(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT)], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_command_missing_in_the_mock_fails(self) -> None:
        self.edit("src-tauri/src/lib.rs", "save_thing,", "save_thing,\n        extra_thing,")
        self.edit("src-tauri/src/commands.rs", "pub fn list_things", "pub fn extra_thing() {}\n#[tauri::command]\npub fn list_things")
        self.assertEqual(self.problems(), ["extra_thing: a Rust command the mock does not handle"])

    def test_a_command_only_the_mock_handles_fails(self) -> None:
        self.edit("src/dev/mockBackend.ts", "    default:", '    case "ghost_thing":\n      return null;\n    default:')
        self.assertEqual(self.problems(), ["ghost_thing: handled by the mock but not in generate_handler!"])

    def test_an_argument_the_mock_does_not_read_fails(self) -> None:
        self.edit("src/dev/mockBackend.ts", 'requireRevision(arg<string>(args, "expectedRevision"));', "")
        problems = self.problems()
        self.assertEqual(len(problems), 1)
        self.assertIn("save_thing", problems[0])
        self.assertIn("expectedRevision", problems[0])

    def test_a_listed_unread_argument_passes(self) -> None:
        self.edit("src/dev/mockBackend.ts", 'requireRevision(arg<string>(args, "expectedRevision"));', "")
        self.assertEqual(self.problems({("save_thing", "expectedRevision"): "no revisions in the mock"}), [])

    def test_a_table_entry_for_an_argument_the_mock_reads_is_stale(self) -> None:
        problems = self.problems({("save_thing", "thingId"): "stale"})
        self.assertEqual(len(problems), 1)
        self.assertIn("remove the entry", problems[0])

    def test_a_table_entry_for_a_missing_argument_or_command_is_stale(self) -> None:
        problems = self.problems({("save_thing", "gone"): "x", ("gone_command", "id"): "y"})
        self.assertEqual(len(problems), 2)
        self.assertTrue(all("no such Rust command argument" in problem for problem in problems))

    def test_a_table_entry_without_a_reason_fails(self) -> None:
        self.edit("src/dev/mockBackend.ts", 'requireRevision(arg<string>(args, "expectedRevision"));', "")
        problems = self.problems({("save_thing", "expectedRevision"): " "})
        self.assertEqual(len(problems), 1)
        self.assertIn("no reason", problems[0])

    def test_injected_parameters_are_not_arguments(self) -> None:
        self.assertEqual(parity.rust_commands(self.root)["save_thing"], ["thingId", "expectedRevision"])

    def test_a_missing_handler_list_fails_loudly(self) -> None:
        self.write("src-tauri/src/lib.rs", "fn run() {}\n")
        with self.assertRaises(parity.Mismatch):
            self.problems()

    def test_a_missing_dispatcher_fails_loudly(self) -> None:
        self.write("src/dev/mockBackend.ts", "export const x = 1;\n")
        with self.assertRaises(parity.Mismatch):
            self.problems()

    def test_a_listed_command_without_a_rust_function_fails(self) -> None:
        self.edit("src-tauri/src/lib.rs", "save_thing,", "save_thing,\n        orphan,")
        self.edit("src/dev/mockBackend.ts", "    default:", '    case "orphan":\n      return null;\n    default:')
        self.assertEqual(self.problems(), ["orphan is in generate_handler! but no #[tauri::command] fn of that name was found"])


if __name__ == "__main__":
    unittest.main()
