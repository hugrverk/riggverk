#!/usr/bin/env python3
"""Check that the browser mock backend and the Rust commands agree on command names and arguments.

`src/dev/mockBackend.ts` stands in for the Tauri backend under `vite dev` with `?mock=<scenario>`.
Nothing connects it to the Rust commands, so a command or argument added on one side can be
forgotten on the other. This check compares:

  1. the command names in `generate_handler!` (src-tauri/src/lib.rs) with the command names the
     mock handles (`case "name":` in its `switch (cmd)` blocks and `cmd === "name"` statements), both ways;
  2. for every command, each Rust argument (snake_case parameter, camelCased as Tauri does, with
     Tauri-injected parameters such as `AppHandle` and `State<..>` left out) with the mock's
     handler: the argument must appear in it as a quoted key or `args.key`, or be listed in
     `UNREAD_BY_MOCK` with a reason. A table entry for an argument the mock reads, or for a
     command or argument that no longer exists, fails too.

It does not check return shapes, argument types or what the mock does with an argument; only that
the mock names it. It reads text with regular expressions and fails when it cannot find the
handler list, the mock's dispatch or a command's Rust signature. It only reads files.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

RUST_LIB = "src-tauri/src/lib.rs"
RUST_DIR = "src-tauri/src"
MOCK = "src/dev/mockBackend.ts"

# (command, camelCase argument): why the mock does not read it.
UNREAD_BY_MOCK: dict[tuple[str, str], str] = {
    ("apply_setup", "skipManual"): "the mock's plans carry no manual steps, so there is nothing to skip",
}

INJECTED = re.compile(r"\b(AppHandle|State|Window|WebviewWindow|Webview)\b")


class Mismatch(Exception):
    pass


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def strip_rust_comments(text: str) -> str:
    return re.sub(r"//[^\n]*", "", text)


def handler_names(lib: str) -> list[str]:
    match = re.search(r"generate_handler!\s*\[(.*?)\]", lib, re.S)
    if not match:
        raise Mismatch(f"{RUST_LIB}: no generate_handler![...] list found")
    names = []
    for item in strip_rust_comments(match.group(1)).split(","):
        item = item.strip()
        if item:
            names.append(item.split("::")[-1])
    if not names:
        raise Mismatch(f"{RUST_LIB}: the generate_handler! list is empty")
    return names


def split_top_level(params: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for char in params:
        if char in "<([":
            depth += 1
        elif char in ">)]":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += char
    parts.append(current)
    return [part.strip() for part in parts if part.strip()]


def balanced_params(text: str, start: int) -> str:
    """The text between the parenthesis at `start` and its match."""
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1 : index]
    raise Mismatch("unbalanced parentheses in a command signature")


COMMAND_FN = re.compile(
    r"#\[tauri::command[^\]]*\]\s*(?:(?:#\[[^\]]*\]|///[^\n]*)\s*)*"
    r"(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^(]*>)?\s*\(",
)


def rust_commands(root: Path) -> dict[str, list[str]]:
    """Every `#[tauri::command]` function: name -> camelCase arguments."""
    commands: dict[str, list[str]] = {}
    for path in sorted((root / RUST_DIR).rglob("*.rs")):
        text = strip_rust_comments(path.read_text(encoding="utf-8"))
        text = re.sub(r"///[^\n]*", "", text)
        for match in COMMAND_FN.finditer(text):
            args = []
            for param in split_top_level(balanced_params(text, match.end() - 1)):
                name, sep, kind = param.partition(":")
                if not sep:
                    raise Mismatch(f"{path.name}: cannot read parameter {param!r} of {match.group(1)}")
                if INJECTED.search(kind):
                    continue
                args.append(camel(name.replace("mut ", "").strip()))
            commands[match.group(1)] = args
    return commands


def mock_handlers(mock: str) -> dict[str, str]:
    """Command name -> the mock's handler text for it.

    The dispatch is spread over a few top-level functions taking `cmd`: each has a `switch (cmd)` with
    `case "name":` labels at four spaces and/or statements whose first line compares `cmd === "name"`.
    """
    if not re.search(r"^async function handle\(cmd\b", mock, re.M):
        raise Mismatch(f"{MOCK}: no `async function handle(cmd` dispatcher found")
    handlers: dict[str, str] = {}
    functions = re.split(r"(?m)^(?=(?:async )?function \w+\()", mock)
    switches = 0
    for function in functions:
        if not re.match(r"(?:async )?function \w+\(cmd\b", function):
            continue
        function = function.split("\n}\n")[0] + "\n"
        switch = re.search(r"^  switch \(cmd\) \{\n(.*?)^  \}\n", function, re.S | re.M)
        outside = function
        if not switch and "switch (cmd)" in function:
            raise Mismatch(f"{MOCK}: a `switch (cmd)` was found but its closing brace at two spaces was not")
        if switch:
            switches += 1
            outside = function[: switch.start()] + function[switch.end() :]
            labels = list(re.finditer(r'^    case "(\w+)":', switch.group(1), re.M))
            if not labels:
                raise Mismatch(f"{MOCK}: a `switch (cmd)` has no `case \"name\":` labels at four spaces")
            body = switch.group(1)
            pending: list[str] = []
            for index, label in enumerate(labels):
                pending.append(label.group(1))
                stop = labels[index + 1].start() if index + 1 < len(labels) else len(body)
                text = body[label.end() : stop]
                if text.strip():
                    for name in pending:
                        handlers[name] = handlers.get(name, "") + text
                    pending = []
            if pending:
                raise Mismatch(f"{MOCK}: case labels without a body: {', '.join(pending)}")
        # Statements outside a switch handle a command by comparing `cmd` on their first line.
        for chunk in re.split(r"(?m)^(?=  [^\s}])", outside):
            for name in set(re.findall(r'cmd === "(\w+)"', chunk.split("\n", 1)[0])):
                handlers[name] = handlers.get(name, "") + chunk
    if not switches:
        raise Mismatch(f"{MOCK}: no `switch (cmd)` found in the dispatch functions")
    return handlers


def reads(handler: str, argument: str) -> bool:
    return bool(re.search(rf'["\']{argument}["\']|\bargs\??\.{argument}\b', handler))


def check(root: Path, unread: dict[tuple[str, str], str] = UNREAD_BY_MOCK) -> list[str]:
    """The problems found, empty when the mock and the Rust commands agree."""
    for rel in (RUST_LIB, MOCK):
        if not (root / rel).is_file():
            raise Mismatch(f"{rel} is missing")
    registered = handler_names((root / RUST_LIB).read_text(encoding="utf-8"))
    commands = rust_commands(root)
    handlers = mock_handlers((root / MOCK).read_text(encoding="utf-8"))
    problems: list[str] = []

    for name in registered:
        if name not in commands:
            problems.append(f"{name} is in generate_handler! but no #[tauri::command] fn of that name was found")
    rust_names = set(registered)
    for name in sorted(rust_names - set(handlers)):
        problems.append(f"{name}: a Rust command the mock does not handle")
    for name in sorted(set(handlers) - rust_names):
        problems.append(f"{name}: handled by the mock but not in generate_handler!")

    used: set[tuple[str, str]] = set()
    for name in sorted(rust_names & set(handlers)):
        for argument in commands.get(name, []):
            key = (name, argument)
            if reads(handlers[name], argument):
                continue
            if key in unread:
                used.add(key)
            else:
                problems.append(f"{name}: the mock never reads argument `{argument}` (read it, or list it in UNREAD_BY_MOCK)")
    for (name, argument), reason in sorted(unread.items()):
        if name not in commands or argument not in commands[name]:
            problems.append(f"UNREAD_BY_MOCK lists ({name}, {argument}) but no such Rust command argument exists")
        elif (name, argument) not in used:
            problems.append(f"UNREAD_BY_MOCK lists ({name}, {argument}) but the mock reads it: remove the entry")
        elif not reason.strip():
            problems.append(f"UNREAD_BY_MOCK entry ({name}, {argument}) has no reason")
    return problems


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else REPO_ROOT
    try:
        problems = check(root)
    except Mismatch as error:
        print(f"FAIL: mock parity: {error}", file=sys.stderr)
        return 1
    if problems:
        for problem in problems:
            print(f"FAIL: mock parity: {problem}", file=sys.stderr)
        return 1
    print(f"  mock parity: {len(handler_names((root / RUST_LIB).read_text(encoding='utf-8')))} commands agree with the mock")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
