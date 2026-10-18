#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_tmp=""
cleanup() {
  if [ -n "$ui_tmp" ] && [ -f "$ui_tmp" ]; then
    rm -f "$ui_tmp"
  fi
}
trap cleanup EXIT

ui_tmp="$(mktemp "${TMPDIR:-/tmp}/agent-workspace-ui-regressions.XXXXXX")"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

search() {
  if command -v rg >/dev/null 2>&1; then
    command rg -n "$@"
    return
  fi
  python3 - "$@" <<'PY'
from __future__ import annotations

import fnmatch
import os
import re
import sys
from pathlib import Path

args = sys.argv[1:]
multiline = False
exclude_globs: list[str] = []
pattern: str | None = None
paths: list[str] = []
i = 0
while i < len(args):
    arg = args[i]
    if arg == "-U":
        multiline = True
        i += 1
        continue
    if arg == "--glob":
        if i + 1 >= len(args):
            raise SystemExit("search fallback missing --glob value")
        glob = args[i + 1]
        if glob.startswith("!"):
            exclude_globs.append(glob[1:])
        i += 2
        continue
    if arg == "--":
        i += 1
        if i >= len(args):
            raise SystemExit("search fallback missing pattern after --")
        if pattern is None:
            pattern = args[i]
        else:
            paths.append(args[i])
        i += 1
        continue
    if pattern is None:
        pattern = arg
    else:
        paths.append(arg)
    i += 1

if pattern is None:
    raise SystemExit("search fallback missing pattern")
if not paths:
    paths = ["."]

skip_dirs = {".git", "dist", "node_modules", "target"}
regex = re.compile(pattern)

def excluded(path: Path) -> bool:
    name = path.as_posix()
    return any(fnmatch.fnmatch(name, glob) for glob in exclude_globs)

def iter_files(root: Path):
    if root.is_file():
        if not excluded(root):
            yield root
        return
    if not root.is_dir():
        return
    for current, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in skip_dirs]
        for name in files:
            path = Path(current) / name
            if not excluded(path):
                yield path

found = False
for root in map(Path, paths):
    for path in iter_files(root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if multiline:
            match = regex.search(text)
            if not match:
                continue
            line_no = text.count("\n", 0, match.start()) + 1
            line = text.splitlines()[line_no - 1] if text.splitlines() else ""
            print(f"{path}:{line_no}:{line}")
            found = True
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                print(f"{path}:{line_no}:{line}")
                found = True

raise SystemExit(0 if found else 1)
PY
}

if search 'box-shadow:[^;]*inset (2px 0|0 -2px)' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "heavy inset selected-state bars are not allowed"
fi

if search 'border-left:[^;]*2px solid (var\(--accent\)|currentColor)' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "heavy decorative selected left borders are not allowed"
fi

for selector in \
  tools-placeholder \
  app-header \
  nav-icon \
  error-banner; do
  if search "$selector" src >"$ui_tmp"; then
    cat "$ui_tmp" >&2
    fail "deprecated UI selector still present: $selector"
  fi
done

if ! search -U '\.brain-setup-lib-body \.copyable-block-content \{[^}]*overflow: auto;' src/styles >"$ui_tmp"; then
  fail "Brain Setup Library content must define a local scroll container"
fi

if ! search 'data-app-font-size' src/lib/settingsDraft.ts >"$ui_tmp"; then
  fail "app font-size setting must set a root data attribute"
fi
if ! search -- '--app-font-size|--app-font-scale' src/styles >"$ui_tmp"; then
  fail "app font-size setting must drive CSS variables"
fi
if ! search 'Global app text size' src/views/SettingsView.tsx >"$ui_tmp"; then
  fail "Settings view must expose app font-size control"
fi
if ! search 'APP_FONT_SIZE_VALUES' src/views/SettingsView.tsx src/lib/settingsDraft.ts >"$ui_tmp"; then
  fail "app font-size setting must expose all persisted values"
fi
if ! search -- '--text-xs|--text-sm|--text-base|--text-lg|--text-heading|--font-size-heading|--text-display' src/styles >"$ui_tmp"; then
  fail "semantic typography variables must exist"
fi
if search -- '--text-heading:\s*[^;]*(rem|px|em|%)' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "--text-heading must remain a color token, not a font-size length"
fi
if search -- '--font-size-heading:\s*(#|rgba?\()' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "--font-size-heading must remain a length token, not a color"
fi
if ! search -- '--font-size-heading:\s*[0-9.]+rem' src/styles >"$ui_tmp"; then
  fail "semantic heading font-size token must exist"
fi
if search 'zoom:\s*[^;]+' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "typography scaling must not use CSS zoom"
fi
if ! search 'extra-large' src/lib/settingsDraft.ts src/types.ts src-tauri/src/settings.rs >"$ui_tmp"; then
  fail "extra-large app font-size value must exist in frontend and backend contracts"
fi
if ! search 'font:\s*inherit' src/styles >"$ui_tmp"; then
  fail "form controls must inherit typography"
fi

for obsolete in \
  'ToolsView' \
  'ToolsSwitcher' \
  'tools-view' \
  'tools-switcher-btn' \
  'tool-sidebar-footer' \
  'tool-sidebar-hints' \
  'tool-sidebar-status'; do
  if search "$obsolete" src --glob '!**/*.test.*' >"$ui_tmp"; then
    cat "$ui_tmp" >&2
    fail "obsolete tools UI must not return: $obsolete"
  fi
done

if ! search 'lib-docs-markdown' src/views/library/DocContent.tsx >"$ui_tmp"; then
  fail "Library document preview must render the scoped reading surface"
fi
if ! search '^\.lib-docs-markdown \{' src/styles/_library.scss >"$ui_tmp"; then
  fail "Library document preview must have its scoped reading styles"
fi
if search 'view === "tools"|AppHeaderView.*tools|"tools"' src/App.tsx src/shell/TopLine.tsx src/shell/views.ts >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "obsolete Tools view must not return in navigation"
fi

# The shipped UI is offline-first: fonts are vendored and nothing may load from a remote origin.
if search 'https?://' index.html src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "index.html and styles must not reference remote URLs"
fi
if ! search '@font-face' src/styles >"$ui_tmp"; then
  fail "the vendored UI font must be declared with @font-face"
fi
if ! search '@media \(prefers-reduced-motion: reduce\)' src/styles/_tokens.scss >"$ui_tmp"; then
  fail "base styles must honor prefers-reduced-motion"
fi

# The browser mock backend is dev-only: main.tsx is its single importer and gates it on the dev server.
if search 'dev/mockBackend' src --glob '!src/main.tsx' --glob '!src/dev/*' >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "src/dev/mockBackend must only be imported from src/main.tsx"
fi
if ! search 'import\.meta\.env\.DEV.*has\("mock"\)' src/main.tsx >"$ui_tmp"; then
  fail "main.tsx must gate the mock backend on import.meta.env.DEV and ?mock"
fi
if ! search 'import\("\./dev/mockBackend"\)' src/main.tsx >"$ui_tmp"; then
  fail "main.tsx must load the mock backend with a dynamic import"
fi

printf 'UI regression checks passed\n'
