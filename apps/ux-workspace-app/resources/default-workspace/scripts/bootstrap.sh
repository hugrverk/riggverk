#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/bootstrap.sh [options]

Run all workspace sync and install steps together.

Options:
  --apply          Write target files and install skills
  --diff           Show diffs for rules and OpenCode config
  --agent <target> Skill agent target
  --skills-only    Run only skills install
  --rules-only     Run only agent rules sync
  --opencode-only  Run only OpenCode config sync
  --skip-skills    Skip skills install
  --skip-rules     Skip agent rules sync
  --skip-opencode  Skip OpenCode config sync
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run (preview only). Use --apply to write files.
USAGE
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

printf 'This is a starter workspace bootstrap script.\n'
printf 'Install/sync behavior will be handled by future app flows\n'
printf 'or customized workspace scripts. No files are written in\n'
printf 'this default placeholder.\n'
printf '\nRun with --help for usage information.\n'
exit 0
