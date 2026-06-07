#!/usr/bin/env bash
set -euo pipefail

caller_dir="$PWD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/cursor-global-profile-lib.sh
. "$WORKSPACE_ROOT/scripts/cursor-global-profile-lib.sh"

RULES_SOURCE="$WORKSPACE_ROOT/templates/cursor/rules"
USER_RULES_SOURCE="$WORKSPACE_ROOT/templates/cursor/user-rules.md"
SANDBOX_SOURCE="$WORKSPACE_ROOT/templates/cursor/sandbox"

apply=false
quiet=false
global_agents=false
project_agents=false
project_rules=false
diff_global_profile=false
apply_global_profile=false
validate_global_profile=false
show_user_rules=false
copy_user_rules=false
open_cursor_settings=false
show_playwright_mcp=false
copy_playwright_mcp=false
show_sandbox_profile=""
copy_sandbox_profile=""
target=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-cursor-workspace.sh [options]

Global profile (primary):
  --diff-global-profile    Dry-run global Playwright profile (agents, skills, MCP, permissions)
  --apply-global-profile   Apply global profile to ~/.cursor (no project writes)
  --validate-global-profile
                           Validate templates and installed global profile state

Global profile surfaces:
  ~/.cursor/agents         workspace Cursor subagents
  ~/.cursor/skills         recommended pinned skills (cursor agent)
  ~/.cursor/mcp.json       merge playwright MCP server only
  ~/.cursor/permissions.json
                           merge mcpAllowlist (playwright:*) only; shell stays restricted

Options:
  --apply                  Write target files (default is dry-run)
  --global-agents          Install Cursor subagents to ${CURSOR_AGENTS_PATH:-$HOME/.cursor/agents}
  --global-agents-only     Alias for --global-agents (legacy)
  --project-agents         CLI-only: project agents to <target>/.cursor/agents
  --project-rules          CLI-only: project rules to <target>/.cursor/rules
  --project                Alias for --project-agents --project-rules (CLI-only)
  --all                    CLI-only: all project + global agent targets
  --target <path>          CLI-only project path (default: current directory)
  --user-rules             Operate on Cursor User Rules (versioned copy, not auto-installed)
  --show-user-rules        Print versioned Cursor User Rules
  --copy-user-rules        Copy User Rules to clipboard (macOS pbcopy)
  --show-playwright-mcp    Print Playwright MCP template (debug)
  --copy-playwright-mcp    Copy Playwright MCP template to clipboard (debug)
  --show-sandbox-profile <safe|playwright-safe|playwright-full>
                           Print legacy sandbox template (debug)
  --copy-sandbox-profile <safe|playwright-safe|playwright-full>
                           Copy legacy sandbox template (debug)
  --open-cursor-settings   Open Cursor Settings (macOS)
  --quiet                  Compact output
  --help                   Show this help

Default (no options): --diff-global-profile

The global profile never writes project .cursor/*, .cursorignore, or AGENTS.md.
USAGE
}

die() {
  printf 'install-cursor-workspace.sh: %s\n' "$*" >&2
  exit 1
}

has_project_marker() {
  local dir="$1" marker
  for marker in .git package.json Cargo.toml composer.json pyproject.toml AGENTS.md .opencode .codex .cursor wp-content wordpress/wp-content; do
    [ -e "$dir/$marker" ] && return 0
  done
  return 1
}

validate_project_target() {
  local raw="$1"
  [ -d "$raw" ] || die "project target does not exist or is not a directory: $raw"
  local resolved home tmp_root slash_tmp
  resolved="$(cd "$raw" && pwd -P)"
  home="${HOME:?}"
  tmp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P || printf '%s' "${TMPDIR:-/tmp}")"
  slash_tmp="$(cd /tmp 2>/dev/null && pwd -P || printf '%s' /tmp)"
  for broad in / /Users "$home" "$home/Projects" "$tmp_root" "$slash_tmp"; do
    [ "$resolved" = "$broad" ] && die "refusing broad project target: $resolved"
  done
  has_project_marker "$resolved" || die "project target does not look like a project checkout: $resolved"
  printf '%s' "$resolved"
}

sandbox_profile_path() {
  case "$1" in
    safe|playwright-safe|playwright-full) printf '%s/%s.json' "$SANDBOX_SOURCE" "$1" ;;
    *) die "unknown sandbox profile: $1" ;;
  esac
}

ensure_dest_root() {
  local root="$1"
  [ -n "$root" ] || die "empty destination root"
  case "$root" in
    /|/Users|"$HOME"|"$HOME/") die "refusing broad destination root: $root" ;;
  esac
}

ensure_child() {
  local root="$1" child="$2"
  [ "$child" = "$root" ] && die "refusing destination root as child"
  case "$child" in "$root"/*) ;; *) die "destination outside root: $child" ;; esac
}

backup_root() {
  if [ -n "${AGENT_WORKSPACE_BACKUP_DIR:-}" ]; then
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
  else
    printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "${HOME:?}"
  fi
}

BACKUP_ROOT="$(backup_root)"
case "$BACKUP_ROOT" in /|"$HOME"|"") die "refusing broad backup root: $BACKUP_ROOT" ;; esac
backup_timestamp="$(date -u +%Y%m%d-%H%M%S)"

backup_file() {
  local path="$1" label="$2"
  [ -f "$path" ] || return 0
  local backup_dir="$BACKUP_ROOT/$backup_timestamp/$label"
  mkdir -p "$backup_dir"
  cp "$path" "$backup_dir/$(basename "$path")"
}

recommended_skills() {
  "$AW_PYTHON" - "$CURSOR_MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
for name in manifest.get("recommended_pinned_skills", []):
    print(name)
PY
}

install_agents() {
  local dest_root="$1" label="$2"
  local count=0 source name dest
  ensure_dest_root "$dest_root"
  [ -d "$CURSOR_AGENTS_SOURCE" ] || die "Cursor agents source not found: $CURSOR_AGENTS_SOURCE"
  for source in "$CURSOR_AGENTS_SOURCE"/*.md; do
    [ -f "$source" ] || continue
    name="$(basename "$source")"
    dest="$dest_root/$name"
    ensure_child "$dest_root" "$dest"
    count=$((count + 1))
    if $apply; then
      mkdir -p "$dest_root"
      backup_file "$dest" cursor-agents
      cp "$source" "$dest"
    fi
  done
  local verb
  if $apply; then verb=written; else verb=planned; fi
  if $quiet; then
    printf '%-18s %s %s\n' "$label" "$verb" "$count"
  else
    if $apply; then verb=Installed; else verb=Planned; fi
    printf '%s Cursor agents: %s -> %s (%s files)\n' "$verb" "$CURSOR_AGENTS_SOURCE" "$dest_root" "$count"
  fi
}

agents_diff_status() {
  local dest_root="$1"
  "$AW_PYTHON" - "$CURSOR_AGENTS_SOURCE" "$dest_root" <<'PY'
import sys
from pathlib import Path

source_dir, target_dir = Path(sys.argv[1]), Path(sys.argv[2])
sources = sorted(source_dir.glob("*.md"))
if not sources:
    print("missing")
    raise SystemExit(0)
if not target_dir.is_dir():
    print("missing")
    raise SystemExit(0)
installed = missing = diverged = 0
for source in sources:
    target = target_dir / source.name
    if not target.is_file():
        missing += 1
    elif source.read_bytes() == target.read_bytes():
        installed += 1
    else:
        diverged += 1
if missing == 0 and diverged == 0:
    print("synced")
elif installed == 0 and diverged == 0:
    print("missing")
elif missing > 0 and diverged == 0:
    print("partial")
else:
    print("diverged")
PY
}

skills_diff_status() {
  local dest_root="$1"
  "$AW_PYTHON" - "$CURSOR_MANIFEST" "$CURSOR_SKILLS_SOURCE" "$dest_root" <<'PY'
import json
import sys
from pathlib import Path

manifest_path, skills_root, target_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
required = manifest.get("recommended_pinned_skills", [])
if not required:
    print("missing")
    raise SystemExit(0)
if not target_dir.is_dir():
    print("missing")
    raise SystemExit(0)
installed = missing = diverged = 0
for name in required:
    source = skills_root / name / "SKILL.md"
    target = target_dir / name / "SKILL.md"
    if not source.is_file():
        print("partial")
        raise SystemExit(0)
    if not target.is_file():
        missing += 1
    elif source.read_bytes() == target.read_bytes():
        installed += 1
    else:
        diverged += 1
if missing == 0 and diverged == 0:
    print("synced")
elif installed == 0 and diverged == 0:
    print("missing")
elif missing > 0 and diverged == 0:
    print("partial")
else:
    print("diverged")
PY
}

install_global_skills() {
  local label="global-skills"
  if [ ! -x "$SKILLS_SCRIPT" ] && [ ! -f "$SKILLS_SCRIPT" ]; then
    die "skills script not found: $SKILLS_SCRIPT"
  fi
  ensure_global_write_target "$CURSOR_SKILLS_TARGET" skills
  local -a skill_args=()
  while IFS= read -r skill; do
    [ -n "$skill" ] || continue
    skill_args+=(--skill "$skill")
  done < <(recommended_skills)
  if [ ${#skill_args[@]} -eq 0 ]; then
    die "no recommended skills in manifest"
  fi
  if $apply; then
    "$AW_BASH" "$SKILLS_SCRIPT" --global --agent cursor --quiet "${skill_args[@]}"
    printf '%-18s %s %s\n' "$label" written "${#skill_args[@]}"
  else
    "$AW_BASH" "$SKILLS_SCRIPT" --global --agent cursor --dry-run --quiet "${skill_args[@]}" >/dev/null
    local status
    status="$(skills_diff_status "$CURSOR_SKILLS_TARGET")"
    printf '%-18s %s %s\n' "$label" planned "${#skill_args[@]} ($status)"
  fi
}

mcp_diff_status() {
  resolve_playwright_paths || {
    printf 'unsupported'
    return 0
  }
  "$AW_PYTHON" - "$CURSOR_MCP_TEMPLATE" "$CURSOR_MCP_TARGET" "$PLAYWRIGHT_MCP_CONFIG_PATH_RESOLVED" "$PLAYWRIGHT_BROWSERS_PATH_RESOLVED" "$PLAYWRIGHT_MCP_VERSION" <<'PY'
import json
import sys
from pathlib import Path

template_path, target_path, config_path, browsers_path, version = sys.argv[1:6]
package = f"@playwright/mcp@{version}"

with open(template_path, encoding="utf-8") as handle:
    template = json.load(handle)
expected = template.get("mcpServers", {}).get("playwright", {})

def transform(value):
    if isinstance(value, dict):
        return {k: transform(v) for k, v in value.items()}
    if isinstance(value, list):
        return [transform(v) for v in value]
    if isinstance(value, str):
        if value == "__PLAYWRIGHT_MCP_CONFIG_PATH__":
            return config_path
        if value == "__PLAYWRIGHT_BROWSERS_PATH__":
            return browsers_path
        if value.startswith("@playwright/mcp@"):
            return package
        return value
    return value

expected = transform(expected)
target = Path(target_path)
if not target.is_file():
    print("missing")
    raise SystemExit(0)
with target.open(encoding="utf-8") as handle:
    data = json.load(handle)
actual = data.get("mcpServers", {}).get("playwright")
print("synced" if actual == expected else "diverged")
PY
}

apply_global_mcp() {
  local label="global-mcp"
  ensure_global_write_target "$CURSOR_MCP_TARGET" mcp
  resolve_playwright_paths || die "could not resolve Playwright MCP paths for this platform"
  validate_json_file "$CURSOR_MCP_TEMPLATE" || die "Playwright MCP template invalid JSON"
  if $apply; then
    mkdir -p "$(dirname "$CURSOR_MCP_TARGET")"
    backup_file "$CURSOR_MCP_TARGET" cursor-mcp
    merge_cursor_playwright_mcp \
      "$CURSOR_MCP_TEMPLATE" \
      "$CURSOR_MCP_TARGET" \
      "$PLAYWRIGHT_MCP_CONFIG_PATH_RESOLVED" \
      "$PLAYWRIGHT_BROWSERS_PATH_RESOLVED" \
      "$PLAYWRIGHT_MCP_VERSION"
    validate_json_file "$CURSOR_MCP_TARGET" || die "Cursor MCP JSON invalid after merge"
    printf '%-18s %s %s\n' "$label" written 1
  else
    local status
    status="$(mcp_diff_status)"
    printf '%-18s %s %s\n' "$label" planned "$status"
  fi
}

apply_global_permissions() {
  local label="global-permissions"
  ensure_global_write_target "$CURSOR_PERMISSIONS_TARGET" permissions
  validate_json_file "$CURSOR_PERMISSIONS_TEMPLATE" || die "permissions template invalid JSON"
  if $apply; then
    mkdir -p "$(dirname "$CURSOR_PERMISSIONS_TARGET")"
    backup_file "$CURSOR_PERMISSIONS_TARGET" cursor-permissions
    merge_cursor_permissions "$CURSOR_PERMISSIONS_TEMPLATE" "$CURSOR_PERMISSIONS_TARGET"
    validate_json_file "$CURSOR_PERMISSIONS_TARGET" || die "permissions JSON invalid after merge"
    permissions_json_unsafe "$CURSOR_PERMISSIONS_TARGET" || die "permissions JSON failed safety check after merge"
    printf '%-18s %s %s\n' "$label" written 1
  else
    local status
    status="$(diff_permissions_status "$CURSOR_PERMISSIONS_TEMPLATE" "$CURSOR_PERMISSIONS_TARGET")"
    printf '%-18s %s %s\n' "$label" planned "$status"
  fi
}

run_global_profile() {
  ensure_global_write_target "$CURSOR_AGENTS_TARGET" agents
  ensure_global_write_target "$CURSOR_SKILLS_TARGET" skills
  ensure_global_write_target "$CURSOR_MCP_TARGET" mcp
  ensure_global_write_target "$CURSOR_PERMISSIONS_TARGET" permissions

  if ! $quiet && ! $apply; then
    printf 'Global Cursor profile (dry-run)\n'
  elif ! $quiet && $apply; then
    printf 'Global Cursor profile apply\n'
  fi

  install_agents "$CURSOR_AGENTS_TARGET" "global-agents"
  install_global_skills
  apply_global_mcp
  apply_global_permissions
}

validate_global_profile_state() {
  "$AW_PYTHON" "$WORKSPACE_ROOT/scripts/check-cursor-profile.py" >/dev/null || die "cursor profile template validation failed"
  local agents skills mcp perms shell_ok=0
  agents="$(agents_diff_status "$CURSOR_AGENTS_TARGET")"
  skills="$(skills_diff_status "$CURSOR_SKILLS_TARGET")"
  mcp="$(mcp_diff_status)"
  perms="$(diff_permissions_status "$CURSOR_PERMISSIONS_TEMPLATE" "$CURSOR_PERMISSIONS_TARGET")"
  if [ -f "$CURSOR_PERMISSIONS_TARGET" ]; then
    permissions_json_unsafe "$CURSOR_PERMISSIONS_TARGET" || shell_ok=1
  fi
  if $quiet; then
    printf 'agents %s\nskills %s\nmcp %s\npermissions %s\n' "$agents" "$skills" "$mcp" "$perms"
  else
    printf 'Global profile validate:\n'
    printf '  agents: %s\n' "$agents"
    printf '  skills: %s\n' "$skills"
    printf '  mcp: %s\n' "$mcp"
    printf '  permissions: %s\n' "$perms"
    if [ "$shell_ok" -ne 0 ]; then
      printf '  shell: unsafe permissions detected\n'
    else
      printf '  shell: restricted (no broad terminalAllowlist in template)\n'
    fi
  fi
  if [ "$agents" = "synced" ] && [ "$skills" = "synced" ] && [ "$mcp" = "synced" ] && [ "$perms" = "synced" ] && [ "$shell_ok" -eq 0 ]; then
    return 0
  fi
  return 1
}

install_project_rules() {
  local project="$1"
  local dest_root="$project/.cursor/rules"
  local count=0 source name dest
  ensure_dest_root "$dest_root"
  [ -d "$RULES_SOURCE" ] || die "Cursor rules source not found: $RULES_SOURCE"
  for source in "$RULES_SOURCE"/*.md "$RULES_SOURCE"/*.mdc; do
    [ -f "$source" ] || continue
    name="$(basename "$source")"
    dest="$dest_root/$name"
    ensure_child "$dest_root" "$dest"
    count=$((count + 1))
    if $apply; then
      mkdir -p "$dest_root"
      backup_file "$dest" cursor-rules
      cp "$source" "$dest"
    fi
  done
  local verb
  if $apply; then verb=written; else verb=planned; fi
  if $quiet; then
    printf '%-15s %s %s\n' "project-rules" "$verb" "$count"
  else
    if $apply; then verb=Installed; else verb=Planned; fi
    printf '%s Cursor project rules: %s -> %s (%s files)\n' "$verb" "$RULES_SOURCE" "$dest_root" "$count"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --quiet) quiet=true ;;
    --help) usage; exit 0 ;;
    --diff-global-profile) diff_global_profile=true ;;
    --apply-global-profile) apply_global_profile=true; apply=true ;;
    --validate-global-profile) validate_global_profile=true ;;
    --user-rules) show_user_rules=true ;;
    --show-user-rules) show_user_rules=true ;;
    --copy-user-rules) copy_user_rules=true ;;
    --show-playwright-mcp) show_playwright_mcp=true ;;
    --copy-playwright-mcp) copy_playwright_mcp=true ;;
    --show-sandbox-profile)
      shift
      [ $# -gt 0 ] || die "--show-sandbox-profile requires a profile name"
      show_sandbox_profile="$1"
      ;;
    --copy-sandbox-profile)
      shift
      [ $# -gt 0 ] || die "--copy-sandbox-profile requires a profile name"
      copy_sandbox_profile="$1"
      ;;
    --open-cursor-settings) open_cursor_settings=true ;;
    --global-agents|--global-agents-only) global_agents=true ;;
    --project-agents) project_agents=true ;;
    --project-rules) project_rules=true ;;
    --project) project_agents=true; project_rules=true ;;
    --all) global_agents=true; project_agents=true; project_rules=true ;;
    --target)
      shift
      [ $# -gt 0 ] || die "--target requires a path"
      target="$1"
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if $validate_global_profile; then
  validate_global_profile_state
  exit $?
fi

if $show_user_rules; then
  [ -f "$USER_RULES_SOURCE" ] && cat "$USER_RULES_SOURCE" || die "user rules source not found: $USER_RULES_SOURCE"
  exit 0
fi

if $copy_user_rules; then
  command -v pbcopy >/dev/null 2>&1 || die "pbcopy not available. Copy the file manually."
  [ -f "$USER_RULES_SOURCE" ] || die "user rules source not found: $USER_RULES_SOURCE"
  pbcopy < "$USER_RULES_SOURCE"
  printf 'Cursor User Rules copied to clipboard.\nPaste into Cursor Settings > Rules > User Rules.\n'
  exit 0
fi

if $show_playwright_mcp; then
  [ -f "$CURSOR_MCP_TEMPLATE" ] || die "Playwright MCP template not found"
  cat "$CURSOR_MCP_TEMPLATE"
  exit 0
fi

if $copy_playwright_mcp; then
  command -v pbcopy >/dev/null 2>&1 || die "pbcopy not available"
  [ -f "$CURSOR_MCP_TEMPLATE" ] || die "Playwright MCP template not found"
  pbcopy < "$CURSOR_MCP_TEMPLATE"
  printf 'Playwright MCP template copied to clipboard (debug).\n'
  exit 0
fi

if [ -n "$show_sandbox_profile" ]; then
  profile_path="$(sandbox_profile_path "$show_sandbox_profile")"
  [ -f "$profile_path" ] || die "sandbox profile not found: $profile_path"
  cat "$profile_path"
  exit 0
fi

if [ -n "$copy_sandbox_profile" ]; then
  command -v pbcopy >/dev/null 2>&1 || die "pbcopy not available"
  profile_path="$(sandbox_profile_path "$copy_sandbox_profile")"
  [ -f "$profile_path" ] || die "sandbox profile not found: $profile_path"
  pbcopy < "$profile_path"
  printf 'Legacy sandbox profile copied to clipboard (debug).\n'
  exit 0
fi

if $open_cursor_settings; then
  if command -v open >/dev/null 2>&1; then
    open -a Cursor 2>/dev/null || open "cursor://settings/rules" 2>/dev/null || {
      printf 'Could not open Cursor Settings. Open Cursor manually.\n'
    }
  else
    die "open command not available"
  fi
  exit 0
fi

if $diff_global_profile || $apply_global_profile; then
  run_global_profile
  exit 0
fi

if ! $global_agents && ! $project_agents && ! $project_rules; then
  diff_global_profile=true
  run_global_profile
  exit 0
fi

project_target=""
if $project_agents || $project_rules; then
  project_target="$(validate_project_target "${target:-$caller_dir}")"
fi

if $global_agents; then
  install_agents "$CURSOR_AGENTS_TARGET" "global-agents"
fi
if $project_agents; then
  install_agents "$project_target/.cursor/agents" "project-agents"
fi
if $project_rules; then
  install_project_rules "$project_target"
fi
