#!/usr/bin/env python3
"""Fail when Rust code starts a POSIX shell with a command string.

The app only spawns `bash <script> <flags>` with argument arrays. A plain text
search for the shell command-string flag misses the real Rust forms (a shell
named in `Command::new(..)` followed by `.arg("-c")`, `.args(["-lc", cmd])`, or
`run_cmd("bash", &["-c", ..])`), so this scans every string literal that names a
shell for a following `-c`-style flag literal in the same item.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src-tauri" / "src"

STRING_LITERAL = re.compile(r'"([^"\n\\]*)"')
SHELL_NAMES = {"sh", "bash", "zsh", "dash", "ksh", "csh", "fish"}
# -c, -lc, -ic, -cl, -ec ...
COMMAND_FLAG = re.compile(r'"-[a-zA-Z]*c[a-zA-Z]*"')
# How far after a shell literal a flag literal still counts as its argument list.
WINDOW = 240


def shell_literal_names(text: str):
    for match in STRING_LITERAL.finditer(text):
        base = re.split(r"[\\/]", match.group(1))[-1].lower()
        base = base[:-4] if base.endswith(".exe") else base
        if base in SHELL_NAMES:
            yield match


def scan(path: Path, root: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    hits: list[str] = []
    for match in shell_literal_names(text):
        window = text[match.end() : match.end() + WINDOW]
        boundary = re.search(r"#\[|\bfn\s", window)  # do not leak into the next item
        if boundary:
            window = window[: boundary.start()]
        flag = COMMAND_FLAG.search(window)
        if flag:
            line = text.count("\n", 0, match.start()) + 1
            hits.append(f"{path.relative_to(root)}:{line}: shell {match.group(0)} with {flag.group(0)}")
    return hits


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE
    files = sorted(root.rglob("*.rs"))
    if not files:
        print(f"FAIL: no Rust sources found under {root}", file=sys.stderr)
        raise SystemExit(1)
    hits = [hit for path in files for hit in scan(path, root)]
    if hits:
        print("FAIL: Rust code starts a shell with a command string:", file=sys.stderr)
        for hit in hits:
            print(f"  {hit}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  no shell command-string spawns in {len(files)} Rust files")


if __name__ == "__main__":
    main()
