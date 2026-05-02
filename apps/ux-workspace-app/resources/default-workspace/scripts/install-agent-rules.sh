#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-agent-rules.sh [options]

Sync agent rules from templates/global-agent-rules.md to tool-specific paths.

Options:
  --apply          Write target files
  --diff           Show diffs without writing
  --codex          Select Codex rule target
  --opencode       Select OpenCode rule target
  --auggie         Select Auggie rule target
  --claude         Select Claude rule target
  --gemini         Select Gemini rule target
  --all            Select all rule targets (default)
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

printf 'This is a starter workspace agent rules sync script.\n'
printf 'Sync behavior will be handled by future app flows\n'
printf 'or customized workspace scripts. No files are written in\n'
printf 'this default placeholder.\n'
printf '\nRun with --help for usage information.\n'
exit 0
