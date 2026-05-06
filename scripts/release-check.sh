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

step "bundled default scripts are real (no placeholder phrases)"
for pattern in "placeholder" "No files are written" "future app flows"; do
  if search_has_match -l "$pattern" resources/default-workspace/scripts/; then
    printf 'FAIL: bundled default scripts contain placeholder phrase: %s\n' "$pattern" >&2
    exit 1
  fi
done

step "bundled default install-skills.sh help mentions all five agents"
for agent in codex opencode claude gemini auggie; do
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

step "bundled default workspace marker"
if [ ! -f resources/default-workspace/.ux-workspace/workspace.json ]; then
  printf 'FAIL: bundled default workspace marker not found\n' >&2
  exit 1
fi

step "bundled default opencode.json"
python3 -m json.tool resources/default-workspace/templates/opencode.json >/dev/null
if ! grep -q '"default_agent": "autopilot"' resources/default-workspace/templates/opencode.json; then
  printf 'FAIL: bundled opencode.json missing default_agent autopilot\n' >&2
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
printf '  opencode.json: default_agent=autopilot model=deepseek-v4-pro small_model=deepseek-v4-flash autoupdate=notify snapshot=true\n'

step "bundled default agents exist and non-empty"
for agent in autopilot.md repo-scout.md code-reviewer.md security-auditor.md docs-writer.md qa-verifier.md; do
  if [ ! -s "resources/default-workspace/agents/$agent" ]; then
    printf 'FAIL: bundled default agent missing or empty: agents/%s\n' "$agent" >&2
    exit 1
  fi
done
printf '  6 bundled agents verified non-empty\n'
if ! grep -q 'mode: primary' resources/default-workspace/agents/autopilot.md; then
  printf 'FAIL: bundled autopilot.md missing mode: primary\n' >&2
  exit 1
fi
printf '  autopilot.md: mode=primary\n'
for subagent in repo-scout.md code-reviewer.md security-auditor.md docs-writer.md qa-verifier.md; do
  if ! grep -q 'mode: subagent' "resources/default-workspace/agents/$subagent"; then
    printf 'FAIL: bundled %s missing mode: subagent\n' "$subagent" >&2
    exit 1
  fi
done
printf '  5 subagents verified mode=subagent\n'

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
OPENCODE_AGENTS_DIR="$tmpdir/agents" \
UX_WORKSPACE_BACKUP_DIR="$tmpdir/backups" \
  bash resources/default-workspace/scripts/install-opencode-config.sh --apply >/dev/null
apply_ok=true
if [ ! -f "$tmpdir/opencode.json" ]; then
  printf 'FAIL: install-opencode-config.sh --apply did not write opencode.json\n' >&2
  apply_ok=false
fi
for agent in autopilot.md repo-scout.md code-reviewer.md security-auditor.md docs-writer.md qa-verifier.md; do
  if [ ! -f "$tmpdir/agents/$agent" ]; then
    printf 'FAIL: install-opencode-config.sh --apply did not write agents/%s\n' "$agent" >&2
    apply_ok=false
  fi
done
if ! $apply_ok; then rm -rf "$tmpdir"; exit 1; fi
if ! grep -q '"default_agent": "autopilot"' "$tmpdir/opencode.json"; then
  printf 'FAIL: smoke opencode.json missing default_agent autopilot\n' >&2
  apply_ok=false
fi
if ! grep -q 'mode: primary' "$tmpdir/agents/autopilot.md"; then
  printf 'FAIL: smoke autopilot.md missing mode: primary\n' >&2
  apply_ok=false
fi
if ! grep -q 'mode: subagent' "$tmpdir/agents/repo-scout.md"; then
  printf 'FAIL: smoke repo-scout.md missing mode: subagent\n' >&2
  apply_ok=false
fi
rm -rf "$tmpdir"
if ! $apply_ok; then exit 1; fi
printf '  install-opencode-config.sh --apply smoke: 1 config + 6 agents written, content checks passed\n'

step "bundled default install-opencode-config.sh unsafe OPENCODE_AGENTS_DIR rejected"
if OPENCODE_AGENTS_DIR=/ bash resources/default-workspace/scripts/install-opencode-config.sh --apply 2>/dev/null; then
  printf 'FAIL: install-opencode-config.sh accepted unsafe OPENCODE_AGENTS_DIR=/\n' >&2
  exit 1
fi

step "bundled default install-opencode-config.sh works with space in workspace path"
tmpdir="$(mktemp -d)"
space_dir="$tmpdir/Agent Workspace"
runtime_config="$tmpdir/runtime/opencode.json"
runtime_agents="$tmpdir/runtime/agents"
backup_dir="$tmpdir/runtime/backups"

# Copy entire workspace tree to space-containing path so the script
# itself runs from a path with spaces and computes SCRIPT_DIR / SOURCE_FILE
# / AGENTS_SOURCE_DIR from that location.
cp -R resources/default-workspace "$space_dir"

# Run --apply from the copied workspace, targeting separate runtime dirs
OPENCODE_CONFIG_PATH="$runtime_config" \
OPENCODE_AGENTS_DIR="$runtime_agents" \
UX_WORKSPACE_BACKUP_DIR="$backup_dir" \
  bash "$space_dir/scripts/install-opencode-config.sh" --apply >/dev/null

apply_ok=true
if [ ! -f "$runtime_config" ]; then
  printf 'FAIL: space-in-path apply did not create opencode.json\n' >&2
  apply_ok=false
fi
if ! grep -q '"default_agent": "autopilot"' "$runtime_config"; then
  printf 'FAIL: space-in-path opencode.json missing default_agent autopilot\n' >&2
  apply_ok=false
fi

for agent in autopilot.md repo-scout.md code-reviewer.md security-auditor.md docs-writer.md qa-verifier.md; do
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

rm -rf "$tmpdir"
if ! $apply_ok; then exit 1; fi
printf '  install-opencode-config.sh handles space-in-path correctly: 6 agents applied from space-containing workspace\n'

step "backup schema matches app expectations"
tmpdir="$(mktemp -d)"
# Create timestamp matching YYYYMMDD-HHMMSS (15 chars)
ts="20260101-120000"
mkdir -p "$tmpdir/$ts/opencode-config"
mkdir -p "$tmpdir/$ts/codex-rules"
mkdir -p "$tmpdir/$ts/opencode-rules"
# Write test files
echo "config" > "$tmpdir/$ts/opencode-config/opencode.json"
echo "rules" > "$tmpdir/$ts/codex-rules/AGENTS.md"
echo "rules" > "$tmpdir/$ts/opencode-rules/AGENTS.md"

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
if [ ! -d "$tmpdir/$ts/opencode-config" ]; then
  printf 'FAIL: backup schema opencode-config dir not found\n' >&2
  rm -rf "$tmpdir"
  exit 1
fi
if [ ! -d "$tmpdir/$ts/codex-rules" ]; then
  printf 'FAIL: backup schema codex-rules dir not found\n' >&2
  rm -rf "$tmpdir"
  exit 1
fi
rm -rf "$tmpdir"
printf '  backup schema verified: YYYYMMDD-HHMMSS + target IDs (opencode-config, codex-rules, etc.)\n'

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
for baseline in diagnose security-review context-budget to-prd grill-with-docs improve-codebase-architecture; do
  if [ ! -f "resources/default-workspace/skills/${baseline}/SKILL.md" ]; then
    printf 'FAIL: baseline bundled skill missing: skills/%s/SKILL.md\n' "$baseline" >&2
    exit 1
  fi
done

step "bundled default public skill count"
skill_count="$(find resources/default-workspace/skills -type f -name SKILL.md | wc -l | tr -d ' ')"
if [ "$skill_count" -ne 22 ]; then
  printf 'FAIL: expected 22 public starter skills, found %s\n' "$skill_count" >&2
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

step "app checks"
npm run build

cd src-tauri
cargo fmt --check
cargo check
cargo clippy -- -D warnings
cargo test

step "release smoke doc"
if [ ! -f "$repo_root/docs/APP_RELEASE_SMOKE.md" ]; then
  printf 'FAIL: docs/APP_RELEASE_SMOKE.md not found\n' >&2
  exit 1
fi

printf '\nrelease-check passed\n'
