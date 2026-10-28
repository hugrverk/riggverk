#!/usr/bin/env bash
# The local release gate. Each step names the script that owns its checks; docs/MAINTAINING.md
# says what each one guards and how to run it alone.
set -euo pipefail

if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  found="$(python3 --version 2>&1)" || found="python3 not found"
  printf 'FAIL: python3 3.11 or newer is required by scripts/release-check.sh (found: %s); put a newer python3 first on PATH\n' "$found" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
# Python helpers under resources/ are shipped in the app bundle; never leave bytecode caches there.
export PYTHONDONTWRITEBYTECODE=1

step_name=""
step_start=$SECONDS
step() {
  if [ -n "$step_name" ]; then
    printf '  (%ss)\n' "$((SECONDS - step_start))"
  fi
  step_name="$1"
  step_start=$SECONDS
  printf '\n==> %s\n' "$1"
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/riggverk-release-check.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

# Run a unittest file and fail when it fails or collects no tests (older Pythons
# exit 0 for "Ran 0 tests").
run_python_unittests() {
  local test_file="$1" test_log="$tmp_dir/unittest.log"
  if ! python3 -m unittest "$test_file" >"$test_log" 2>&1; then
    cat "$test_log" >&2
    printf 'FAIL: %s\n' "$test_file" >&2
    return 1
  fi
  if grep -q '^Ran 0 tests' "$test_log"; then
    cat "$test_log" >&2
    printf 'FAIL: %s ran no tests\n' "$test_file" >&2
    return 1
  fi
  printf '  %s: %s\n' "$test_file" "$(grep '^Ran ' "$test_log" | head -1)"
}

step "repo state"
git status --short
# Worktree and staged changes, plus everything committed since the merge base.
git diff --check
git diff --cached --check
diff_base=""
for diff_base_candidate in origin/main main; do
  if git rev-parse --verify --quiet "$diff_base_candidate" >/dev/null; then
    diff_base="$(git merge-base "$diff_base_candidate" HEAD 2>/dev/null || true)"
    if [ -n "$diff_base" ]; then
      break
    fi
  fi
done
if [ "$diff_base" = "$(git rev-parse HEAD)" ]; then
  diff_base="$(git rev-parse --verify --quiet 'HEAD~1' || true)"
fi
if [ -n "$diff_base" ]; then
  git diff --check "$diff_base" HEAD
  printf '  whitespace/conflict-marker check covers %s..HEAD, staged and worktree changes\n' "$(printf '%s' "$diff_base" | cut -c1-8)"
else
  printf '  no merge base found; committed changes were not checked\n'
fi

step "toolchain"
for tool in git node npm cargo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'FAIL: %s not found on PATH\n' "$tool" >&2
    exit 1
  fi
done
printf '  %s, node %s, %s\n' "$(python3 --version)" "$(node --version)" "$(cargo --version)"

step "shell syntax"
while IFS= read -r shell_script; do
  bash -n "$shell_script"
done < <(git ls-files '*.sh')
printf '  bash -n passed for every tracked .sh file\n'

step "generated files are current"
python3 scripts/generate.py check

step "python tests"
for test_file in scripts/test_*.py; do
  run_python_unittests "$test_file"
done

step "app version agrees"
printf '  app version %s agrees across package.json, tauri.conf.json, Cargo.toml and both lock files\n' \
  "$(python3 scripts/release_tools.py check-versions)"

step "README and docs drift"
python3 scripts/check-readme-docs-drift.py

step "skill catalog and routing"
python3 scripts/check-skill-routing.py

step "workspace copy list and Library docs registry"
python3 scripts/check-retired-workspace-files.py
python3 scripts/check-curated-library-docs.py

step "bundle content"
python3 scripts/check-bundle-content.py

step "Cursor profile"
python3 scripts/check-cursor-profile.py
python3 scripts/check-cursor-action-compat.py

step "bundled Codex merge script tests"
# A plain script with its own runner (not unittest): require a non-zero test count.
merge_log="$tmp_dir/merge-codex-config.log"
mkdir -p "$tmp_dir/home"
if ! HOME="$tmp_dir/home" python3 resources/default-workspace/scripts/test_merge_codex_config.py >"$merge_log" 2>&1; then
  cat "$merge_log" >&2
  printf 'FAIL: test_merge_codex_config.py\n' >&2
  exit 1
fi
merge_count="$(sed -n 's/^All \([0-9][0-9]*\) test(s) PASSED$/\1/p' "$merge_log")"
if [ -z "$merge_count" ] || [ "$merge_count" -lt 1 ]; then
  cat "$merge_log" >&2
  printf 'FAIL: test_merge_codex_config.py ran no tests\n' >&2
  exit 1
fi
printf '  test_merge_codex_config.py: %s tests passed\n' "$merge_count"

step "OpenCode permission contract"
python3 scripts/validate_opencode_permissions.py

step "harness ids agree across Rust, TypeScript and the light descriptor"
python3 scripts/check-harness-mirror.py

step "managed installation contract"
python3 scripts/check-managed-installation-contract.py

step "shell command-string spawns in Rust"
python3 scripts/check-shell-spawn.py

step "source: identity, Tauri config, startup order"
python3 scripts/check-source.py --group identity,tauri-conf,startup-order

step "source: forbidden patterns and required markers"
python3 scripts/check-source.py --group forbidden,require

step "source: UI"
python3 scripts/check-source.py --group ui

step "public residue: no retired name outside the allowlist"
python3 scripts/check-public-residue.py

step "frontend typecheck"
npm run typecheck

step "frontend tests and build"
npm test
npm run build

step "rust fmt"
cargo fmt --manifest-path src-tauri/Cargo.toml --check

step "rust clippy"
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings

step "rust tests"
# residue-allow-begin: the earlier aliases must not leak into the test run
env -u RIGGVERK_SMOKE -u RIGGVERK_WORKSPACE_PATH -u RIGGVERK_BACKUP_DIR \
  -u AGENT_WORKSPACE_PATH -u AGENT_WORKSPACE_BACKUP_DIR \
  cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1
# residue-allow-end

step "real pre-manifest source-commit upgrade smoke"
bash scripts/smoke-pre-manifest-upgrade.sh

step "tauri runtime smoke"
bash scripts/smoke-tauri-runtime.sh

printf '  (%ss)\n\n  total %ss\n' "$((SECONDS - step_start))" "$SECONDS"
printf '\nrelease-check passed\n'
