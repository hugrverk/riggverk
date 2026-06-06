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

if rg -n 'box-shadow:[^;]*inset (2px 0|0 -2px)' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "heavy inset selected-state bars are not allowed"
fi

if rg -n 'border-left:[^;]*2px solid (var\(--accent\)|currentColor)' src/styles.css >"$ui_tmp"; then
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
  if rg -n "$selector" src >"$ui_tmp"; then
    cat "$ui_tmp" >&2
    fail "deprecated UI selector still present: $selector"
  fi
done

if rg -n '>Overview<|\{SECTIONS\.find\(s => s\.id === section\)\?\.label' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard must not render a redundant section heading below the path controls"
fi

if ! rg -n -U '\.brain-setup-lib-body \.copyable-block-content \{[^}]*overflow: auto;' src/styles.css >"$ui_tmp"; then
  fail "Brain Setup Library content must define a local scroll container"
fi

if ! rg -n 'data-app-font-size' src/lib/settingsDraft.ts >"$ui_tmp"; then
  fail "app font-size setting must set a root data attribute"
fi
if ! rg -n -- '--app-font-size|--app-font-scale' src/styles.css >"$ui_tmp"; then
  fail "app font-size setting must drive CSS variables"
fi
if ! rg -n 'Global app text size' src/views/SettingsView.tsx >"$ui_tmp"; then
  fail "Settings view must expose app font-size control"
fi
if ! rg -n 'APP_FONT_SIZE_VALUES' src/views/SettingsView.tsx src/lib/settingsDraft.ts >"$ui_tmp"; then
  fail "app font-size setting must expose all persisted values"
fi
if ! rg -n -- '--text-xs|--text-sm|--text-base|--text-lg|--text-heading|--text-display' src/styles.css >"$ui_tmp"; then
  fail "semantic typography variables must exist"
fi
if rg -n 'zoom:\s*[^;]+' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "typography scaling must not use CSS zoom"
fi
if ! rg -n 'extra-large' src/lib/settingsDraft.ts src/types.ts src-tauri/src/settings.rs >"$ui_tmp"; then
  fail "extra-large app font-size value must exist in frontend and backend contracts"
fi
if ! rg -n 'font:\s*inherit' src/styles.css >"$ui_tmp"; then
  fail "form controls must inherit typography"
fi

if rg -n -U '\.repo-dashboard-heat-(scroll|wrap|box|grid)[^{]*\{[^}]*overflow-y:\s*(auto|scroll)' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not use vertical overflow scrolling"
fi
if ! rg -n 'repo-dashboard-heat-density-' src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  fail "Repo Dashboard heatmap must expose density class names"
fi
if ! rg -n 'ActivityHeatmapDensity|density=' src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  fail "Repo Dashboard heatmap must pass density prop"
fi
if ! rg -n 'repo-dashboard-heat-density-compact|--heat-week-count' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard heatmap density CSS must exist"
fi
if ! rg -n 'repeat\(var\(--heat-week-count' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard heatmap grid must use week-count CSS variable"
fi
if rg -n -U '\.repo-dashboard-heat-cell[^{]*\{[^}]*width:\s*100%' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heat cells must not stretch to 100% width"
fi
if ! rg -n 'aspect-ratio:\s*1\s*/\s*1' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard heat cells must keep square aspect ratio"
fi
if ! rg -n 'grid-template-columns: repeat\(var\(--heat-week-count[^)]+\),\s*var\(--heat-cell-size' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard heat grid must size cells explicitly"
fi
if rg -n 'scrollRef|scrollLeft|repo-dashboard-heat-scroll' src/tools/repoDashboard/RepoDashboardCharts.tsx src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not use horizontal scroll hacks"
fi
if rg -n -U '\.repo-dashboard-heat-(wrap|box|grid)[^{]*\{[^}]*overflow-x:\s*(auto|scroll)' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not use horizontal overflow scrolling"
fi
if ! rg -n 'HEATMAP_DISPLAY_WEEKS' src/tools/repoDashboard/model.ts src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  fail "Repo Dashboard heatmap must define display week cap"
fi
if rg -n 'heat-range-btn|HEATMAP_WINDOW_WEEKS|chooseHeatmapWindowWeeks|windowOverride' src/tools/repoDashboard/RepoDashboardCharts.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard heatmap must not expose window override controls"
fi
if ! rg -n 'repo-dashboard-work-primary-columns|repo-dashboard-work-column-scroll' src/tools/repoDashboard/RepoWorkWorkspace.tsx >"$ui_tmp"; then
  fail "Repo Dashboard work columns layout must exist"
fi
if rg -n 'repo-dashboard-work-column-active|repo-dashboard-work-active-columns|repo-dashboard-work-subcolumn' src/tools/repoDashboard src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard work column selectors must not return"
fi
if ! rg -n 'repo-dashboard-section-select' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard section select must exist"
fi
if ! rg -n 'density="default"' src/tools/repoDashboard/RepoActivityInsights.tsx >"$ui_tmp"; then
  fail "Repo Dashboard activity insights must use default heatmap density"
fi
if rg -n -U '\.repo-dashboard-workspace \{[^}]*overflow:\s*auto' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard workspace shell must not scroll as a whole"
fi
if rg -n -U '\.repo-dashboard-overview-lower \.repo-dashboard-latest-content[^{]*\{[^}]*overflow:\s*(auto|scroll)' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard latest content must not scroll independently"
fi
if rg -n -U '\.repo-dashboard-activity-insights-svg[^{]*\{[^}]*min-height:\s*[2-9][0-9]{2}px' src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard activity chart must not force oversized min-height"
fi
if rg -n -U '\.repo-dashboard-heat-aside \{[^}]*overflow:\s*auto' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard heat aside must not scroll independently"
fi
if rg -n 'hellq|PRIVATE|uxsmedjan|PRIVATE' src/tools/repoDashboard/model.ts >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard model must not embed personal identifiers"
fi
if ! rg -n 'WORK_ITEMS_DISPLAY_CAP|Showing first' src/tools/repoDashboard/RepoWorkWorkspace.tsx src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard work list must disclose display cap"
fi
if ! rg -n 'repo-dashboard-work-column-scroll \.repo-dashboard-list' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard work column scroll container must exist"
fi
if ! rg -n 'grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard work primary columns must use three-column grid"
fi
if ! rg -n -U '@media \(max-width: 1100px\)[\s\S]*\.repo-dashboard-work-primary-columns[\s\S]*grid-template-rows:\s*repeat\(3' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard work columns must stack on narrow viewports"
fi
if ! rg -n 'repo-dashboard-activity-chart-footer' src/tools/repoDashboard/RepoActivityInsights.tsx >"$ui_tmp"; then
  fail "Repo Dashboard activity chart footer must exist"
fi
if rg -n 'repo-dashboard-activity-insights-meta' src/tools/repoDashboard/RepoActivityInsights.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard activity meta row must not return"
fi
if ! rg -n '\[data-theme="light"\] \.repo-dashboard-heat-cell\.l1' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard light-theme heat cells must define level-1 color"
fi
if rg -n 'repo-dashboard-heat-aside' src/tools/repoDashboard src/styles.css >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard heat aside must not return"
fi
if rg -n 'repo-dashboard-heat-card|repo-dashboard-overview-mid|repo-dashboard-overview-full' src/styles.css src/tools/repoDashboard >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard overview layout selectors must not return"
fi
if ! rg -n 'repo-dashboard-activity-sidebar|repo-dashboard-overview-lower' src/styles.css >"$ui_tmp"; then
  fail "Repo Dashboard overview lower layout must exist"
fi
if rg -n 'Source health|buildSourceHealth' src/tools/repoDashboard/RepoDashboardTool.tsx src/tools/repoDashboard/model.ts >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard source health UI must not return"
fi
if rg -n '"activity"|"sources"|label: "Activity"|label: "Sources"' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "deprecated Repo Dashboard activity/sources tabs must not return"
fi
if ! rg -n 'label: "Docs"' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  fail "Repo Dashboard docs section label must exist"
fi
if ! rg -n 'prompt-loops-group-select' src/tools/promptLoops/PromptLoopsTool.tsx >"$ui_tmp"; then
  fail "Prompt Loops group select must exist"
fi

for obsolete in \
  'ToolsView' \
  'ToolsSwitcher' \
  'tools-view' \
  'tools-switcher-btn' \
  'tool-sidebar-footer' \
  'tool-sidebar-hints' \
  'tool-sidebar-status'; do
  if rg -n "$obsolete" src --glob '!**/*.test.*' >"$ui_tmp"; then
    cat "$ui_tmp" >&2
    fail "obsolete tools UI must not return: $obsolete"
  fi
done

if rg -n 'gh:\s*\{snapshot\.gh\.authenticated \? "enhanced"' src/tools/repoDashboard/RepoDashboardTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Repo Dashboard sidebar gh status must not return"
fi

if rg -n 'prompt-loops-pill">1–4|tool-sidebar-hints' src/tools/promptLoops/PromptLoopsTool.tsx >"$ui_tmp"; then
  cat "$ui_tmp" >&2
  fail "Prompt Loops shortcut hint block must not return"
fi

printf 'UI regression checks passed\n'
