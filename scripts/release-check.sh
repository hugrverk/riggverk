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
    rg -n "$pattern" scripts apps/ux-workspace-app/src-tauri apps/ux-workspace-app/src \
      -g '!scripts/release-check.sh' \
      -g '!apps/ux-workspace-app/src-tauri/target/**' \
      -g '!apps/ux-workspace-app/node_modules/**' \
      -g '!apps/ux-workspace-app/dist/**' \
      >"$scan_tmp" || true
  else
    find scripts apps/ux-workspace-app/src-tauri apps/ux-workspace-app/src \
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

step "bundled default workspace scripts"
bash -n apps/ux-workspace-app/resources/default-workspace/scripts/bootstrap.sh
bash -n apps/ux-workspace-app/resources/default-workspace/scripts/install-skills.sh
bash -n apps/ux-workspace-app/resources/default-workspace/scripts/install-agent-rules.sh
bash -n apps/ux-workspace-app/resources/default-workspace/scripts/install-opencode-config.sh

step "bundled default workspace marker"
if [ ! -f apps/ux-workspace-app/resources/default-workspace/.ux-workspace/workspace.json ]; then
  printf 'FAIL: bundled default workspace marker not found\n' >&2
  exit 1
fi

step "bundled default opencode.json"
python3 -m json.tool apps/ux-workspace-app/resources/default-workspace/templates/opencode.json >/dev/null

step "tauri app resources config"
if ! search_quiet "default-workspace" apps/ux-workspace-app/src-tauri/tauri.conf.json; then
  printf 'FAIL: tauri conf missing bundled default workspace resource path\n' >&2
  exit 1
fi

step "bundled default skills non-empty"
skill_files="$(find apps/ux-workspace-app/resources/default-workspace/skills -type f -name SKILL.md)"
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
for baseline in diagnose security-review context-budget; do
  if [ ! -f "apps/ux-workspace-app/resources/default-workspace/skills/${baseline}/SKILL.md" ]; then
    printf 'FAIL: baseline bundled skill missing: skills/%s/SKILL.md\n' "$baseline" >&2
    exit 1
  fi
done

step "bundled default no private workflow skills"
if search_has_match "woocommerce-pdp-review|wordpress-woocommerce|nextjs-product-slice|supabase-rls-review" \
  apps/ux-workspace-app/resources/default-workspace \
  apps/ux-workspace-app/src-tauri/src/commands/defaults.rs; then
  printf 'FAIL: bundled default workspace must not contain private/domain-specific workflow skills\n' >&2
  exit 1
fi

step "bundled default no private names"
private_name_pattern="$(printf '%s|' "C""arl" "Dis""chornan" "Disch""örnan" "Hantverks""registret" "Auggie cred""its" "personal mod""el")"
private_name_pattern="${private_name_pattern%|}"
if search_has_match -w "$private_name_pattern" apps/ux-workspace-app/resources/default-workspace; then
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
cd apps/ux-workspace-app
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
