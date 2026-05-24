#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

if rg -n 'box-shadow:[^;]*inset (2px 0|0 -2px)' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
  fail "heavy inset selected-state bars are not allowed"
fi

if rg -n 'border-left:[^;]*2px solid (var\(--accent\)|currentColor)' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
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
  if rg -n "$selector" src >/tmp/agent-workspace-ui-regressions.txt; then
    cat /tmp/agent-workspace-ui-regressions.txt >&2
    fail "deprecated UI selector still present: $selector"
  fi
done

if rg -n '>Overview<|\{SECTIONS\.find\(s => s\.id === section\)\?\.label' src/tools/repoDashboard/RepoDashboardTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
  fail "Repo Dashboard must not render a redundant section heading below the path controls"
fi

if ! rg -n -U '\.brain-setup-lib-body \.copyable-block-content \{[^}]*overflow: auto;' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Brain Setup Library content must define a local scroll container"
fi

if ! rg -n 'data-app-font-size' src/lib/settingsDraft.ts >/tmp/agent-workspace-ui-regressions.txt; then
  fail "app font-size setting must set a root data attribute"
fi
if ! rg -n -- '--app-font-size|--app-font-scale' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  fail "app font-size setting must drive CSS variables"
fi
if ! rg -n 'Global app text size' src/views/SettingsView.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Settings must expose a labeled global app text size control"
fi

if rg -n -U '\.repo-dashboard-heat-(scroll|wrap|box|grid)[^{]*\{[^}]*overflow-y:\s*(auto|scroll)' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
  fail "heatmap wrappers must not use vertical overflow scrolling"
fi
if ! rg -n 'repo-dashboard-heat-density-' src/tools/repoDashboard/RepoDashboardCharts.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "ActivityHeatmap must expose compact/default density classes"
fi
if ! rg -n 'ActivityHeatmapDensity|density=' src/tools/repoDashboard/RepoDashboardCharts.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "ActivityHeatmap must support a density prop"
fi
if ! rg -n 'repo-dashboard-heat-density-compact|flex: 1 1 0' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  fail "heatmap CSS must include compact density and responsive week columns"
fi

rm -f /tmp/agent-workspace-ui-regressions.txt
printf 'UI regression checks passed\n'
