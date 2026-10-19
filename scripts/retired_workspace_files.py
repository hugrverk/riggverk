"""Reader for the frozen list of workspace copies in src-tauri/src/commands/retired_workspace_files.rs.

Shared by check-retired-workspace-files.py, check-bundle-content.py and
generate-pre-manifest-ownership.py, so the Rust file is parsed in one place.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUST_MODULE = "src-tauri/src/commands/retired_workspace_files.rs"

_MARKER = re.compile(r'LEGACY_MARKER_REL:\s*&str\s*=\s*"([^"]+)";')
_FILES = re.compile(r"RETIRED_WORKSPACE_FILES:\s*&\[&str\]\s*=\s*&\[(.*?)\n\];", re.DOTALL)
_FROM_BUNDLE = re.compile(r"RETIRED_FROM_BUNDLE:\s*&\[&str\]\s*=\s*&\[(.*?)\];", re.DOTALL)
_COMMENT = re.compile(r"//[^\n]*")
_STRING = re.compile(r'"([^"]+)"')


@dataclass(frozen=True)
class FrozenList:
    marker: str
    files: tuple[str, ...]
    # Listed paths the bundle no longer holds; the Rust tests document each one.
    retired_from_bundle: tuple[str, ...]

    def copy_paths(self) -> tuple[str, ...]:
        """The marker and the frozen list: every path the WorkspaceBundle surface installs."""
        return (self.marker, *self.files)


def parse(text: str) -> FrozenList:
    marker = _MARKER.search(text)
    files = _FILES.search(text)
    if marker is None:
        raise ValueError("LEGACY_MARKER_REL not found")
    if files is None:
        raise ValueError("RETIRED_WORKSPACE_FILES not found")
    from_bundle = _FROM_BUNDLE.search(text)

    def strings(block: str) -> tuple[str, ...]:
        return tuple(_STRING.findall(_COMMENT.sub("", block)))

    return FrozenList(
        marker=marker.group(1),
        files=strings(files.group(1)),
        retired_from_bundle=strings(from_bundle.group(1)) if from_bundle else (),
    )


def load(root: Path = ROOT) -> FrozenList:
    path = root / RUST_MODULE
    if not path.is_file():
        raise ValueError(f"missing frozen list of workspace copies: {RUST_MODULE}")
    return parse(path.read_text(encoding="utf-8"))
