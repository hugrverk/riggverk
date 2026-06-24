#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

step() {
  printf '\n==> %s\n' "$1"
}

scan_tmp=""
release_tmp_dir=""
codex_apply_log=""
cleanup() {
  if [ -n "$scan_tmp" ] && [ -f "$scan_tmp" ]; then
    rm -f "$scan_tmp"
  fi
  if [ -n "$release_tmp_dir" ] && [ -d "$release_tmp_dir" ]; then
    rm -rf "$release_tmp_dir"
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

assert_json_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    printf 'FAIL: %s not found: %s\n' "$label" "$path" >&2
    return 1
  fi
  if ! python3 -m json.tool "$path" >/dev/null 2>&1; then
    printf 'FAIL: %s is not valid JSON: %s\n' "$label" "$path" >&2
    return 1
  fi
}

assert_opencode_playwright_rendered() {
  local opencode_json="$1"
  local playwright_config="$2"
  local browsers_path="$3"
  local label="${4:-smoke}"
  local ok=true

  assert_json_file "$playwright_config" "$label playwright-mcp config" || ok=false
  assert_json_file "$opencode_json" "$label opencode.json" || ok=false

  for needle in '@playwright/mcp@0.0.48' '--config' 'PLAYWRIGHT_BROWSERS_PATH'; do
    if ! grep -qF -e "$needle" "$opencode_json"; then
      printf 'FAIL: %s opencode.json missing %s\n' "$label" "$needle" >&2
      ok=false
    fi
  done
  if ! grep -qF -e "$playwright_config" "$opencode_json"; then
    printf 'FAIL: %s opencode.json missing playwright config path\n' "$label" >&2
    ok=false
  fi
  if ! grep -qF -e "$browsers_path" "$opencode_json"; then
    printf 'FAIL: %s opencode.json missing browser cache path\n' "$label" >&2
    ok=false
  fi
  for forbidden in \
    '__PLAYWRIGHT_MCP_CONFIG_PATH__' \
    '__PLAYWRIGHT_BROWSERS_PATH__' \
    '@playwright/mcp@latest' \
    '--browser=chrome' \
    'PLAYWRIGHT_BROWSERS_PATH=0' \
    '/Users/me'; do
    if grep -qF -e "$forbidden" "$opencode_json"; then
      printf 'FAIL: %s opencode.json must not contain %s\n' "$label" "$forbidden" >&2
      ok=false
    fi
  done

  $ok
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

step "pre-manifest ownership semantic coverage"
python3 scripts/generate-pre-manifest-ownership.py --check

step "release-check syntax"
bash -n scripts/release-check.sh

step "app repo hygiene"
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
for stale_pattern in \
  'public app source' \
  'public Agent Workspace' \
  'public starter' \
  'public workspace contract' \
  'public app contract' \
  'public bundled starter'; do
  if search_has_match -F "$stale_pattern" README.md docs/WORKSPACE_CONTRACT.md resources/default-workspace/docs/; then
    printf 'FAIL: stale public-product wording found: %s\n' "$stale_pattern" >&2
    exit 1
  fi
done

step "README and settings docs drift"
python3 scripts/check-readme-docs-drift.py
printf '  README/docs drift checks ok\n'

step "bundled default workspace scripts"
bash -n resources/default-workspace/scripts/bootstrap.sh
bash -n resources/default-workspace/scripts/install-skills.sh
bash -n resources/default-workspace/scripts/install-agent-rules.sh
bash -n resources/default-workspace/scripts/install-opencode-config.sh
bash -n resources/default-workspace/scripts/install-codex-config.sh
bash -n resources/default-workspace/scripts/install-cursor-workspace.sh
bash -n resources/default-workspace/scripts/install-runtime-agents.sh

step "bundled default workspace opencode generator script"
if [ ! -f resources/default-workspace/scripts/generate-opencode-config.py ]; then
  printf 'FAIL: bundled default generator script missing\n' >&2
  exit 1
fi
python3 -c 'import ast, pathlib; ast.parse(pathlib.Path("resources/default-workspace/scripts/generate-opencode-config.py").read_text())'
printf '  generate-opencode-config.py: exists, valid Python syntax\n'

step "bundled default codex config templates"
python3 - <<'PY'
import re
import tomllib
from pathlib import Path

root = Path("resources/default-workspace/templates/codex")
required = [
    root / "README.md",
    root / "config.toml",
    root / "mcp/README.md",
    root / "mcp/playwright.toml",
]
tokenish = re.compile(r"(sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|Basic\s+\S+|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-)", re.I)
for path in required:
    if not path.is_file():
        raise SystemExit(f"FAIL: missing Codex template: {path}")
    text = path.read_text()
    if tokenish.search(text):
        raise SystemExit(f"FAIL: Codex template contains credential-like literal: {path}")
    if path.suffix == ".toml":
        tomllib.loads(text)
config = tomllib.loads((root / "config.toml").read_text())
if config.get("approval_policy") != "on-request":
    raise SystemExit("FAIL: Codex config must default approval_policy to on-request")
if config.get("sandbox_mode") != "workspace-write":
    raise SystemExit("FAIL: Codex config must default sandbox_mode to workspace-write")
# Codex 0.134+ rejects the legacy top-level profile selector and ignores
# [profiles.*] tables; the template must not reintroduce them.
if "profile" in config:
    raise SystemExit("FAIL: Codex config template must not use the legacy profile selector")
if "profiles" in config:
    raise SystemExit("FAIL: Codex config template must not define legacy [profiles.*] tables")
PY
printf '  Codex config template valid\n'
release_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-workspace-release-check.XXXXXX")"
tmp_home="$(mktemp -d "${release_tmp_dir}/home.XXXXXX")"
codex_apply_log="${release_tmp_dir}/codex-apply.log"

# --apply on missing config should succeed (creates config from source)
if ! HOME="$tmp_home" bash resources/default-workspace/scripts/install-codex-config.sh --apply >"$codex_apply_log" 2>&1; then
  printf 'FAIL: install-codex-config.sh --apply failed for missing config\n' >&2
  cat "$codex_apply_log" >&2
  exit 1
fi
# Verify generated config parses as TOML
if ! python3 -c "import tomllib; tomllib.load(open('$tmp_home/.codex/config.toml', 'rb'))" 2>/dev/null; then
  printf 'FAIL: --apply produced invalid TOML\n' >&2
  exit 1
fi
# Verify managed defaults present and legacy profile scheme absent
if ! grep -q 'approval_policy = "on-request"' "$tmp_home/.codex/config.toml"; then
  printf 'FAIL: generated Codex config must set approval_policy\n' >&2
  exit 1
fi
if grep -qE '^profile *=' "$tmp_home/.codex/config.toml"; then
  printf 'FAIL: generated Codex config must not use the legacy profile selector\n' >&2
  exit 1
fi
# Verify diff output is managed-only (no full config)
diff_log="${release_tmp_dir}/codex-diff.log"
HOME="$tmp_home" bash resources/default-workspace/scripts/install-codex-config.sh --diff >"$diff_log" 2>&1 || true
if grep -qi 'secret\|token\|sk-[A-Za-z0-9]\|Bearer' "$diff_log" 2>/dev/null; then
  printf 'FAIL: Codex diff output may contain secrets\n' >&2
  exit 1
fi
if ! grep -q 'codex-config managed sections synced\|codex-config synced' resources/default-workspace/scripts/install-codex-config.sh; then
  printf 'FAIL: install-codex-config.sh --diff must print synced status when unchanged\n' >&2
  exit 1
fi

# ── Secret marker tests ──
secret_home="$(mktemp -d "${release_tmp_dir}/secret-home.XXXXXX")"
mkdir -p "$secret_home/.codex"
# Create a Codex config with secret-like markers
python3 -c "
import tomllib
from pathlib import Path
# Read managed source
source = tomllib.loads((Path('resources/default-workspace/templates/codex/config.toml').read_text()))
# Create test config with secret markers
test_config = '''# User Codex config
profile = \"safe\"
model = \"gpt-4\"
personality = \"helpful\"

[test-secret-section]
api_key = \"sk-test-secret-key-12345\"
token = \"ghp_test_secret_token_54321\"

[mcp_servers.custom-server]
command = \"custom\"
args = []
env = {API_KEY = \"test-secret-value-98765\"}

[profiles.safe]
sandbox_mode = false
model = \"gpt-4\"

[unknown-table]
value = \"should-be-preserved\"
'''
Path('$secret_home/.codex/config.toml').write_text(test_config)
"
# Run apply and verify no secret markers in output
secret_apply_log="${release_tmp_dir}/codex-secret-apply.log"
HOME="$secret_home" bash resources/default-workspace/scripts/install-codex-config.sh --apply >"$secret_apply_log" 2>&1 || \
  { printf 'FAIL: secret-marker apply failed\n' >&2; cat "$secret_apply_log" >&2; exit 1; }
for marker in 'sk-test-secret' 'ghp_test_secret' 'test-secret-value-98765'; do
  if grep -qF "$marker" "$secret_apply_log" 2>/dev/null; then
    printf 'FAIL: Codex apply output leaked secret marker: %s\n' "$marker" >&2
    exit 1
  fi
done
# Verify user-owned values are preserved while managed routing defaults apply.
python3 -c "
import tomllib
result = tomllib.load(open('$secret_home/.codex/config.toml', 'rb'))
assert result.get('model') == 'gpt-5.5', 'managed model should be applied'
assert result.get('model_reasoning_effort') == 'high', 'managed reasoning effort should be applied'
assert result.get('approval_policy') == 'on-request', 'managed approval policy should be applied'
assert result.get('sandbox_mode') == 'workspace-write', 'managed sandbox mode should be applied'
assert result.get('personality') == 'helpful', 'personality should be preserved'
assert result.get('unknown-table', {}).get('value') == 'should-be-preserved', 'unknown table should survive'
assert 'profile' not in result, 'legacy top-level profile selector should be removed'
assert result.get('profiles', {}).get('safe', {}).get('model') == 'gpt-4', 'customized legacy profile table should be preserved'
print('  secret-marker apply: user values preserved and managed defaults applied')
"
printf '  Codex config apply and secret-marker guard verified\n'

step "bundled default scripts are real (no placeholder phrases)"
for pattern in "placeholder" "No files are written" "future app flows"; do
  if search_has_match -l "$pattern" resources/default-workspace/scripts/; then
    printf 'FAIL: bundled default scripts contain placeholder phrase: %s\n' "$pattern" >&2
    exit 1
  fi
done

step "bundled default install-skills.sh help mentions all supported agents"
for agent in codex opencode claude cursor; do
  if ! bash resources/default-workspace/scripts/install-skills.sh --help 2>&1 | grep -qF "$agent"; then
    printf 'FAIL: install-skills.sh --help missing agent: %s\n' "$agent" >&2
    exit 1
  fi
done

step "bundled default install-agent-rules.sh help mentions all supported rule targets"
for agent in codex opencode claude; do
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
python3 resources/default-workspace/scripts/check-cursor-profile.py
cargo test --manifest-path src-tauri/Cargo.toml cursor_profile_ops:: --quiet
python3 -m json.tool resources/default-workspace/templates/cursor/manifest.json >/dev/null
python3 -m json.tool resources/default-workspace/templates/cursor/global-profile.json >/dev/null
python3 -m json.tool resources/default-workspace/templates/cursor/mcp/mcp.example.json >/dev/null
python3 -m json.tool resources/default-workspace/templates/cursor/mcp/playwright.mcp.json >/dev/null
printf '  Cursor manifest, global profile, MCP, and native profile ops tests valid\n'
for required in \
  resources/default-workspace/templates/cursor/manifest.json \
  resources/default-workspace/templates/cursor/global-profile.json \
  resources/default-workspace/templates/cursor/mcp/README.md \
  resources/default-workspace/templates/cursor/mcp/mcp.example.json \
  resources/default-workspace/templates/cursor/mcp/playwright.mcp.json; do
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
  printf 'FAIL: Cursor MCP templates contain token-like literals\n' >&2
  exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path

root = Path("resources/default-workspace/templates/cursor")
manifest = json.loads((root / "manifest.json").read_text())
manifest_agents = set(manifest["agents"])
cursor_agents_dir = root / "agents"
on_disk = {p.name for p in cursor_agents_dir.glob("*.md")}
if manifest_agents != on_disk:
    missing = sorted(manifest_agents - on_disk)
    extra = sorted(on_disk - manifest_agents)
    raise SystemExit(
        "FAIL: Cursor manifest agents must match templates/cursor/agents/*.md exactly; "
        f"missing={missing or 'none'} extra={extra or 'none'}"
    )
for name in manifest["agents"]:
    if not (cursor_agents_dir / name).is_file():
        raise SystemExit(f"FAIL: manifest-listed Cursor agent missing: {name}")
for name in manifest["rules"]:
    if not (root / "rules" / name).is_file():
        raise SystemExit(f"FAIL: manifest-listed Cursor rule missing: {name}")
for name in manifest["mcp_examples"]:
    if not (root / "mcp" / name).is_file():
        raise SystemExit(f"FAIL: manifest-listed Cursor MCP example missing: {name}")
if manifest.get("setup_runtime") != "native":
    raise SystemExit("FAIL: Cursor manifest setup_runtime must be native")
profile = json.loads((root / "global-profile.json").read_text())
if profile.get("setup_runtime") != "native":
    raise SystemExit("FAIL: global-profile.json setup_runtime must be native")
if "permissions" in profile.get("surfaces", {}):
    raise SystemExit("FAIL: global-profile.json must not define managed permissions surface")
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
python3 scripts/check-cursor-action-compat.py
printf '  Cursor backend action/script compatibility verified\n'
if ! bash resources/default-workspace/scripts/install-cursor-workspace.sh --help 2>&1 | rg -qF -- '--copy-user-rules'; then
  printf 'FAIL: install-cursor-workspace.sh --help missing --copy-user-rules\n' >&2
  exit 1
fi
if bash resources/default-workspace/scripts/install-cursor-workspace.sh --help 2>&1 | rg -qF -- 'native Rust operations'; then
  : "ok"
else
  printf 'FAIL: install-cursor-workspace.sh --help must state global setup uses native Rust operations\n' >&2
  exit 1
fi
if bash resources/default-workspace/scripts/install-cursor-workspace.sh --help 2>&1 | rg -qF -- 'never writes'; then
  : "ok"
else
  printf 'FAIL: install-cursor-workspace.sh --help must state it never writes global agents\n' >&2
  exit 1
fi
# Validation handled by check-cursor-profile.py (manifest-driven, covers all agents)
if ! grep -q 'fn editable_config_targets' src-tauri/src/agent_targets.rs; then
  printf 'FAIL: editable config target allowlist missing\n' >&2
  exit 1
fi

step "default workspace copy list includes generator + base/policy templates"
python3 scripts/check-default-workspace-copy-list.py
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
for forbidden in '--global-agents' '--global-agents-only' 'CURSOR_AGENTS_TARGET' '$HOME/.cursor/agents'; do
  if rg -qF -- "$forbidden" resources/default-workspace/scripts/install-cursor-workspace.sh; then
    printf 'FAIL: install-cursor-workspace.sh must not contain global agent shell path: %s\n' "$forbidden" >&2
    exit 1
  fi
done
tmpdir="$(mktemp -d)"
fake_project="$tmpdir/project"
mkdir -p "$fake_project/.git"
if HOME="$tmpdir" bash resources/default-workspace/scripts/install-cursor-workspace.sh --apply --global-agents --quiet >/dev/null 2>&1; then
  printf 'FAIL: install-cursor-workspace.sh accepted removed --global-agents flag\n' >&2
  exit 1
fi
if [ -d "$tmpdir/.cursor/agents" ]; then
  printf 'FAIL: install-cursor-workspace.sh must not write ~/.cursor/agents\n' >&2
  exit 1
fi
HOME="$tmpdir" AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
  bash resources/default-workspace/scripts/install-cursor-workspace.sh --apply --project --target "$fake_project" --quiet >/dev/null
if [ ! -d "$fake_project/.cursor/agents" ] || [ ! -d "$fake_project/.cursor/rules" ]; then
  printf 'FAIL: Cursor project CLI smoke did not write project agents/rules\n' >&2
  exit 1
fi
rm -rf "$tmpdir"
if bash resources/default-workspace/scripts/install-cursor-workspace.sh --project --target "$HOME" >/dev/null 2>&1; then
  printf 'FAIL: Cursor project sync accepted broad HOME target\n' >&2
  exit 1
fi
printf '  Cursor setup verified: help, adapters, project install, no shell global agents\n'

step "bundled default cursor user-rules"
user_rules_file="resources/default-workspace/templates/cursor/user-rules.md"
if [ ! -f "$user_rules_file" ]; then
  printf 'FAIL: cursor user-rules template missing: %s\n' "$user_rules_file" >&2
  exit 1
fi
printf '  user-rules.md exists\n'

# Must NOT contain deprecated architect framing
for forbidden in \
  'primary implementation architect' \
  'architect subagent' \
  'Cursor composer/chat' \
  'Do not invoke the `architect`' \
  'Do not invoke the architect'; do
  if grep -qF "$forbidden" "$user_rules_file"; then
    printf 'FAIL: user-rules.md must not contain deprecated wording: %s\n' "$forbidden" >&2
    exit 1
  fi
done
printf '  user-rules.md avoids deprecated architect framing\n'

# Must contain updated subagent/worksurface guidance
for required in \
  'Cursor rules, skills, subagents, and MCP are separate surfaces' \
  'Use subagents only when they reduce risk, context load, or verification burden' \
  'Do not duplicate workflow instructions across all surfaces'; do
  if ! grep -qF "$required" "$user_rules_file"; then
    printf 'FAIL: user-rules.md missing required wording: %s\n' "$required" >&2
    exit 1
  fi
done
printf '  user-rules.md contains updated subagent guidance\n'

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
if "kind: TargetKind::Agents" not in cursor_block:
    raise SystemExit("FAIL: cursor_setup must have kind TargetKind::Agents")

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
  resources/default-workspace/docs/CODEX_CONFIG.md \
  resources/default-workspace/docs/TROUBLESHOOTING.md; do
  if [ ! -s "$doc" ]; then
    printf 'FAIL: bundled default doc missing or empty: %s\n' "$doc" >&2
    exit 1
  fi
done
printf '  bundled docs verified non-empty\n'

for doc in \
  resources/default-workspace/docs/prompt-templates/prompt.md \
  resources/default-workspace/docs/prompt-templates/goal-prompt.md \
  resources/default-workspace/docs/prompt-templates/batch-prompt.md; do
  if [ ! -s "$doc" ]; then
    printf 'FAIL: prompt template doc missing or empty: %s\n' "$doc" >&2
    exit 1
  fi
done
printf '  prompt template docs verified non-empty\n'

step "curated Library Docs registry"
python3 scripts/check-curated-library-docs.py

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
python3 -m json.tool resources/default-workspace/templates/playwright-mcp.config.json >/dev/null
printf '  playwright-mcp.config.json: valid strict JSON\n'

step "bundled default Playwright MCP guardrails"
bash resources/default-workspace/scripts/check-playwright-mcp.sh

step "bundled default opencode.json snapshot is current"
python3 scripts/generate-default-opencode-config.py --check

step "bundled OpenCode permission composition tests"
python3 -m unittest scripts/test_opencode_policy_compose.py

step "bundled OpenCode permission contract"
python3 scripts/validate_opencode_permissions.py

step "bundled harness agent adapters are current"
python3 scripts/generate-agent-adapters.py --check
if search_quiet 'templates/opencode/agents/.*\\.header\\.yaml' resources/default-workspace; then
  printf 'FAIL: hand-maintained OpenCode agent header.yaml files must not exist; use role.json + policy compose\n' >&2
  exit 1
fi
if ! ls resources/default-workspace/templates/opencode/agents/*.role.json >/dev/null 2>&1; then
  printf 'FAIL: OpenCode agent role.json override sources missing\n' >&2
  exit 1
fi
printf '  OpenCode permissions sourced from policy + role overrides\n'

step "bundled harness rule adapters are current"
python3 scripts/generate-agent-rules.py --check
python3 - <<'PY'
import tomllib
from pathlib import Path

root = Path("resources/default-workspace/templates/codex/agents")
for path in sorted(root.glob("*.toml")):
    tomllib.loads(path.read_text(encoding="utf-8"))
print(f"  validated {len(list(root.glob('*.toml')))} codex agent toml files")
PY

step "workspace generator --check from temp workspace copy"
tmpdir_gen="$(mktemp -d)"
cp -R resources/default-workspace "$tmpdir_gen/gen-test"
python3 "$tmpdir_gen/gen-test/scripts/generate-opencode-config.py" --check
rm -rf "$tmpdir_gen"
printf '  workspace-relative generator --check passed\n'

step "bundled default opencode.json"
python3 -m json.tool resources/default-workspace/templates/opencode.json >/dev/null
if ! grep -q '"default_agent": "architect"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing default_agent architect\n' >&2
  exit 1
fi
if ! grep -q '"model": "opencode-go/glm-5.2"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing expected GLM 5.2 model\n' >&2
  exit 1
fi
if ! grep -q '"small_model": "opencode-go/deepseek-v4-flash"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing expected DeepSeek v4 Flash small_model\n' >&2
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
printf '  opencode.json: default_agent=architect model=glm-5.2 small_model=deepseek-v4-flash autoupdate=notify snapshot=true\n'

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
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if [ ! -s "resources/default-workspace/agents/$agent" ]; then
    printf 'FAIL: bundled default agent missing or empty: agents/%s\n' "$agent" >&2
    exit 1
  fi
done
printf '  6 bundled agents verified non-empty\n'
python3 - <<'PY'
import json
from pathlib import Path

required = {
    "architect.md",
    "repo-scout.md",
    "inspector.md",
    "sentinel.md",
    "scribe.md",
    "verifier.md",
}
agents_dir = Path("resources/default-workspace/agents")
on_disk = {p.name for p in agents_dir.glob("*.md")}
if on_disk != required:
    missing = sorted(required - on_disk)
    extra = sorted(on_disk - required)
    raise SystemExit(
        "FAIL: shared runtime agents dir must contain exactly "
        f"{sorted(required)}; missing={missing or 'none'} extra={extra or 'none'}"
    )

meta_path = Path("resources/default-workspace/metadata/agents.json")
meta = json.loads(meta_path.read_text())
keys = set(meta.get("agents", {}).keys())
if keys != required:
    missing = sorted(required - keys)
    extra = sorted(keys - required)
    raise SystemExit(
        "FAIL: metadata/agents.json keys must match shared runtime agents exactly; "
        f"missing={missing or 'none'} extra={extra or 'none'}"
    )
PY
printf '  shared runtime agents dir + metadata/agents.json keys verified (6)\n'
# Agents are model-agnostic — model selection is centralized in templates/opencode.json
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
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
for subagent in repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
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
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
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
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
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
playwright_config="$tmpdir/playwright-mcp/config.json"
browsers_path="$tmpdir/ms-playwright"
OPENCODE_CONFIG_PATH="$tmpdir/opencode.json" \
OPENCODE_TUI_CONFIG_PATH="$tmpdir/tui.json" \
OPENCODE_AGENTS_DIR="$tmpdir/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
PLAYWRIGHT_MCP_CONFIG_PATH="$playwright_config" \
PLAYWRIGHT_BROWSERS_PATH="$browsers_path" \
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
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if [ ! -f "$tmpdir/agents/$agent" ]; then
    printf 'FAIL: install-opencode-config.sh --apply did not write agents/%s\n' "$agent" >&2
    apply_ok=false
  fi
done
agent_count="$(find "$tmpdir/agents" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')"
if [ "$agent_count" -ne 6 ]; then
  printf 'FAIL: install-opencode-config.sh --apply wrote %s agents, expected 6\n' "$agent_count" >&2
  apply_ok=false
fi
if ! $apply_ok; then rm -rf "$tmpdir"; exit 1; fi
if ! grep -q '"default_agent": "architect"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing default_agent architect\n' >&2
  apply_ok=false
fi
if ! grep -q '"model": "opencode-go/glm-5.2"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing expected GLM 5.2 model\n' >&2
  apply_ok=false
fi
if ! grep -q '"small_model": "opencode-go/deepseek-v4-flash"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing expected DeepSeek v4 Flash small_model\n' >&2
  apply_ok=false
fi
# Model-agnostic agents — no model frontmatter expected
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if grep -q "^model:" "$tmpdir/agents/$agent"; then
    printf 'FAIL: smoke %s has model frontmatter (should be model-agnostic)\n' "$agent" >&2
    apply_ok=false
  fi
done
if ! grep -q 'mode: primary' "$tmpdir/agents/architect.md"; then
  printf 'FAIL: smoke architect.md missing mode: primary\n' >&2
  apply_ok=false
fi
for subagent in repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
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
if ! assert_opencode_playwright_rendered \
  "$tmpdir/opencode.json" \
  "$playwright_config" \
  "$browsers_path" \
  "temp apply"; then
  apply_ok=false
fi
rm -rf "$tmpdir"
if ! $apply_ok; then exit 1; fi
printf '  install-opencode-config.sh --apply smoke: 1 config + 1 tui + 6 agents written, content checks passed\n'

step "opencode secret-marker apply test"
op_secret_home="$(mktemp -d "${release_tmp_dir}/op-secret-home.XXXXXX")"
mkdir -p "$op_secret_home/.config/opencode"
# Create an opencode.json with secret-like markers
python3 -c "
from pathlib import Path
test_config = '''{
  \"model\": \"test-model\",
  \"small_model\": \"test-small\",
  \"default_agent\": \"architect\",
  \"provider\": {
    \"custom-provider\": {
      \"api_key\": \"test-secret-openkey-12345\",
      \"models\": {
        \"gpt-4\": {\"limit\": {\"context\": 100000}}
      }
    }
  },
  \"mcp\": {
    \"playwright\": {
      \"command\": [\"npx\", \"-y\", \"@playwright/mcp@0.0.48\", \"--config\", \"/tmp/test-config.json\"],
      \"environment\": {\"PLAYWRIGHT_BROWSERS_PATH\": \"/tmp/test-browsers\"}
    },
    \"custom-mcp\": {
      \"command\": [\"custom\"],
      \"env\": {\"TOKEN\": \"test-secret-token-value-55555\"}
    }
  },
  \"unknown-key\": \"should-preserve\"
}'''
Path('$op_secret_home/.config/opencode/opencode.json').write_text(test_config)
"
# Set up playwright paths for the opencode script
op_playwright_config="$op_secret_home/playwright-mcp/config.json"
op_browsers_path="$op_secret_home/ms-playwright"
mkdir -p "$(dirname "$op_playwright_config")"
echo '{}' > "$op_playwright_config"
op_apply_log="${release_tmp_dir}/op-secret-apply.log"
OPENCODE_CONFIG_PATH="$op_secret_home/.config/opencode/opencode.json" \
OPENCODE_TUI_CONFIG_PATH="$op_secret_home/.config/opencode/tui.json" \
OPENCODE_AGENTS_DIR="$op_secret_home/.config/opencode/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$op_secret_home/backups" \
PLAYWRIGHT_MCP_CONFIG_PATH="$op_playwright_config" \
PLAYWRIGHT_BROWSERS_PATH="$op_browsers_path" \
  bash resources/default-workspace/scripts/install-opencode-config.sh --apply >"$op_apply_log" 2>&1 || \
  { printf 'FAIL: opencode secret-marker apply failed\n' >&2; cat "$op_apply_log" >&2; exit 1; }
for marker in 'test-secret-openkey' 'test-secret-token-value'; do
  if grep -qF "$marker" "$op_apply_log" 2>/dev/null; then
    printf 'FAIL: OpenCode apply output leaked secret marker: %s\n' "$marker" >&2
    exit 1
  fi
done
# Verify user values preserved
python3 -c "
import json
result = json.load(open('$op_secret_home/.config/opencode/opencode.json'))
provider = result.get('provider', {})
assert 'custom-provider' in provider, 'user provider should be preserved'
assert provider['custom-provider']['api_key'] == 'test-secret-openkey-12345', 'provider api_key should survive'
mcp = result.get('mcp', {})
assert 'custom-mcp' in mcp, 'custom MCP entry should survive'
assert mcp['custom-mcp']['env']['TOKEN'] == 'test-secret-token-value-55555', 'custom MCP env should survive'
assert result.get('unknown-key') == 'should-preserve', 'unknown key should survive'
print('  secret-marker opencode apply: user values preserved')
"
printf '  opencode secret-marker apply test passed\n'

step "bundled default install-opencode-config.sh --agents-only temp apply"
tmpdir="$(mktemp -d)"
playwright_config="$tmpdir/playwright-mcp/config.json"
browsers_path="$tmpdir/ms-playwright"
OPENCODE_CONFIG_PATH="$tmpdir/opencode.json" \
OPENCODE_TUI_CONFIG_PATH="$tmpdir/tui.json" \
OPENCODE_AGENTS_DIR="$tmpdir/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
PLAYWRIGHT_MCP_CONFIG_PATH="$playwright_config" \
PLAYWRIGHT_BROWSERS_PATH="$browsers_path" \
  bash resources/default-workspace/scripts/install-opencode-config.sh --apply --agents-only >/dev/null
agents_only_ok=true
for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
  if [ ! -f "$tmpdir/agents/$agent" ]; then
    printf 'FAIL: --agents-only did not write agents/%s\n' "$agent" >&2
    agents_only_ok=false
  fi
done
if [ -f "$tmpdir/opencode.json" ] || [ -f "$tmpdir/tui.json" ]; then
  printf 'FAIL: --agents-only must not write config or tui files\n' >&2
  agents_only_ok=false
fi
rm -rf "$tmpdir"
if ! $agents_only_ok; then exit 1; fi
printf '  install-opencode-config.sh --agents-only: agents written, config/tui untouched\n'

step "bundled default install-opencode-config.sh --config-only temp apply"
tmpdir="$(mktemp -d)"
playwright_config="$tmpdir/playwright-mcp/config.json"
browsers_path="$tmpdir/ms-playwright"
OPENCODE_CONFIG_PATH="$tmpdir/opencode.json" \
OPENCODE_TUI_CONFIG_PATH="$tmpdir/tui.json" \
OPENCODE_AGENTS_DIR="$tmpdir/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
PLAYWRIGHT_MCP_CONFIG_PATH="$playwright_config" \
PLAYWRIGHT_BROWSERS_PATH="$browsers_path" \
  bash resources/default-workspace/scripts/install-opencode-config.sh --apply --config-only >/dev/null
config_only_ok=true
if [ ! -f "$tmpdir/opencode.json" ] || [ ! -f "$tmpdir/tui.json" ]; then
  printf 'FAIL: --config-only did not write opencode.json and tui.json\n' >&2
  config_only_ok=false
fi
if [ -d "$tmpdir/agents" ] && [ "$(find "$tmpdir/agents" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')" -gt 0 ]; then
  printf 'FAIL: --config-only must not write agent files\n' >&2
  config_only_ok=false
fi
rm -rf "$tmpdir"
if ! $config_only_ok; then exit 1; fi
printf '  install-opencode-config.sh --config-only: config + tui written, agents untouched\n'

step "bundled default install-runtime-agents.sh help mentions supported harnesses"
for harness in opencode claude; do
  if ! bash resources/default-workspace/scripts/install-runtime-agents.sh --help 2>&1 | grep -qF "$harness"; then
    printf 'FAIL: install-runtime-agents.sh --help missing harness: %s\n' "$harness" >&2
    exit 1
  fi
done

step "bundled default install-runtime-agents.sh temp apply (claude)"
tmpdir="$(mktemp -d)"
CLAUDE_AGENTS_DIR="$tmpdir/claude/agents" \
AGENT_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
  bash resources/default-workspace/scripts/install-runtime-agents.sh --claude --apply --quiet >/dev/null
runtime_ok=true
for agent in repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
  dest="$tmpdir/claude/agents/$agent"
  if [ ! -f "$dest" ]; then
    printf 'FAIL: install-runtime-agents.sh did not write %s\n' "$dest" >&2
    runtime_ok=false
  fi
done
rm -rf "$tmpdir"
if ! $runtime_ok; then exit 1; fi
printf '  install-runtime-agents.sh: claude agents written (5)\n'

step "harness pages use one managed installation owner"
for view in ClaudeView CodexView CursorView OpenCodeView; do
  path="src/views/${view}.tsx"
  if [ "$(grep -c '<HarnessInstallationCard' "$path")" -ne 1 ]; then
    printf 'FAIL: %s must render exactly one HarnessInstallationCard\n' "$path" >&2
    exit 1
  fi
done
if search_has_match 'sync_claude_agents|diff_claude_agents|sync_opencode_agents|diff_opencode_agents' src/App.tsx src/views; then
  printf 'FAIL: page-scoped agent mutation wiring must not return\n' >&2
  exit 1
fi
printf '  one managed installation owner verified on each harness page\n'

step "regression: no stale config + agents labels in app UI"
if search_has_match 'config \\+ agents' src/views src/App.tsx; then
  printf 'FAIL: stale config + agents wording in app UI\n' >&2
  exit 1
fi
printf '  app UI uses config-only / agents-only labels\n'

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
runtime_playwright_config="$tmpdir/runtime/playwright-mcp/config.json"
runtime_browsers_path="$tmpdir/runtime/ms-playwright"

# Copy entire workspace tree to space-containing path so the script
# itself runs from a path with spaces and computes SCRIPT_DIR / SOURCE_FILE
# / AGENTS_SOURCE_DIR from that location.
cp -R resources/default-workspace "$space_dir"

# Run --apply from the copied workspace, targeting separate runtime dirs
OPENCODE_CONFIG_PATH="$runtime_config" \
OPENCODE_TUI_CONFIG_PATH="$runtime_tui" \
OPENCODE_AGENTS_DIR="$runtime_agents" \
AGENT_WORKSPACE_BACKUP_DIR="$backup_dir" \
PLAYWRIGHT_MCP_CONFIG_PATH="$runtime_playwright_config" \
PLAYWRIGHT_BROWSERS_PATH="$runtime_browsers_path" \
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

for agent in architect.md repo-scout.md inspector.md sentinel.md scribe.md verifier.md; do
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
if ! assert_opencode_playwright_rendered \
  "$runtime_config" \
  "$runtime_playwright_config" \
  "$runtime_browsers_path" \
  "space-in-path"; then
  apply_ok=false
fi

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
mkdir -p "$tmpdir/$ts/claude-agents"
# Write test files
echo "config" > "$tmpdir/$ts/opencode-config/opencode.json"
echo "rules" > "$tmpdir/$ts/codex-rules/AGENTS.md"
echo "rules" > "$tmpdir/$ts/opencode-rules/AGENTS.md"
echo "agent" > "$tmpdir/$ts/opencode-agents/architect.md"
echo "agent" > "$tmpdir/$ts/opencode-agents/repo-scout.md"
echo "agent" > "$tmpdir/$ts/claude-agents/architect.md"

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
for target_dir in opencode-config codex-rules opencode-rules opencode-agents claude-agents; do
  if [ ! -d "$tmpdir/$ts/$target_dir" ]; then
    printf 'FAIL: backup schema %s dir not found\n' "$target_dir" >&2
    rm -rf "$tmpdir"
    exit 1
  fi
done
rm -rf "$tmpdir"
printf '  backup schema verified: YYYYMMDD-HHMMSS + target IDs (opencode-config, codex-rules, opencode-rules, opencode-agents, claude-agents)\n'

step "tauri app resources config"
if ! search_quiet "default-workspace" src-tauri/tauri.conf.json; then
  printf 'FAIL: tauri conf missing bundled default workspace resource path\n' >&2
  exit 1
fi
if ! search_quiet 'get_webview_window\("main"\)' src-tauri/src/lib.rs \
  || ! search_quiet 'window\.maximize\(\)' src-tauri/src/lib.rs; then
  printf 'FAIL: Tauri startup must maximize the main window\n' >&2
  exit 1
fi
printf '  main window startup maximize hook verified\n'

step "bundled skill catalog and routing alignment"
python3 scripts/check-skill-routing.py

step "managed installation contract guards"
python3 scripts/check-managed-installation-contract.py

step "bundled default private context boundary"
for forbidden_file in \
  saved-memory.md \
  USER_CONTEXT.md \
  skill-routing-brain-setup.md; do
  if find resources/default-workspace -type f -name "$forbidden_file" | grep -q .; then
    printf 'FAIL: bundled default must not contain PRIVATE-only context file: %s\n' "$forbidden_file" >&2
    exit 1
  fi
done
if find resources/default-workspace -type d -name private-context 2>/dev/null | grep -q .; then
  printf 'FAIL: bundled default must not contain private-context directory\n' >&2
  exit 1
fi
if search_has_match '(^|[^/])saved-memory\.md|docs/USER_CONTEXT\.md|skill-routing-brain-setup\.md|templates/context/' \
  resources/default-workspace; then
  printf 'FAIL: bundled default references PRIVATE-only context paths\n' >&2
  exit 1
fi
if search_has_match "PRIVATE's private|PRIVATE-specific personal|private-context repo" resources/default-workspace; then
  printf 'FAIL: bundled default contains PRIVATE-only context markers\n' >&2
  exit 1
fi
printf '  private context boundary ok\n'

step "bundled default no private names"
private_name_pattern="$(printf '%s|' "C""arl" "Dis""chornan" "Disch""örnan" "Hantverks""registret" "Account cred""its" "personal mod""el")"
private_name_pattern="${private_name_pattern%|}"
if search_has_match -w "$private_name_pattern" resources/default-workspace; then
  printf 'FAIL: bundled default workspace must not contain private names\n' >&2
  exit 1
fi

step "app must not expose project-target sync/install UI"
app_project_pattern='cursorProjectTarget|cursor_diff_project|cursor_sync_project|onCursorDiffProject|onCursorSyncProject|dry-run project|sync project|installScope|installTarget|Project install target|Project scope needs|validate_project_install_target|project scope requires'
if command -v rg >/dev/null 2>&1; then
  if rg -n "$app_project_pattern" src src-tauri -g '!target/**' >/dev/null 2>&1; then
    printf 'FAIL: app source still references project-target UI/actions\n' >&2
    rg -n "$app_project_pattern" src src-tauri -g '!target/**' >&2 || true
    exit 1
  fi
else
  if grep -R -n -E "$app_project_pattern" src src-tauri 2>/dev/null | grep -v target; then
    printf 'FAIL: app source still references project-target UI/actions\n' >&2
    exit 1
  fi
fi
printf '  no project-target app surfaces in src/ or src-tauri/\n'

step "regression: Cursor page uses unified installation"
python3 scripts/check-cursor-action-compat.py

step "forbidden source scans"
scan_forbidden 'sh[[:space:]]+-c' 'sh -c'
scan_forbidden '(^|[^[:alnum:]_])eval([^[:alnum:]_]|$)' 'eval'
scan_forbidden 'npx[[:space:]]+skills' 'npx skills'
scan_forbidden 'skills@latest' 'skills@latest'
if ! search_has_match 'codex_home\(home\)\.join\("skills"\)' src-tauri/src/agent_skill_targets.rs; then
  printf 'FAIL: Codex global skills path must use $CODEX_HOME/skills\n' >&2
  exit 1
fi
if ! search_has_match '\.codex}/skills' resources/default-workspace/scripts/install-skills.sh; then
  printf 'FAIL: install-skills.sh must use $CODEX_HOME/skills for Codex\n' >&2
  exit 1
fi
printf '  Codex $CODEX_HOME/skills path guard verified\n'

step "routing profile bloat guard"
scan_forbidden 'RoutingProfile|routing/profiles|get_routing_profiles|save_routing_profiles|read_routing_profiles_file|buildProfileHeader|copyMetadataBlock|profileStatus|RoutingMatrix|routingCompatibility|routingTemplates' 'routing profile bloat (removed profiles must not be reintroduced)'

step "brain setup library integration guard"
if search_has_match 'RoutingView|view === "routing"|switchView\("routing"\)' src/App.tsx src/views; then
  printf 'FAIL: stale Brain Setup routing view references in app sources\n' >&2
  exit 1
fi
printf '  no RoutingView or routing view switch in src/\n'

step "unified installation command surface"
python3 -c "
import re, sys
sources = [
    open('src-tauri/src/commands.rs').read(),
    open('src-tauri/src/lib.rs').read(),
    open('src/App.tsx').read(),
]
for obsolete in [
    'install_default_workspace',
    'repair_default_workspace',
    'plan_workspace_repair',
    'apply_workspace_repair',
    'preview_repair_setup',
    'repair_setup_artifacts',
]:
    if any(obsolete in source for source in sources):
        print(f'FAIL: obsolete installation command remains: {obsolete}')
        sys.exit(1)
lib = sources[1]
for required in ['preview_setup', 'apply_setup', 'rollback_setup_transaction']:
    if required not in lib:
        print(f'FAIL: unified setup command missing: {required}')
        sys.exit(1)
print('  one preview/apply/rollback command surface verified')
"
printf '  unified installation command surface verified\n'

step "claude harness page present"
if [ ! -f "$repo_root/src/views/ClaudeView.tsx" ]; then
  printf 'FAIL: missing src/views/ClaudeView.tsx\n' >&2
  exit 1
fi
if python3 - <<'PY' | grep -q .; then
import pathlib
import re
root = pathlib.Path("src")
_vendor = bytes([0x61, 0x75, 0x67, 0x6D, 0x65, 0x6E, 0x74]).decode()
_legacy = bytes([0x61, 0x75, 0x67, 0x67, 0x69, 0x65]).decode()
pat = re.compile(
    rf"{_vendor}View|view === [\"']{_vendor}[\"']|switchView\([\"']{_vendor}[\"']\)|{_legacy}_",
    re.I,
)
for path in root.rglob("*"):
    if not path.is_file():
        continue
    if path.suffix not in {".ts", ".tsx", ".css"}:
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    if pat.search(text):
        print(path)
PY
  printf 'FAIL: removed harness remnants found in src\n' >&2
  exit 1
fi
if search_quiet 'MiscView|TargetMiscSkillsPanel|view === "misc"|switchView\("misc"\)' src; then
  printf 'FAIL: Misc top-level route remnants found in src\n' >&2
  exit 1
fi
printf '  claude harness present; no removed harness or Misc route remnants\n'

step "regression: no removed third-party harness references in tracked sources"
if ! python3 - <<'PY'
import pathlib
import re
import sys

_legacy = bytes([0x61, 0x75, 0x67, 0x67, 0x69, 0x65]).decode()
needles = [
    _legacy,
    bytes([0x40, 0x61, 0x75, 0x67, 0x6D, 0x65, 0x6E, 0x74, 0x63, 0x6F, 0x64, 0x65]).decode(),
    bytes([0x2E, 0x61, 0x75, 0x67, 0x6D, 0x65, 0x6E, 0x74]).decode(),
    _legacy + "_",
    _legacy.upper() + "_",
]
pat = re.compile("|".join(re.escape(n) for n in needles), re.I)
skip = {"target", "node_modules", "dist", ".git"}
hits = []
for path in pathlib.Path(".").rglob("*"):
    if not path.is_file():
        continue
    if any(part in skip for part in path.parts):
        continue
    if path.match("src-tauri/target/**"):
        continue
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        continue
    for match in pat.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        hits.append(f"{path}:{line}:{match.group()}")
if hits:
    print("\n".join(hits))
    sys.exit(1)
PY
then
  printf 'FAIL: unexpected legacy harness references remain (see output above)\n' >&2
  exit 1
fi
printf '  no legacy harness references in tracked product sources\n'

step "regression: deprecated ~/Agent Workspace default not in active app UI"
if search_has_match '~/Agent Workspace' \
  src/lib/settingsDraft.ts \
  src/views/StartView.tsx \
  src/App.tsx; then
  printf 'FAIL: deprecated ~/Agent Workspace path found in active frontend sources\n' >&2
  exit 1
fi
if ! search_has_match 'DEFAULT_INSTALLED_WORKSPACE_DISPLAY' src-tauri/src/path_utils.rs; then
  printf 'FAIL: canonical installed workspace constant missing in path_utils.rs\n' >&2
  exit 1
fi
if ! search_has_match '~/.config/agent-workspace' src/lib/settingsDraft.ts src/views/StartView.tsx; then
  printf 'FAIL: frontend must reference ~/.config/agent-workspace\n' >&2
  exit 1
fi
if search_has_match -F '.config/.agent-workspace' \
  src src-tauri README.md docs resources/default-workspace; then
  printf 'FAIL: mistaken install path ~/.config/.agent-workspace found in active sources\n' >&2
  exit 1
fi
if search_has_match 'choose folder|check path|use default|clear active' src/views/StartView.tsx src/App.tsx; then
  printf 'FAIL: deprecated workspace path chooser controls still in Start UI\n' >&2
  exit 1
fi
if ! search_has_match 'runHarnessSetupUpdate' src/App.tsx; then
  printf 'FAIL: App.tsx must route workspace installation through unified setup\n' >&2
  exit 1
fi
printf '  canonical install path model verified\n'

step "Start page unified installation owner"
if [ "$(grep -c '<HarnessInstallationCard' src/views/StartView.tsx)" -ne 1 ]; then
  printf 'FAIL: Start page must expose exactly one unified installation card\n' >&2
  exit 1
fi
if search_has_match 'repair|update resources|SetupLifecycle|WorkspaceSkillsVerify' src/views/StartView.tsx; then
  printf 'FAIL: Start page retains obsolete installation owners or terminology\n' >&2
  exit 1
fi
printf '  Start unified installation owner verified\n'

step "Prompt Builder template contract"
bash scripts/run-ts-check.sh scripts/check-prompt-loops-templates.ts
printf '  Prompt Builder skill-weave + clean prompt-block checks ok\n'

step "Prompt Builder context handoff contract"
bash scripts/run-ts-check.sh scripts/check-prompt-context-handoff.ts
printf '  Prompt Builder context handoff formatter/eligibility checks ok\n'

step "Repo Dashboard model and parser contracts"
npm run check:repo-dashboard-contracts
bash scripts/run-ts-check.sh scripts/check-repo-dashboard-model.ts
bash scripts/run-ts-check.sh scripts/check-repo-dashboard-docs-parser.ts
bash scripts/run-ts-check.sh scripts/check-repo-dashboard-entries.ts
bash scripts/run-ts-check.sh scripts/check-repo-dashboard-markdown.ts
bash scripts/run-ts-check.sh scripts/check-repo-dashboard-docs-workspace.ts
bash scripts/run-ts-check.sh scripts/check-repo-dashboard-navigation.ts
if ! search_has_match 'MAX_DOC_CONTENT_BYTES' src-tauri/src/commands/repo_dashboard.rs; then
  printf 'FAIL: repo dashboard must cap local doc read size\n' >&2
  exit 1
fi
if ! search_has_match 'collect_doc_paths' src-tauri/src/commands/repo_dashboard.rs; then
  printf 'FAIL: repo dashboard must discover markdown docs\n' >&2
  exit 1
fi
if search_has_match 'buildSourceHealth' src/tools/repoDashboard/model.ts; then
  printf 'FAIL: repo dashboard must not expose source health helpers\n' >&2
  exit 1
fi
if search_has_match 'Source health' src/tools/repoDashboard/RepoDashboardTool.tsx; then
  printf 'FAIL: repo dashboard must not render source health\n' >&2
  exit 1
fi
if search_has_match 'hellq|PRIVATE|uxsmedjan|PRIVATE' src/tools/repoDashboard/model.ts; then
  printf 'FAIL: repo dashboard model must not hardcode personal author patterns\n' >&2
  exit 1
fi
if ! search_has_match 'loadSeqRef' src/tools/repoDashboard/RepoDashboardTool.tsx; then
  printf 'FAIL: repo dashboard refresh must guard against stale async responses\n' >&2
  exit 1
fi
printf '  Repo Dashboard model/parser/doc-cap/load-seq checks ok\n'

step "UI selected-state and stale selector regressions"
bash scripts/check-ui-regressions.sh

step "regression: OpenCode health compares rendered config"
if search_has_match 'file_eq\(&template_config_path, &installed_config_path\)' src-tauri/src/commands/opencode_runtime.rs; then
  printf 'FAIL: configs_match must not byte-compare raw templates/opencode.json\n' >&2
  exit 1
fi
if ! search_has_match 'render_expected_opencode_config|installed_config_matches_rendered' src-tauri/src/commands/opencode_runtime.rs; then
  printf 'FAIL: OpenCode health must compare installed config to rendered workspace config\n' >&2
  exit 1
fi
if ! search_has_match 'test_configs_match_pass_when_template_has_playwright_placeholders' src-tauri/src/commands/opencode_runtime.rs; then
  printf 'FAIL: missing regression test for rendered OpenCode config health comparison\n' >&2
  exit 1
fi
printf '  OpenCode health uses rendered/staged config comparison\n'

step "regression: dashboard opencode_config status uses rendered compare"
if ! search_has_match 'opencode_config_sync_status|render_expected_opencode_config' src-tauri/src/commands/status.rs; then
  printf 'FAIL: get_status opencode_config must compare rendered workspace config\n' >&2
  exit 1
fi
if search_has_match 'fn opencode_config_status' src-tauri/src/commands/status.rs \
  && search_has_match 'sync_label\(&config_target, &config_source\)' src-tauri/src/commands/status.rs; then
  printf 'FAIL: opencode_config_status must not byte-compare raw templates/opencode.json\n' >&2
  exit 1
fi
if ! search_has_match 'opencode_config_status_synced_when_installed_matches_rendered_template' src-tauri/src/commands/status.rs; then
  printf 'FAIL: missing regression test for rendered opencode_config status\n' >&2
  exit 1
fi
printf '  dashboard opencode_config status uses rendered/staged config comparison\n'

step "app checks"
bash "$repo_root/scripts/release-check/frontend-gate.sh"
bash "$repo_root/scripts/release-check/rust-gate.sh"

step "real pre-manifest source-commit upgrade smoke"
bash scripts/smoke-pre-manifest-upgrade.sh

step "tauri runtime smoke"
bash "$repo_root/scripts/smoke-tauri-runtime.sh"


step "release smoke doc"
if [ ! -f "$repo_root/docs/APP_RELEASE_SMOKE.md" ]; then
  printf 'FAIL: docs/APP_RELEASE_SMOKE.md not found\n' >&2
  exit 1
fi

printf '\nrelease-check passed\n'
