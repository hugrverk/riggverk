#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RULES_SCRIPT="$SCRIPT_DIR/install-agent-rules.sh"
CONFIG_SCRIPT="$SCRIPT_DIR/install-opencode-config.sh"
CODEX_CONFIG_SCRIPT="$SCRIPT_DIR/install-codex-config.sh"
CURSOR_SCRIPT="$SCRIPT_DIR/install-cursor-workspace.sh"
SKILLS_SCRIPT="$SCRIPT_DIR/install-skills.sh"

usage() {
  cat <<'USAGE'
Usage: ./scripts/bootstrap.sh [options]

Run all workspace sync and install steps together.

Options:
  --apply          Write target files and install skills
  --diff           Show diffs for rules and OpenCode config
  --agent <target> Skill agent target (repeatable, passed to skills install)
  --skills-only    Run only skills install
  --rules-only     Run only agent rules sync
  --opencode-only  Run only OpenCode config sync
  --codex-only     Run only Codex config sync
  --cursor-only    Run only Cursor workspace setup
  --skip-skills    Skip skills install
  --skip-rules     Skip agent rules sync
  --skip-opencode  Skip OpenCode config sync
  --skip-codex     Skip Codex config sync
  --skip-cursor    Skip Cursor workspace setup
  --cursor         Include Cursor workspace setup (not enabled by default)
  --codex          Rule target: Codex (passed to rules script)
  --opencode       Rule target: OpenCode (passed to rules script)
  --auggie         Rule target: Auggie (passed to rules script)
  --claude         Rule target: Claude (passed to rules script)
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run (preview only). Use --apply to write files.
USAGE
}

apply=false
diff_mode=false
quiet=false
skip_skills=false
skip_rules=false
skip_opencode=false
skip_codex=false
skip_cursor=false
skills_only=false
rules_only=false
opencode_only=false
codex_only=false
cursor_only=false
include_cursor=false

declare -a rule_flags=()
declare -a skill_agent_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --diff) diff_mode=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    --skip-skills) skip_skills=true ;;
    --skip-rules) skip_rules=true ;;
    --skip-opencode) skip_opencode=true ;;
    --skip-codex) skip_codex=true ;;
    --skip-cursor) skip_cursor=true ;;
    --cursor) include_cursor=true ;;
    --skills-only) skills_only=true ;;
    --rules-only) rules_only=true ;;
    --opencode-only) opencode_only=true ;;
    --codex-only) codex_only=true ;;
    --cursor-only) cursor_only=true ;;
    --codex)   rule_flags+=(--codex) ;;
    --opencode) rule_flags+=(--opencode) ;;
    --auggie)   rule_flags+=(--auggie) ;;
    --claude)   rule_flags+=(--claude) ;;
    --agent)
      shift
      if [ $# -eq 0 ]; then
        printf 'bootstrap.sh: --agent requires a target name\n' >&2
        exit 1
      fi
      skill_agent_args+=(--agent "$1")
      ;;
    *)
      printf 'bootstrap.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# narrow-mode flags
if $skills_only && ($rules_only || $opencode_only || $codex_only || $cursor_only); then
  printf 'bootstrap.sh: only one narrow mode may be used\n' >&2
  exit 1
fi
if $rules_only && ($opencode_only || $codex_only || $cursor_only); then
  printf 'bootstrap.sh: only one narrow mode may be used\n' >&2
  exit 1
fi
if $opencode_only && ($codex_only || $cursor_only); then
  printf 'bootstrap.sh: only one narrow mode may be used\n' >&2
  exit 1
fi
if $codex_only && $cursor_only; then
  printf 'bootstrap.sh: only one narrow mode may be used\n' >&2
  exit 1
fi

run_rules=true
run_config=true
run_codex_config=true
run_skills=true
run_cursor=false

if $skills_only; then
  run_rules=false; run_config=false; run_codex_config=false; run_skills=true
elif $rules_only; then
  run_rules=true; run_config=false; run_codex_config=false; run_skills=false
elif $opencode_only; then
  run_rules=false; run_config=true; run_codex_config=false; run_skills=false
elif $codex_only; then
  run_rules=false; run_config=false; run_codex_config=true; run_skills=false
elif $cursor_only; then
  run_rules=false; run_config=false; run_codex_config=false; run_skills=false; run_cursor=true
fi

$skip_rules  && run_rules=false
$skip_opencode && run_config=false
$skip_codex && run_codex_config=false
$skip_skills && run_skills=false
$include_cursor && run_cursor=true
$skip_cursor && run_cursor=false

# --- resolve args for sub-scripts ---
declare -a rules_args=()
declare -a config_args=()
declare -a codex_config_args=()
declare -a cursor_args=()
declare -a skills_args=()

$quiet && rules_args+=(--quiet)
$quiet && config_args+=(--quiet)
$quiet && codex_config_args+=(--quiet)
$quiet && cursor_args+=(--quiet)
$quiet && skills_args+=(--quiet)

if $apply; then
  rules_args+=(--apply)
  config_args+=(--apply)
  codex_config_args+=(--apply)
  cursor_args+=(--apply)
elif $diff_mode; then
  rules_args+=(--diff)
  config_args+=(--diff)
  codex_config_args+=(--diff)
fi

for flag in "${rule_flags[@]}"; do
  rules_args+=("$flag")
done

if [ "${#skill_agent_args[@]}" -gt 0 ]; then
  for arg in "${skill_agent_args[@]}"; do
    skills_args+=("$arg")
  done
fi

if $apply; then
  skills_args+=(--global --all)
else
  skills_args+=(--dry-run --global --all)
fi

# --- header ---
if ! $quiet; then
  printf '\nBootstrap\n'
  printf '  Workspace: %s\n' "$WORKSPACE_ROOT"
  if $apply; then
    printf '  Mode: apply\n'
  elif $diff_mode; then
    printf '  Mode: diff\n'
  else
    printf '  Mode: dry-run\n'
  fi
  if $run_rules;   then printf '  Rules: yes\n'; else printf '  Rules: skipped\n'; fi
  if $run_config;  then printf '  OpenCode config: yes\n'; else printf '  OpenCode config: skipped\n'; fi
  if $run_codex_config; then printf '  Codex config: yes\n'; else printf '  Codex config: skipped\n'; fi
  if $run_cursor;  then printf '  Cursor: yes\n'; else printf '  Cursor: skipped\n'; fi
  if $run_skills;  then printf '  Skills: yes\n'; else printf '  Skills: skipped\n'; fi
fi

exit_code=0

if $run_rules; then
  if ! $quiet; then printf '  [rules]\n'; fi
  if [ "${#rule_flags[@]}" -eq 0 ]; then
    "$RULES_SCRIPT" --all "${rules_args[@]}" || exit_code=$?
  else
    "$RULES_SCRIPT" "${rules_args[@]}" || exit_code=$?
  fi
fi

if $run_config; then
  if ! $quiet; then printf '  [opencode-config]\n'; fi
  "$CONFIG_SCRIPT" "${config_args[@]}" || exit_code=$?
fi

if $run_codex_config; then
  if ! $quiet; then printf '  [codex-config]\n'; fi
  "$CODEX_CONFIG_SCRIPT" "${codex_config_args[@]}" || exit_code=$?
fi

if $run_cursor; then
  if ! $quiet; then printf '  [cursor]\n'; fi
  "$CURSOR_SCRIPT" --global-agents "${cursor_args[@]}" || exit_code=$?
fi

if $run_skills; then
  if ! $quiet; then printf '  [skills]\n'; fi
  "$SKILLS_SCRIPT" "${skills_args[@]}" || exit_code=$?
fi

exit "$exit_code"
