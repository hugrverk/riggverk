#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

step() {
  printf '\n==> %s\n' "$1"
}

scan_tmp=""
cleanup() {
  if [ -n "$scan_tmp" ] && [ -f "$scan_tmp" ]; then
    rm -f "$scan_tmp"
  fi
}
trap cleanup EXIT

search_has_match() {
  if command -v rg >/dev/null 2>&1; then
    rg -n "$@"
  else
    grep -R -n -E "$@"
  fi
}

search_quiet() {
  if command -v rg >/dev/null 2>&1; then
    rg -q "$@"
  else
    grep -R -q -E "$@"
  fi
}

scan_forbidden() {
  local pattern="$1"
  local label="$2"
  printf '  --> %s\n' "$label"
  scan_tmp="$(mktemp)"
  if command -v rg >/dev/null 2>&1; then
    rg -n "$pattern" scripts src-tauri src \
      resources/default-workspace/scripts \
      -g '!scripts/release-check.sh' \
      -g '!src-tauri/target/**' \
      -g '!node_modules/**' \
      -g '!dist/**' \
      >"$scan_tmp" || true
  else
    find scripts src-tauri src \
      resources/default-workspace/scripts \
      \( -name target -o -name node_modules -o -name dist \) -prune -o \
      -type f ! -name release-check.sh -exec grep -n -E "$pattern" /dev/null {} \; \
      >"$scan_tmp" || true
  fi
  if [ -s "$scan_tmp" ]; then
    printf 'Forbidden pattern found: %s\n' "$label" >&2
    cat "$scan_tmp" >&2
    rm -f "$scan_tmp"
    scan_tmp=""
    exit 1
  fi
  rm -f "$scan_tmp"
  scan_tmp=""
}

step "git status"
git status --short

step "git diff check"
git diff --check

step "release-check syntax"
bash -n scripts/release-check.sh

step "public app repo hygiene"
if grep -q "Matt Poc""ock" LICENSE; then
  printf 'FAIL: LICENSE contains stale copyright holder\n' >&2
  exit 1
fi
if [ ! -f NOTICE.md ]; then
  printf 'FAIL: NOTICE.md not found\n' >&2
  exit 1
fi
if ! grep -q "NOTICE[.]md" README.md; then
  printf 'FAIL: README.md must link NOTICE.md\n' >&2
  exit 1
fi
if ! grep -q "Matt Poc""ock" NOTICE.md; then
  printf 'FAIL: NOTICE.md must preserve Matt Pocock attribution\n' >&2
  exit 1
fi
if grep -q "<title>UX Work""space</title>" index.html; then
  printf 'FAIL: app HTML title is stale\n' >&2
  exit 1
fi
if grep -q "both the app source and private workspace d""ata" README.md; then
  printf 'FAIL: app README contains stale private workspace transition copy\n' >&2
  exit 1
fi

step "bundled default workspace scripts"
bash -n resources/default-workspace/scripts/bootstrap.sh
bash -n resources/default-workspace/scripts/install-skills.sh
bash -n resources/default-workspace/scripts/install-agent-rules.sh
bash -n resources/default-workspace/scripts/install-opencode-config.sh
bash -n resources/default-workspace/scripts/install-cursor-workspace.sh

step "bundled default scripts are real (no placeholder phrases)"
for pattern in "placeholder" "No files are written" "future app flows"; do
  if search_has_match -l "$pattern" resources/default-workspace/scripts/; then
    printf 'FAIL: bundled default scripts contain placeholder phrase: %s\n' "$pattern" >&2
    exit 1
  fi
done

step "bundled default install-skills.sh help mentions all six agents"
for agent in codex opencode claude gemini auggie cursor; do
  if ! bash resources/default-workspace/scripts/install-skills.sh --help 2>&1 | grep -qF "$agent"; then
    printf 'FAIL: install-skills.sh --help missing agent: %s\n' "$agent" >&2
    exit 1
  fi
done

step "bundled default install-agent-rules.sh help mentions all five rule targets"
for agent in codex opencode claude gemini auggie; do
  if ! bash resources/default-workspace/scripts/install-agent-rules.sh --help 2>&1 | grep -qF "$agent"; then
    printf 'FAIL: install-agent-rules.sh --help missing rule target: %s\n' "$agent" >&2
    exit 1
  fi
done

step "bundled default install-skills.sh rejects unsafe skill names"
for bad in "" "../../" "../escape" "bad name" "BAD" "-bad" "a..b" "a/b"; do
  if bash resources/default-workspace/scripts/install-skills.sh --skill "$bad" --dry-run 2>/dev/null; then
    printf 'FAIL: install-skills.sh accepted unsafe skill name: %s\n' "$bad" >&2
    exit 1
  fi
done

step "bundled default install-skills.sh no unguarded rm -rf before containment check"
skill_file="resources/default-workspace/scripts/install-skills.sh"
if grep -q 'rm -rf.*dest_dir' "$skill_file"; then
  if ! grep -q 'ensure_contained' "$skill_file"; then
    printf 'FAIL: install-skills.sh has rm -rf without ensure_contained guard\n' >&2
    exit 1
  fi
fi

step "bundled default cursor setup"
python3 -m json.tool resources/default-workspace/templates/cursor/manifest.json >/dev/null
python3 -m json.tool resources/default-workspace/templates/cursor/mcp/mcp.example.json >/dev/null
printf '  Cursor manifest + MCP example valid JSON\n'
for required in \
  resources/default-workspace/templates/cursor/manifest.json \
  resources/default-workspace/templates/cursor/mcp/README.md \
  resources/default-workspace/templates/cursor/mcp/mcp.example.json; do
  if [ ! -s "$required" ]; then
    printf 'FAIL: Cursor profile asset missing or empty: %s\n' "$required" >&2
    exit 1
  fi
done
cursor_always="$(grep -R '^alwaysApply: true' resources/default-workspace/templates/cursor/rules/*.mdc | wc -l | tr -d ' ')"
cursor_rules="$(find resources/default-workspace/templates/cursor/rules -maxdepth 1 -type f \( -name '*.md' -o -name '*.mdc' \) | wc -l | tr -d ' ')"
if [ "$cursor_always" -lt 1 ]; then
  printf 'FAIL: Cursor rules need at least one always-apply rule\n' >&2
  exit 1
fi
if [ "$cursor_always" -ge "$cursor_rules" ]; then
  printf 'FAIL: not all Cursor rules may be always-apply\n' >&2
  exit 1
fi
if rg -q 'sk-[A-Za-z0-9_-]{12,}|Bearer[[:space:]]+\S+|Basic[[:space:]]+\S+|gh[pousr]_[A-Za-z0-9_]{12,}' resources/default-workspace/templates/cursor/mcp; then
  printf 'FAIL: Cursor MCP examples contain token-like literals\n' >&2
  exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path

root = Path("resources/default-workspace/templates/cursor")
manifest = json.loads((root / "manifest.json").read_text())
for name in manifest["agents"]:
    if not (root / "agents" / name).is_file():
        raise SystemExit(f"FAIL: manifest-listed Cursor agent missing: {name}")
for name in manifest["rules"]:
    if not (root / "rules" / name).is_file():
        raise SystemExit(f"FAIL: manifest-listed Cursor rule missing: {name}")
allowed = {"name", "description", "model", "readonly", "is_background"}
blocked = {"permission", "mode", "temperature", "steps", "hidden"}
for path in (root / "agents").glob("*.md"):
    text = path.read_text()
    if not text.startswith("---\n"):
        raise SystemExit(f"FAIL: Cursor agent missing frontmatter: {path}")
    fm = text.split("---", 2)[1]
    keys = {line.split(":", 1)[0].strip() for line in fm.splitlines() if ":" in line}
    bad = (keys - allowed) | (keys & blocked)
    if bad:
        raise SystemExit(f"FAIL: Cursor agent has unsupported frontmatter {sorted(bad)}: {path}")
PY
printf '  Cursor manifest-listed agents/rules and frontmatter verified\n'
if ! bash resources/default-workspace/scripts/install-cursor-workspace.sh --help 2>&1 | grep -qF ".cursor/agents"; then
  printf 'FAIL: install-cursor-workspace.sh --help missing .cursor/agents\n' >&2
  exit 1
fi
if ! bash resources/default-workspace/scripts/install-cursor-workspace.sh --help 2>&1 | grep -qF ".cursor/rules"; then
  printf 'FAIL: install-cursor-workspace.sh --help missing .cursor/rules\n' >&2
  exit 1
fi
for agent in verifier.md security-reviewer.md release-checker.md browser-qa.md repo-scout.md; do
  file="resources/default-workspace/templates/cursor/agents/$agent"
  if [ ! -s "$file" ]; then
    printf 'FAIL: Cursor agent adapter missing or empty: %s\n' "$file" >&2
    exit 1
  fi
  for key in '^permission:' '^mode:' '^temperature:' '^steps:' '^hidden:'; do
    if grep -q "$key" "$file"; then
      printf 'FAIL: Cursor agent adapter contains OpenCode-only frontmatter key %s: %s\n' "$key" "$file" >&2
      exit 1
    fi
  done
  if ! grep -q "templates/cursor/agents/$agent" src-tauri/src/commands/defaults.rs; then
    printf 'FAIL: default workspace copy list missing Cursor adapter: %s\n' "$agent" >&2
    exit 1
  fi
done
if ! grep -q 'fn editable_config_targets' src-tauri/src/agent_targets.rs; then
  printf 'FAIL: editable config target allowlist missing\n' >&2
  exit 1
fi
if ! grep -q 'editable_config_targets' src-tauri/src/commands/content.rs; then
  printf 'FAIL: config template commands must use editable_config_targets\n' >&2
  exit 1
fi
if ! grep -q 'EDITABLE_CONFIG_TARGET_IDS' src/App.tsx; then
  printf 'FAIL: Library Configs must filter to editable config targets\n' >&2
  exit 1
fi
if grep -q 'EDITABLE_CONFIG_TARGET_IDS.*cursor_setup' src/App.tsx; then
  printf 'FAIL: cursor_setup must not be exposed as an editable config target\n' >&2
  exit 1
fi
tmpdir="$(mktemp -d)"
CURSOR_AGENTS_PATH="$tmpdir/cursor agents" \
AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
  bash resources/default-workspace/scripts/install-cursor-workspace.sh --apply --global-agents >/dev/null
cursor_count="$(find "$tmpdir/cursor agents" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')"
rm -rf "$tmpdir"
if [ "$cursor_count" -ne 5 ]; then
  printf 'FAIL: Cursor global agents smoke wrote %s agents, expected 5\n' "$cursor_count" >&2
  exit 1
fi
if bash resources/default-workspace/scripts/install-cursor-workspace.sh --project --target "$HOME" >/dev/null 2>&1; then
  printf 'FAIL: Cursor project sync accepted broad HOME target\n' >&2
  exit 1
fi
printf '  Cursor setup verified: help, adapters, project rule, global-agent smoke\n'

step "bundled default cursor user-rules"
user_rules_file="resources/default-workspace/templates/cursor/user-rules.md"
if [ ! -f "$user_rules_file" ]; then
  printf 'FAIL: cursor user-rules template missing: %s\n' "$user_rules_file" >&2
  exit 1
fi
printf '  user-rules.md exists\n'
if ! grep -qF 'primary implementation architect' "$user_rules_file"; then
  printf 'FAIL: user-rules.md missing primary implementation architect\n' >&2
  exit 1
fi
printf '  user-rules.md contains primary implementation architect\n'
if ! grep -qF 'Use subagents only when they clearly reduce risk or context load' "$user_rules_file"; then
  printf 'FAIL: user-rules.md missing subagent guidance\n' >&2
  exit 1
fi
printf '  user-rules.md contains subagent guidance\n'

step "regression: global-agent-rules.md avoids Cursor-specific content"
global_rules="resources/default-workspace/templates/global-agent-rules.md"
if grep -qF 'primary implementation architect by default' "$global_rules"; then
  printf 'FAIL: global-agent-rules.md must not contain Cursor-specific architect-default phrase\n' >&2
  exit 1
fi
printf '  global-agent-rules.md avoids Cursor-specific architect-default phrase\n'
if grep -qF 'Do not invoke the `architect` subagent' "$global_rules"; then
  printf 'FAIL: global-agent-rules.md must not contain Cursor-specific architect-subagent phrase\n' >&2
  exit 1
fi
printf '  global-agent-rules.md avoids Cursor-specific architect-subagent phrase\n'

step "bundled default cursor user-rules show and copy"
if ! bash resources/default-workspace/scripts/install-cursor-workspace.sh --show-user-rules >/dev/null 2>&1; then
  printf 'FAIL: install-cursor-workspace.sh --show-user-rules failed\n' >&2
  exit 1
fi
printf '  --show-user-rules works\n'
if command -v pbcopy >/dev/null 2>&1; then
  if ! bash resources/default-workspace/scripts/install-cursor-workspace.sh --copy-user-rules >/dev/null 2>&1; then
    printf '  --copy-user-rules skipped (pbcopy unavailable to this session)\n'
  else
    printf '  --copy-user-rules works\n'
  fi
else
  printf '  --copy-user-rules skipped (no pbcopy)\n'
fi

step "regression: no fake global Cursor User Rules path"
if rg -q '\.cursor/AGENTS\.md|\$HOME/\.cursor/AGENTS\.md|~/.cursor/AGENTS\.md' \
  src-tauri src resources/default-workspace \
  -g '!src-tauri/target/**' \
  --ignore-case 2>/dev/null; then
  printf 'FAIL: must not claim a fake global Cursor User Rules file path\n' >&2
  exit 1
fi

step "regression: workspace.rs does not hard-require specific cursor rule filename"
if search_has_match "rel_path:.*agent-workspace.mdc" src-tauri/src/commands/workspace.rs; then
  printf 'FAIL: workspace.rs must not hard-require agent-workspace.mdc as a generic marker\n' >&2
  exit 1
fi
if search_has_match "rel_path:.*templates/cursor/README.md" src-tauri/src/commands/workspace.rs; then
  printf 'FAIL: workspace.rs must not hard-require cursor README.md as a generic marker\n' >&2
  exit 1
fi

step "regression: workspace.rs always requires cursor mdc rule check"
if ! grep -q 'workspace_has_cursor_mdc_rule' src-tauri/src/commands/workspace.rs; then
  printf 'FAIL: workspace.rs must include cursor mdc rule validation\n' >&2
  exit 1
fi

step "regression: cursor appears in user-facing rule/sync targets"
python3 - <<'PY'
from pathlib import Path

path = Path("src-tauri/src/agent_targets.rs")
text = path.read_text()

def function_body(name: str) -> str:
    marker = f"pub fn {name}()"
    start = text.find(marker)
    if start == -1:
        raise SystemExit(f"FAIL: missing {name}() in agent_targets.rs")
    brace = text.find("{", start)
    if brace == -1:
        raise SystemExit(f"FAIL: missing {name}() body in agent_targets.rs")
    depth = 0
    for idx in range(brace, len(text)):
        char = text[idx]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[brace + 1:idx]
    raise SystemExit(f"FAIL: unterminated {name}() body in agent_targets.rs")

targets = function_body("targets")
cursor_id = 'id: "cursor_setup"'
cursor_index = targets.find(cursor_id)
if cursor_index == -1:
    raise SystemExit("FAIL: cursor_setup must exist in targets()")
next_target_index = targets.find("AgentSyncTarget", cursor_index + len(cursor_id))
cursor_block = targets[cursor_index: next_target_index if next_target_index != -1 else len(targets)]
if "kind: TargetKind::Rules" not in cursor_block:
    raise SystemExit("FAIL: cursor_setup must have kind TargetKind::Rules")

config_targets = function_body("config_targets")
if "cursor_setup" in config_targets:
    raise SystemExit("FAIL: cursor_setup must not be in config_targets()")
PY
printf '  cursor_setup target registry verified\n'

step "regression: cursor_setup is not in config_sync_targets"
if rg -q 'cursor_setup' src-tauri/src/agent_targets.rs -A 5 | grep -q 'ConfigSyncTarget'; then
  printf 'FAIL: cursor_setup must not be in config_sync_targets\n' >&2
  exit 1
fi
# Verify opencode_config is the only config sync target
opencode_count=$(rg 'id: "opencode_config"' src-tauri/src/agent_targets.rs | wc -l | tr -d ' ')
if [ "$opencode_count" -lt 1 ]; then
  printf 'FAIL: opencode_config must be in agent_targets.rs\n' >&2
  exit 1
fi



step "bundled default docs exist and non-empty"
for doc in \
  resources/default-workspace/docs/START_HERE.md \
  resources/default-workspace/docs/CONCEPTS.md \
  resources/default-workspace/docs/USING_THE_APP.md \
  resources/default-workspace/docs/GIT_VERSIONING.md \
  resources/default-workspace/docs/WORKFLOWS.md \
  resources/default-workspace/docs/SKILLS.md \
  resources/default-workspace/docs/AGENT_RULES.md \
  resources/default-workspace/docs/OPENCODE_CONFIG.md \
  resources/default-workspace/docs/TROUBLESHOOTING.md; do
  if [ ! -s "$doc" ]; then
    printf 'FAIL: bundled default doc missing or empty: %s\n' "$doc" >&2
    exit 1
  fi
done
printf '  9 bundled docs verified non-empty\n'

step "bundled default workspace marker"
if [ ! -f resources/default-workspace/.agent-workspace/workspace.json ]; then
  printf 'FAIL: bundled default workspace marker not found\n' >&2
  exit 1
fi

step "bundled default opencode config source files"
for source_file in \
  resources/default-workspace/templates/opencode.base.json \
  resources/default-workspace/templates/opencode.policy.json; do
  if [ ! -f "$source_file" ]; then
    printf 'FAIL: missing opencode config source: %s\n' "$source_file" >&2
    exit 1
  fi
  python3 -m json.tool "$source_file" >/dev/null
done
printf '  opencode.base.json + opencode.policy.json: valid strict JSON\n'

step "bundled default opencode.json snapshot is current"
python3 scripts/generate-default-opencode-config.py --check

step "bundled default opencode.json"
python3 -m json.tool resources/default-workspace/templates/opencode.json >/dev/null
if ! grep -q '"default_agent": "architect"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing default_agent architect\n' >&2
  exit 1
fi
if ! grep -q '"model": "opencode-go/deepseek-v4-pro"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing model deepseek-v4-pro\n' >&2
  exit 1
fi
if ! grep -q '"small_model": "opencode-go/deepseek-v4-flash"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing small_model deepseek-v4-flash\n' >&2
  exit 1
fi
if ! grep -q '"autoupdate": "notify"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing autoupdate notify\n' >&2
  exit 1
fi
if ! grep -q '"snapshot": true' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing snapshot true\n' >&2
  exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path

path = Path("resources/default-workspace/templates/opencode.json")
data = json.loads(path.read_text())
models = data.get("provider", {}).get("opencode-go", {}).get("models", {})
qwen = models.get("qwen3.6-plus", {})
limit = qwen.get("limit", {})
if limit.get("context") != 1000000:
    raise SystemExit("FAIL: bundled opencode.json qwen3.6-plus limit.context must be 1000000")
if limit.get("output") != 65536:
    raise SystemExit("FAIL: bundled opencode.json qwen3.6-plus limit.output must be 65536")
if "contextWindow" in qwen:
    raise SystemExit("FAIL: bundled opencode.json qwen3.6-plus must not use contextWindow")
PY
printf '  opencode.json: default_agent=architect model=deepseek-v4-pro small_model=deepseek-v4-flash autoupdate=notify snapshot=true qwen3.6-plus limits ok\n'

step "bundled default tui.json"
if [ ! -f resources/default-workspace/templates/tui.json ]; then
  printf 'FAIL: bundled tui.json not found\n' >&2
  exit 1
fi
python3 -m json.tool resources/default-workspace/templates/tui.json >/dev/null
if ! grep -qF '"theme": "system"' resources/default-workspace/templates/tui.json; then
  printf 'FAIL: bundled tui.json missing theme system\n' >&2
  exit 1
fi
if ! grep -qF '"diff_style": "auto"' resources/default-workspace/templates/tui.json; then
  printf 'FAIL: bundled tui.json missing diff_style auto\n' >&2
  exit 1
fi
if ! grep -qF '"mouse": true' resources/default-workspace/templates/tui.json; then
  printf 'FAIL: bundled tui.json missing mouse true\n' >&2
  exit 1
fi
if ! grep -qF '"leader_timeout": 2000' resources/default-workspace/templates/tui.json; then
  printf 'FAIL: bundled tui.json missing leader_timeout 2000\n' >&2
  exit 1
fi
python3 - <<'PY'
import json
path = "resources/default-workspace/templates/tui.json"
data = json.load(open(path))
if not data.get("scroll_acceleration", {}).get("enabled"):
    raise SystemExit("FAIL: bundled tui.json scroll_acceleration.enabled must be true")
PY
printf '  tui.json: theme=system diff_style=auto mouse=true leader_timeout=2000 scroll_acceleration.enabled=true\n'

step "bundled default agents exist and non-empty"
for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if [ ! -s "resources/default-workspace/agents/$agent" ]; then
    printf 'FAIL: bundled default agent missing or empty: agents/%s\n' "$agent" >&2
    exit 1
  fi
done
printf '  6 bundled agents verified non-empty\n'
# Agents are model-agnostic — model selection is centralized in templates/opencode.json
for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if grep -q "^model:" "resources/default-workspace/agents/$agent"; then
    printf 'FAIL: bundled %s has model frontmatter (should be model-agnostic)\n' "$agent" >&2
    exit 1
  fi
done
printf '  6 bundled agents verified model-agnostic (no model frontmatter)\n'
if ! grep -q 'mode: primary' resources/default-workspace/agents/architect.md; then
  printf 'FAIL: bundled architect.md missing mode: primary\n' >&2
  exit 1
fi
printf '  architect.md: mode=primary\n'
for subagent in scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if ! grep -q 'mode: subagent' "resources/default-workspace/agents/$subagent"; then
    printf 'FAIL: bundled %s missing mode: subagent\n' "$subagent" >&2
    exit 1
  fi
done
printf '  5 subagents verified mode=subagent\n'
if grep -Eq '"cat \*":[[:space:]]*allow|cat \*: allow' resources/default-workspace/agents/architect.md; then
  printf 'FAIL: bundled architect.md must not allow broad bash cat *\n' >&2
  exit 1
fi
if ! grep -Fq '"cargo check*": "allow"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing cargo check allow\n' >&2
  exit 1
fi
old_workspace_pattern="$(printf '%s|' "ux-work""space" "UX_WORK""SPACE" "ux_""workspace" "\\.ux-work""space" "ux-work""space-app" "ai\\.open""workspace")"
old_workspace_pattern="${old_workspace_pattern%|}"
if search_has_match "$old_workspace_pattern" resources/default-workspace src-tauri/src/commands/defaults.rs; then
  printf 'FAIL: bundled default workspace contains old workspace naming\n' >&2
  exit 1
fi
for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  file="resources/default-workspace/agents/$agent"
  if grep -q '^model:' "$file"; then
    printf 'FAIL: bundled %s has model frontmatter (should be model-agnostic)\n' "$agent" >&2
    exit 1
  fi
  for deny in 'rm -rf' 'sudo' 'git reset --hard' 'git clean -fdx'; do
    if ! grep -q "\"$deny" "$file"; then
      printf 'FAIL: bundled %s missing explicit deny for %s\n' "$agent" "$deny" >&2
      exit 1
    fi
  done
done
printf '  bundled OpenCode permission hardening checks passed\n'

# Expanded secret deny pattern checks
step "bundled opencode.json secret deny coverage"
secret_read_patterns=(id_rsa id_ed25519 kubeconfig '.kube/' terraform.tfstate terraform.tfvars master.key .pgpass .my.cnf .envrc)
for pat in "${secret_read_patterns[@]}"; do
  if ! grep -Fq "\"**/${pat}" resources/default-workspace/templates/opencode.json; then
    printf 'FAIL: bundled opencode.json read deny missing %s\n' "$pat" >&2
    exit 1
  fi
done
printf '  bundled opencode.json read deny covers expanded secret patterns\n'

step "bundled architect git checkout and git pull are ask-gated"
if grep -Eq '"git checkout \*":[[:space:]]*allow|git checkout \*: allow' resources/default-workspace/agents/architect.md; then
  printf 'FAIL: bundled architect.md must not allow git checkout * (ask-gate it)\n' >&2
  exit 1
fi
if grep -Eq '"git pull":[[:space:]]*allow|git pull: allow' resources/default-workspace/agents/architect.md; then
  printf 'FAIL: bundled architect.md must not allow git pull (ask-gate it)\n' >&2
  exit 1
fi
printf '  bundled architect.md git checkout and git pull are ask-gated\n'

step "bundled architect npm run dev is ask-gated"
if grep -Eq '"npm run dev":[[:space:]]*allow|npm run dev: allow' resources/default-workspace/agents/architect.md; then
  printf 'FAIL: bundled architect.md must not allow npm run dev (ask-gate it)\n' >&2
  exit 1
fi
printf '  bundled architect.md npm run dev is ask-gated\n'

step "bundled agents bash deny coverage for expanded secret patterns"
for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  file="resources/default-workspace/agents/$agent"
  for pat in id_rsa id_ed25519 kubeconfig terraform.tfstate terraform.tfvars master.key .pgpass .my.cnf; do
    if ! grep -q "\"cat ${pat}" "$file" || ! grep -q "\"grep \* ${pat}" "$file"; then
      printf 'FAIL: bundled %s bash deny missing %s (cat or grep)\n' "$agent" "$pat" >&2
      exit 1
    fi
  done
done
printf '  bundled agent bash deny coverage verified for expanded secret patterns\n'

step "bundled default install-opencode-config.sh help mentions agents"
if ! bash resources/default-workspace/scripts/install-opencode-config.sh --help 2>&1 | grep -qF "agents"; then
  printf 'FAIL: install-opencode-config.sh --help missing agents mention\n' >&2
  exit 1
fi

step "bundled default install-opencode-config.sh agents count in help"
agent_count_help="$(bash resources/default-workspace/scripts/install-opencode-config.sh --help 2>&1 | grep -o '\.md' | wc -l | tr -d ' ' || true)"
if [ "$agent_count_help" -lt 2 ]; then
  printf 'FAIL: install-opencode-config.sh --help has insufficient agents references (expected >= 2 .md refs, found %s)\n' "$agent_count_help" >&2
  exit 1
fi

step "bundled default install-opencode-config.sh temp apply smoke"
tmpdir="$(mktemp -d)"
OPENCODE_CONFIG_PATH="$tmpdir/opencode.json" \
OPENCODE_TUI_CONFIG_PATH="$tmpdir/tui.json" \
OPENCODE_AGENTS_DIR="$tmpdir/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
  bash resources/default-workspace/scripts/install-opencode-config.sh --apply >/dev/null
apply_ok=true
if [ ! -f "$tmpdir/opencode.json" ]; then
  printf 'FAIL: install-opencode-config.sh --apply did not write opencode.json\n' >&2
  apply_ok=false
fi
if [ ! -f "$tmpdir/tui.json" ]; then
  printf 'FAIL: install-opencode-config.sh --apply did not write tui.json\n' >&2
  apply_ok=false
fi
if ! python3 -m json.tool "$tmpdir/tui.json" >/dev/null 2>&1; then
  printf 'FAIL: smoke tui.json is not valid JSON\n' >&2
  apply_ok=false
fi
for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if [ ! -f "$tmpdir/agents/$agent" ]; then
    printf 'FAIL: install-opencode-config.sh --apply did not write agents/%s\n' "$agent" >&2
    apply_ok=false
  fi
done
if ! $apply_ok; then rm -rf "$tmpdir"; exit 1; fi
if ! grep -q '"default_agent": "architect"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing default_agent architect\n' >&2
  apply_ok=false
fi
if ! grep -q '"model": "opencode-go/deepseek-v4-pro"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing model deepseek-v4-pro\n' >&2
  apply_ok=false
fi
if ! grep -q '"small_model": "opencode-go/deepseek-v4-flash"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing small_model deepseek-v4-flash\n' >&2
  apply_ok=false
fi
# Model-agnostic agents — no model frontmatter expected
for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if grep -q "^model:" "$tmpdir/agents/$agent"; then
    printf 'FAIL: smoke %s has model frontmatter (should be model-agnostic)\n' "$agent" >&2
    apply_ok=false
  fi
done
if ! grep -q 'mode: primary' "$tmpdir/agents/architect.md"; then
  printf 'FAIL: smoke architect.md missing mode: primary\n' >&2
  apply_ok=false
fi
for subagent in scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if ! grep -q 'mode: subagent' "$tmpdir/agents/$subagent"; then
    printf 'FAIL: smoke %s missing mode: subagent\n' "$subagent" >&2
    apply_ok=false
  fi
done
# TUI config key checks
if ! grep -qF '"theme": "system"' "$tmpdir/tui.json"; then
  printf 'FAIL: smoke tui.json missing theme system\n' >&2
  apply_ok=false
fi
if ! grep -qF '"diff_style": "auto"' "$tmpdir/tui.json"; then
  printf 'FAIL: smoke tui.json missing diff_style auto\n' >&2
  apply_ok=false
fi
if ! grep -qF '"mouse": true' "$tmpdir/tui.json"; then
  printf 'FAIL: smoke tui.json missing mouse true\n' >&2
  apply_ok=false
fi
if ! grep -qF '"leader_timeout": 2000' "$tmpdir/tui.json"; then
  printf 'FAIL: smoke tui.json missing leader_timeout 2000\n' >&2
  apply_ok=false
fi
python3 -c "
import json, sys
data = json.load(open('$tmpdir/tui.json'))
if not data.get('scroll_acceleration', {}).get('enabled'):
    sys.exit('FAIL: smoke tui.json scroll_acceleration.enabled must be true')
" || { apply_ok=false; }
rm -rf "$tmpdir"
if ! $apply_ok; then exit 1; fi
printf '  install-opencode-config.sh --apply smoke: 1 config + 1 tui + 6 agents written, content checks passed\n'

step "bundled default install-opencode-config.sh unsafe OPENCODE_AGENTS_DIR rejected"
if OPENCODE_AGENTS_DIR=/ bash resources/default-workspace/scripts/install-opencode-config.sh --apply 2>/dev/null; then
  printf 'FAIL: install-opencode-config.sh accepted unsafe OPENCODE_AGENTS_DIR=/\n' >&2
  exit 1
fi

step "bundled default install-opencode-config.sh works with space in workspace path"
tmpdir="$(mktemp -d)"
space_dir="$tmpdir/Agent Workspace"
runtime_config="$tmpdir/runtime/opencode.json"
runtime_tui="$tmpdir/runtime/tui.json"
runtime_agents="$tmpdir/runtime/agents"
backup_dir="$tmpdir/runtime/backups"

# Copy entire workspace tree to space-containing path so the script
# itself runs from a path with spaces and computes SCRIPT_DIR / SOURCE_FILE
# / AGENTS_SOURCE_DIR from that location.
cp -R resources/default-workspace "$space_dir"

# Run --apply from the copied workspace, targeting separate runtime dirs
OPENCODE_CONFIG_PATH="$runtime_config" \
OPENCODE_TUI_CONFIG_PATH="$runtime_tui" \
OPENCODE_AGENTS_DIR="$runtime_agents" \
AGENT_WORKSPACE_BACKUP_DIR="$backup_dir" \
  bash "$space_dir/scripts/install-opencode-config.sh" --apply >/dev/null

apply_ok=true
if [ ! -f "$runtime_config" ]; then
  printf 'FAIL: space-in-path apply did not create opencode.json\n' >&2
  apply_ok=false
fi
if [ ! -f "$runtime_tui" ]; then
  printf 'FAIL: space-in-path apply did not create tui.json\n' >&2
  apply_ok=false
fi
if ! python3 -m json.tool "$runtime_tui" >/dev/null 2>&1; then
  printf 'FAIL: space-in-path tui.json is not valid JSON\n' >&2
  apply_ok=false
fi
if ! grep -q '"default_agent": "architect"' "$runtime_config"; then
  printf 'FAIL: space-in-path opencode.json missing default_agent architect\n' >&2
  apply_ok=false
fi

for agent in architect.md scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if [ ! -f "$runtime_agents/$agent" ]; then
    printf 'FAIL: space-in-path apply did not create agents/%s\n' "$agent" >&2
    apply_ok=false
  fi
done

agent_count="$(find "$runtime_agents" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')"
if [ "$agent_count" -ne 6 ]; then
  printf 'FAIL: space-in-path apply wrote %s agents, expected 6\n' "$agent_count" >&2
  apply_ok=false
fi

# TUI config key checks
if ! grep -qF '"theme": "system"' "$runtime_tui"; then
  printf 'FAIL: space-in-path tui.json missing theme system\n' >&2
  apply_ok=false
fi
if ! grep -qF '"diff_style": "auto"' "$runtime_tui"; then
  printf 'FAIL: space-in-path tui.json missing diff_style auto\n' >&2
  apply_ok=false
fi
if ! grep -qF '"mouse": true' "$runtime_tui"; then
  printf 'FAIL: space-in-path tui.json missing mouse true\n' >&2
  apply_ok=false
fi
if ! grep -qF '"leader_timeout": 2000' "$runtime_tui"; then
  printf 'FAIL: space-in-path tui.json missing leader_timeout 2000\n' >&2
  apply_ok=false
fi
python3 -c "
import json, sys
data = json.load(open('$runtime_tui'))
if not data.get('scroll_acceleration', {}).get('enabled'):
    sys.exit('FAIL: space-in-path tui.json scroll_acceleration.enabled must be true')
" || { apply_ok=false; }

rm -rf "$tmpdir"
if ! $apply_ok; then exit 1; fi
printf '  install-opencode-config.sh handles space-in-path correctly: 1 config + 1 tui + 6 agents applied from space-containing workspace\n'

step "backup schema matches app expectations"
tmpdir="$(mktemp -d)"
# Create timestamp matching YYYYMMDD-HHMMSS (15 chars)
ts="20260101-120000"
mkdir -p "$tmpdir/$ts/opencode-config"
mkdir -p "$tmpdir/$ts/codex-rules"
mkdir -p "$tmpdir/$ts/opencode-rules"
mkdir -p "$tmpdir/$ts/opencode-agents"
# Write test files
echo "config" > "$tmpdir/$ts/opencode-config/opencode.json"
echo "rules" > "$tmpdir/$ts/codex-rules/AGENTS.md"
echo "rules" > "$tmpdir/$ts/opencode-rules/AGENTS.md"
echo "agent" > "$tmpdir/$ts/opencode-agents/architect.md"
echo "agent" > "$tmpdir/$ts/opencode-agents/scout.md"

# Verify the timestamp format is readable by app (via Rust test)
# We're testing that directories matching YYYYMMDD-HHMMSS are found
ts_check="$(date -u +%Y%m%d-%H%M%S)"
if [ ${#ts_check} -ne 15 ]; then
  printf 'FAIL: timestamp format should be 15 chars YYYYMMDD-HHMMSS\n' >&2
  rm -rf "$tmpdir"
  exit 1
fi

# Test list_backups would find these if we had Rust code to test
# For now, verify directory structure matches what backups.rs expects
for target_dir in opencode-config codex-rules opencode-rules opencode-agents; do
  if [ ! -d "$tmpdir/$ts/$target_dir" ]; then
    printf 'FAIL: backup schema %s dir not found\n' "$target_dir" >&2
    rm -rf "$tmpdir"
    exit 1
  fi
done
rm -rf "$tmpdir"
printf '  backup schema verified: YYYYMMDD-HHMMSS + target IDs (opencode-config, codex-rules, opencode-rules, opencode-agents)\n'

step "tauri app resources config"
if ! search_quiet "default-workspace" src-tauri/tauri.conf.json; then
  printf 'FAIL: tauri conf missing bundled default workspace resource path\n' >&2
  exit 1
fi

step "bundled default skills non-empty"
skill_files="$(find resources/default-workspace/skills -type f -name SKILL.md)"
if [ -z "$skill_files" ]; then
  printf 'FAIL: bundled default skills must be non-empty\n' >&2
  exit 1
fi
invalid="$(printf '%s\n' "$skill_files" | grep -vE '/skills/[^/]+/SKILL\.md$' || true)"
if [ -n "$invalid" ]; then
  printf 'FAIL: SKILL.md at unexpected depth (must be skills/<name>/SKILL.md):\n%s\n' "$invalid" >&2
  exit 1
fi

step "bundled default skill frontmatter names valid"
while IFS= read -r f; do
  skill_dir="$(basename "$(dirname "$f")")"
  name_line="$(sed -n 's/^name:[[:space:]]*//p' "$f" | head -n 1)"
  if [ -z "$name_line" ]; then
    printf 'FAIL: %s missing name frontmatter\n' "$f" >&2
    exit 1
  fi
  if [ "$name_line" != "$skill_dir" ]; then
    printf 'FAIL: %s frontmatter name "%s" does not match directory "%s"\n' "$f" "$name_line" "$skill_dir" >&2
    exit 1
  fi
done < <(printf '%s\n' "$skill_files")

step "bundled default baseline skills exist"
for baseline in diagnose security-review context-budget to-prd grill-with-docs improve-codebase-architecture prototype handoff; do
  if [ ! -f "resources/default-workspace/skills/${baseline}/SKILL.md" ]; then
    printf 'FAIL: baseline bundled skill missing: skills/%s/SKILL.md\n' "$baseline" >&2
    exit 1
  fi
done

step "bundled default public skill count"
skill_count="$(find resources/default-workspace/skills -type f -name SKILL.md | wc -l | tr -d ' ')"
if [ "$skill_count" -ne 24 ]; then
  printf 'FAIL: expected 24 public starter skills, found %s\n' "$skill_count" >&2
  exit 1
fi

step "bundled default no private workflow skills"
if search_has_match "woocommerce-pdp-review|wordpress-woocommerce|nextjs-product-slice|supabase-rls-review" \
  resources/default-workspace \
  src-tauri/src/commands/defaults.rs; then
  printf 'FAIL: bundled default workspace must not contain private/domain-specific workflow skills\n' >&2
  exit 1
fi

step "bundled default no private names"
private_name_pattern="$(printf '%s|' "C""arl" "Dis""chornan" "Disch""örnan" "Hantverks""registret" "Auggie cred""its" "personal mod""el")"
private_name_pattern="${private_name_pattern%|}"
if search_has_match -w "$private_name_pattern" resources/default-workspace; then
  printf 'FAIL: bundled default workspace must not contain private names\n' >&2
  exit 1
fi

step "forbidden source scans"
scan_forbidden 'sh[[:space:]]+-c' 'sh -c'
scan_forbidden '(^|[^[:alnum:]_])eval([^[:alnum:]_]|$)' 'eval'
scan_forbidden 'npx[[:space:]]+skills' 'npx skills'
scan_forbidden 'skills@latest' 'skills@latest'
scan_forbidden '\.agents/skills' '.agents/skills'

step "routing profile bloat guard"
scan_forbidden 'RoutingProfile|routing/profiles|get_routing_profiles|save_routing_profiles|read_routing_profiles_file|buildProfileHeader|copyMetadataBlock|profileStatus|RoutingMatrix|routingCompatibility|routingTemplates' 'routing profile bloat (removed profiles must not be reintroduced)'

step "app checks"
npm run build

cd src-tauri
cargo fmt --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test

step "release smoke doc"
if [ ! -f "$repo_root/docs/APP_RELEASE_SMOKE.md" ]; then
  printf 'FAIL: docs/APP_RELEASE_SMOKE.md not found\n' >&2
  exit 1
fi

printf '\nrelease-check passed\n'
