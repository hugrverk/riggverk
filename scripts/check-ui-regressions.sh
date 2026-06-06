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
if ! rg -n 'repo-dashboard-heat-density-compact|--heat-week-count' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  fail "heatmap CSS must include compact density and --heat-week-count intrinsic width"
fi
if ! rg -n 'repo-dashboard-section-select' src/tools/repoDashboard/RepoDashboardTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Repo Dashboard must expose a narrow-layout section control"
fi
if ! rg -n 'density="default"' src/tools/repoDashboard/RepoDashboardTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Repo Dashboard overview heatmap must use default density"
fi
if rg -n -U '\.repo-dashboard-workspace \{[^}]*overflow:\s*auto' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  fail "repo-dashboard-workspace must not use overflow auto (nested scroll)"
fi
if rg -n -U '\.repo-dashboard-heat-aside \{[^}]*overflow:\s*auto' src/styles.css >/tmp/agent-workspace-ui-regressions.txt; then
  fail "repo-dashboard-heat-aside must not use overflow auto (nested scroll)"
fi
if rg -n 'hellq|PRIVATE|uxsmedjan|PRIVATE' src/tools/repoDashboard/model.ts >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
  fail "Repo Dashboard model must not hardcode personal author patterns"
fi
if ! rg -n 'WORK_ITEMS_DISPLAY_CAP|Showing first' src/tools/repoDashboard/RepoWorkWorkspace.tsx src/tools/repoDashboard/RepoDashboardTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Repo Dashboard work list must expose a user-facing display cap"
fi
if rg -n 'Source health|buildSourceHealth' src/tools/repoDashboard/RepoDashboardTool.tsx src/tools/repoDashboard/model.ts >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
  fail "Repo Dashboard must not render source health"
fi
if rg -n '"activity"|"sources"|label: "Activity"|label: "Sources"' src/tools/repoDashboard/RepoDashboardTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  cat /tmp/agent-workspace-ui-regressions.txt >&2
  fail "Repo Dashboard must use exactly three primary pages: overview, work, docs"
fi
if ! rg -n 'label: "Docs"' src/tools/repoDashboard/RepoDashboardTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Repo Dashboard must expose a Docs primary page"
fi
if ! rg -n 'prompt-loops-group-select' src/tools/promptLoops/PromptLoopsTool.tsx >/tmp/agent-workspace-ui-regressions.txt; then
  fail "Prompt Loops must expose a narrow-layout group control"
fi

rm -f /tmp/agent-workspace-ui-regressions.txt
printf 'UI regression checks passed\n'
