#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-skills.sh [options]

Install workspace skills to agent tool skill folders.

Options:
  --agent <target>    Agent target: codex, opencode, claude, gemini, auggie
  --global            Install globally (system-wide)
  --project           Install into a project folder
  --target <path>     Project target directory (required with --project)
  --skill <name>      Install a single skill by name
  --all               Install all available skills
  --core              Install all skills (backward-compatible alias for --all)
  --dry-run           Preview without writing files
  --list              List available skills
  --quiet             Print compact app-friendly output
  --help              Show this help

Default mode is dry-run. Use without --dry-run to install.
USAGE
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--list" ]]; then
  printf 'No skills installed in this starter workspace.\n'
  printf 'Add skills under the skills/ directory, then run again.\n'
  exit 0
fi

if [[ "${1:-}" == "--quiet" && "${2:-}" == "--dry-run" ]]; then
  printf 'skills     (no skills to install)\n'
  exit 0
fi

printf 'This is a starter workspace skills install script.\n'
printf 'Install behavior will be handled by future app flows\n'
printf 'or customized workspace scripts. No files are written in\n'
printf 'this default placeholder.\n'
printf '\nRun with --help for usage information.\n'
exit 0
