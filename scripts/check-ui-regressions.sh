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
  repo-dashboard-section-kicker \
  repo-dashboard-brand \
  repo-dashboard-sidebar-foot \
  prompt-loops-sidebar-foot \
  prompt-loops-detail-actions \
  prompt-loops-btn \
  tools-placeholder \
  repo-dashboard-type-row; do
  if search "$selector" src >"$ui_tmp"; then
    cat "$ui_tmp" >&2
    fail "deprecated UI selector still present: $selector"
  fi
done

if search '>Overview<|\{SECTIONS\.find\(s => s\.id === section\)\?\.label' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard must not render a redundant section heading below the path controls"
fi

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

if search -U '\.repo-dashboard-heat-(scroll|wrap|box|grid)[^{]*\{[^}]*overflow-y:\s*(auto|scroll)' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not use vertical overflow scrolling"
fi
if ! search 'repo-dashboard-heat-density-' src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  fail "Repo Dashboard heatmap must expose density class names"
fi
if ! search 'ActivityHeatmapDensity|density=' src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  fail "Repo Dashboard heatmap must pass density prop"
fi
if ! search 'repo-dashboard-heat-density-compact|--heat-week-count' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard heatmap density CSS must exist"
fi
if ! search 'repeat\(var\(--heat-week-count' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard heatmap grid must use week-count CSS variable"
fi
if search -U '\.repo-dashboard-heat-cell[^{]*\{[^}]*width:\s*100%' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heat cells must not stretch to 100% width"
fi
if ! search 'aspect-ratio:\s*1\s*/\s*1' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard heat cells must keep square aspect ratio"
fi
if ! search 'grid-template-columns: repeat\(var\(--heat-week-count[^)]+\),\s*var\(--heat-cell-size' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard heat grid must size cells explicitly"
fi
if search 'scrollRef|scrollLeft|repo-dashboard-heat-scroll' src/tools/repoDashboard/RepoDashboardCharts.tsx src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not use horizontal scroll hacks"
fi
if search -U '\.repo-dashboard-heat-(wrap|box|grid)[^{]*\{[^}]*overflow-x:\s*(auto|scroll)' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not use horizontal overflow scrolling"
fi
if ! search 'HEATMAP_DISPLAY_WEEKS' src/tools/repoDashboard/model.ts src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  fail "Repo Dashboard heatmap must define display week cap"
fi
if search 'heat-range-btn|HEATMAP_WINDOW_WEEKS|chooseHeatmapWindowWeeks|windowOverride' src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not expose window override controls"
fi
if ! search 'repo-dashboard-work-primary-columns|repo-dashboard-work-column-scroll' src/tools/repoDashboard/RepoWorkWorkspace.tsx >"$ui_tmp"; then
  fail "Repo Dashboard work columns layout must exist"
fi
if search 'repo-dashboard-work-column-active|repo-dashboard-work-active-columns|repo-dashboard-work-subcolumn' src/tools/repoDashboard src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard work column selectors must not return"
fi
if ! search 'repo-dashboard-section-select' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard section select must exist"
fi
if ! search 'density="default"' src/tools/repoDashboard/RepoActivityInsights.tsx >"$ui_tmp"; then
  fail "Repo Dashboard activity insights must use default heatmap density"
fi
if search -U '\.repo-dashboard-workspace \{[^}]*overflow:\s*auto' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard workspace shell must not scroll as a whole"
fi
if search -U '\.repo-dashboard-overview-lower \.repo-dashboard-latest-content[^{]*\{[^}]*overflow:\s*(auto|scroll)' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard latest content must not scroll independently"
fi
if search -U '\.repo-dashboard-activity-insights-svg[^{]*\{[^}]*min-height:\s*[2-9][0-9]{2}px' src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard activity chart must not force oversized min-height"
fi
if search -U '\.repo-dashboard-heat-aside \{[^}]*overflow:\s*auto' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard heat aside must not scroll independently"
fi
if search 'hellq|PRIVATE|uxsmedjan|PRIVATE' src/tools/repoDashboard/model.ts >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard model must not embed personal identifiers"
fi
if ! search 'WORK_ITEMS_DISPLAY_CAP|Showing first' src/tools/repoDashboard/RepoWorkWorkspace.tsx src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard work list must disclose display cap"
fi
if ! search 'repo-dashboard-work-column-scroll \.repo-dashboard-list' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard work column scroll container must exist"
fi
if ! search 'grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard work primary columns must use three-column grid"
fi
if ! search -U '@media \(max-width: 1100px\)[\s\S]*\.repo-dashboard-work-primary-columns[\s\S]*grid-template-rows:\s*repeat\(3' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard work columns must stack on narrow viewports"
fi
if ! search 'repo-dashboard-activity-chart-footer' src/tools/repoDashboard/RepoActivityInsights.tsx >"$ui_tmp"; then
  fail "Repo Dashboard activity chart footer must exist"
fi
if search 'repo-dashboard-activity-insights-meta' src/tools/repoDashboard/RepoActivityInsights.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard activity meta row must not return"
fi
if ! search '\[data-theme="light"\] \.repo-dashboard-heat-cell\.l1' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard light-theme heat cells must define level-1 color"
fi
if search 'repo-dashboard-heat-aside' src/tools/repoDashboard src/styles >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard heat aside must not return"
fi
if search 'repo-dashboard-heat-card|repo-dashboard-overview-mid|repo-dashboard-overview-full' src/styles src/tools/repoDashboard >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard overview layout selectors must not return"
fi
if ! search 'repo-dashboard-activity-sidebar|repo-dashboard-overview-lower' src/styles >"$ui_tmp"; then
  fail "Repo Dashboard overview lower layout must exist"
fi
if search 'Source health|buildSourceHealth' src/tools/repoDashboard/RepoDashboardTool.tsx src/tools/repoDashboard/model.ts >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard source health UI must not return"
fi
if search '"activity"|"sources"|label: "Activity"|label: "Sources"' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard activity/sources tabs must not return"
fi
if ! search 'label: "Docs"' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard docs section label must exist"
fi
if ! search 'prompt-loops-group-select' src/tools/promptLoops/PromptLoopsTool.tsx >"$ui_tmp"; then
  fail "Prompt Builder group select must exist"
fi
if search 'prompt-loops-sidebar|repo-dashboard-sidebar' src/tools --glob '!**/*.test.*' >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "legacy tool sidebars must not return"
fi
if ! search 'ToolSectionTabs|tool-section-tabs' src/tools/promptLoops/PromptLoopsTool.tsx src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "tool section tabs must exist in Prompt Builder and Repo Dashboard"
fi
if ! search 'repo-dashboard-field-branch|Default branch override' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard default branch override must exist"
fi
if ! search 'startDiscoverLocalRepos|Discover local git repositories' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard discover action must exist"
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

if search 'gh:\s*\{snapshot\.gh\.authenticated \? "enhanced"' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard sidebar gh status must not return"
fi

if search 'prompt-loops-pill">1–4|tool-sidebar-hints' src/tools/promptLoops/PromptLoopsTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Prompt Builder shortcut hint block must not return"
fi

if ! search 'lib-docs-markdown|lib-docs-reader-pane' src/views/library/DocContent.tsx src/styles >"$ui_tmp"; then
  fail "Library Docs scoped reading surface must exist"
fi
if search 'view === "tools"|AppHeaderView.*tools|"tools"' src/App.tsx src/components/AppHeaderNav.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "obsolete Tools view must not return in navigation"
fi
if ! search '"prompts"|"repo-dashboard"' src/components/AppHeaderNav.tsx src/App.tsx >"$ui_tmp"; then
  fail "direct Prompt Builder and Repo Dashboard views must exist"
fi

printf 'UI regression checks passed\n'
