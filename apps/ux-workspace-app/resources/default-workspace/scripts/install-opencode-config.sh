#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-opencode-config.sh [options]

Sync OpenCode config from templates/opencode.json to the OpenCode config path.

Options:
  --apply          Write target file
  --diff           Show diff without writing
  --quiet          Print compact app-friendly output
  --help           Show this help

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

printf 'This is a starter workspace OpenCode config sync script.\n'
printf 'Sync behavior will be handled by future app flows\n'
printf 'or customized workspace scripts. No files are written in\n'
printf 'this default placeholder.\n'
printf '\nRun with --help for usage information.\n'
exit 0
