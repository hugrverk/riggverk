#!/usr/bin/env python3
"""One command for every generated file in the repository.

Usage:
  python3 scripts/generate.py check [--only NAME ...] [--no-history]
  python3 scripts/generate.py write [--only NAME ...] [--no-history]
  python3 scripts/generate.py list     # name, script, history yes/no, outputs
  python3 scripts/generate.py paths    # every generated file, one per line

check runs every generator with --check, prints one line per generator and exits 1 when any
of them fails. write runs them with --write in dependency order, stops at the first failure,
prints the files that changed and never commits. The history generators read every commit of
HEAD (and of MERGE_HEAD during a merge) plus the tracked working tree, so writing before
`git commit` gives the same files as writing after it. Track new files (`git add`) before
writing. --no-history skips the history generators for a fast inner loop; the release check
never passes it.

The generate-*.py scripts stay runnable on their own; this runs them in one process so the
history generators share one walk of the git history.
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 11):
    sys.exit(
        "FAIL: python3 3.11 or newer is required by scripts/generate.py "
        f"(found: Python {sys.version.split()[0]}); put a newer python3 first on PATH"
    )

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import runpy
import shutil
import subprocess
import tempfile
import traceback
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = "resources/default-workspace"


def load_script(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rules_outputs() -> list[str]:
    manifest = json.loads(
        (ROOT / WORKSPACE / "metadata/rules-adapters.json").read_text(encoding="utf-8")
    )
    return [f"{WORKSPACE}/{harness['output']}" for harness in manifest["harnesses"].values()]


def adapter_outputs() -> list[str]:
    # Hand-written Cursor agents live next to the generated ones; list the generated ones only.
    roles = load_script("generate-agent-adapters.py").ROLES
    outputs = [
        f"{WORKSPACE}/{harness['output']}"
        for role in roles.values()
        for harness in role["harnesses"].values()
    ]
    return [*outputs, f"{WORKSPACE}/metadata/agent-adapters.json"]


def fixed(*paths: str) -> Callable[[], list[str]]:
    return lambda: list(paths)


def check_shipped_opencode_twin() -> tuple[int, str]:
    """The installed workspace regenerates opencode.json with its own copy of the generator."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "workspace"
        shutil.copytree(ROOT / WORKSPACE, copy, symlinks=True)
        result = subprocess.run(
            [sys.executable, str(copy / "scripts/generate-opencode-config.py"), "--check"],
            capture_output=True,
            text=True,
            check=False,
        )
    label = "workspace scripts/generate-opencode-config.py --check from a temp copy"
    return result.returncode, f"{label}:\n{result.stdout}{result.stderr}"


@dataclass(frozen=True)
class Generator:
    name: str
    script: str
    outputs: Callable[[], list[str]]
    history: bool = False
    extra_check: Callable[[], tuple[int, str]] | None = None


# Dependency order: agent-adapters validates the OpenCode permission contract against
# opencode.json, and the history generators hash files the others write (sync rules, adapters,
# opencode.json, metadata/agent-adapters.json); nothing reads the history generators' outputs.
REGISTRY: tuple[Generator, ...] = (
    Generator("agent-rules", "scripts/generate-agent-rules.py", rules_outputs),
    Generator(
        "opencode-config",
        "scripts/generate-default-opencode-config.py",
        fixed(f"{WORKSPACE}/templates/opencode.json"),
        extra_check=check_shipped_opencode_twin,
    ),
    Generator("agent-adapters", "scripts/generate-agent-adapters.py", adapter_outputs),
    Generator(
        "release-notes", "scripts/generate-release-notes.py", fixed("src/generated/release-notes.json")
    ),
    Generator(
        "rules-history",
        "scripts/generate-rules-history.py",
        fixed(f"{WORKSPACE}/metadata/rules-history"),
        history=True,
    ),
    Generator(
        "shipped-digests",
        "scripts/generate-shipped-digests.py",
        fixed(f"{WORKSPACE}/metadata/shipped-digests.json"),
        history=True,
    ),
    Generator(
        "pre-manifest-ownership",
        "scripts/generate-pre-manifest-ownership.py",
        fixed(f"{WORKSPACE}/metadata/pre-manifest-ownership.json"),
        history=True,
    ),
)


def run_generator(generator: Generator, flag: str, root: Path = ROOT) -> tuple[int, str]:
    """Run one generator script in this process; return (exit code, captured output)."""
    buffer = io.StringIO()
    saved_argv = sys.argv
    script = root / generator.script
    sys.argv = [str(script), flag]
    code = 0
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            runpy.run_path(str(script), run_name="__main__")
    except SystemExit as exit_:
        if exit_.code is None:
            code = 0
        elif isinstance(exit_.code, int):
            code = exit_.code
        else:
            buffer.write(f"{exit_.code}\n")
            code = 1
    except Exception:  # noqa: BLE001 - report any generator crash as a failure of that generator
        buffer.write(traceback.format_exc())
        code = 1
    finally:
        sys.argv = saved_argv
    return code, buffer.getvalue()


def indented(text: str) -> str:
    return "".join(f"    {line}\n" for line in text.rstrip("\n").splitlines())


def select(registry: Sequence[Generator], only: list[str] | None, no_history: bool) -> list[Generator]:
    names = {generator.name for generator in registry}
    unknown = sorted(set(only or ()) - names)
    if unknown:
        raise SystemExit(f"unknown generator: {', '.join(unknown)} (see: python3 scripts/generate.py list)")
    chosen = [
        generator
        for generator in registry
        if (not only or generator.name in only) and not (no_history and generator.history)
    ]
    if not chosen:
        raise SystemExit("no generator selected")
    return chosen


def check(generators: Sequence[Generator], runner=run_generator) -> int:
    failed: list[str] = []
    for generator in generators:
        code, output = runner(generator, "--check")
        if code == 0 and generator.extra_check is not None:
            code, output = generator.extra_check()
        if code == 0:
            print(f"ok    {generator.name}")
        else:
            failed.append(generator.name)
            print(f"FAIL  {generator.name}")
            print(indented(output), end="")
    if failed:
        print(f"FAIL: {len(failed)} of {len(generators)} generators failed: {', '.join(failed)}")
        print("fix: python3 scripts/generate.py write, then commit the changed files")
        return 1
    print(f"PASS: {len(generators)} generators, every generated file is current")
    return 0


def output_files(paths: Sequence[str], root: Path = ROOT) -> dict[str, str]:
    """Map every existing file under the given outputs -> its content digest."""
    found: dict[str, str] = {}
    for rel in paths:
        path = root / rel
        files = sorted(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else [path]
        for file in files:
            if file.is_file():
                found[file.relative_to(root).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return found


def untracked_bundle_files(root: Path = ROOT) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--others", "--exclude-standard", "--", WORKSPACE],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return sorted(filter(None, result.stdout.split("\0"))) if result.returncode == 0 else []


def write(generators: Sequence[Generator], runner=run_generator, root: Path = ROOT) -> int:
    if any(generator.history for generator in generators):
        untracked = untracked_bundle_files(root)
        if untracked:
            print("note: untracked bundle files get no shipped digests until `git add`:")
            print(indented("\n".join(untracked)), end="")
    paths = [path for generator in generators for path in generator.outputs()]
    before = output_files(paths, root)
    for generator in generators:
        code, output = runner(generator, "--write")
        if code != 0:
            print(f"FAIL  {generator.name}")
            print(indented(output), end="")
            print("FAIL: stopped; later generators read the outputs of earlier ones")
            return 1
        print(f"ok    {generator.name}")
    after = output_files(paths, root)
    changed = sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path))
    if not changed:
        print("no changes: every generated file was already current")
        return 0
    print(f"changed {len(changed)} files:")
    print(indented("\n".join(changed)), end="")
    print("next: commit these files with your change; this command never commits.")
    print(
        "  Already committed: git commit --amend --no-edit if not pushed yet, "
        'else a new commit "chore(generate): refresh generated files".'
    )
    return 0


def list_registry(registry: Sequence[Generator]) -> int:
    for generator in registry:
        history = "yes" if generator.history else "no"
        print(f"{generator.name}  {generator.script}  history: {history}")
        print(indented("\n".join(generator.outputs())), end="")
    return 0


def paths(registry: Sequence[Generator], root: Path = ROOT) -> int:
    """Every generated file git knows or would add, e.g. to resolve merge conflicts in them."""
    specs = [path for generator in registry for path in generator.outputs()]
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *specs],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit(result.stderr.decode("utf-8", errors="replace").strip())
    for path in sorted(set(filter(None, result.stdout.decode().split("\0")))):
        print(path)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("check", "write"):
        command = commands.add_parser(name)
        command.add_argument("--only", nargs="+", action="extend", metavar="NAME")
        command.add_argument("--no-history", action="store_true")
    commands.add_parser("list")
    commands.add_parser("paths")
    args = parser.parse_args(argv)
    sys.dont_write_bytecode = True
    if args.command == "list":
        return list_registry(REGISTRY)
    if args.command == "paths":
        return paths(REGISTRY)
    generators = select(REGISTRY, args.only, args.no_history)
    if args.command == "check":
        return check(generators)
    return write(generators)


if __name__ == "__main__":
    raise SystemExit(main())
