#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$WORKSPACE_ROOT/skills"
ADAPTERS_DIR="$WORKSPACE_ROOT/templates/skills"
# shellcheck source=scripts/lib/platform-paths.sh
. "$WORKSPACE_ROOT/scripts/lib/platform-paths.sh"

VALID_AGENTS="codex opencode claude cursor"
# discover_skills status for "no skills found"; any other non-zero status is an
# error that discover_skills already reported on stderr.
DISCOVER_NONE=3

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-skills.sh [options]

Install workspace skills to agent tool skill folders.

Options:
  --agent <target>    Agent target: codex, opencode, claude, cursor
                      Repeatable. Default: opencode.
  --global            Install globally (system-wide)
  --project           Install into a project folder
  --target <path>     Project target directory (required with --project)
  --skill <name>      Install a single skill by name (repeatable)
  --all               Install all available skills
  --core              Install all skills (backward-compatible alias for --all)
  --dry-run           Preview without writing files (default)
  --apply             Write target files; an existing SKILL.md that differs is
                      backed up first (AGENT_WORKSPACE_BACKUP_DIR)
  --list              List available skills
  --quiet             Print compact app-friendly output
  --help              Show this help

Default mode is dry-run. Use --apply to write files.
USAGE
}

if [ ! -d "$SKILLS_DIR" ]; then
  if [ "${1:-}" = "--list" ]; then
    printf 'No skills installed in this workspace.\n'
    exit 0
  fi
  printf 'install-skills.sh: skills directory not found: %s\n' "$SKILLS_DIR" >&2
  exit 1
fi

extract_frontmatter() {
  local file="$1" key="$2"
  local prefix="${key}:"
  while IFS= read -r line; do
    case "$line" in
      ---*) ;;
      "${prefix} "*) printf '%s' "${line#"${prefix} "}"; return ;;
      "${prefix}"*)  printf '%s' "${line#"${prefix}"}"; return ;;
    esac
  done < "$file"
}

validate_skill_name() {
  local name="$1"
  local source="$2"
  if [ -z "$name" ]; then
    printf 'install-skills.sh: invalid skill name (empty) from %s\n' "$source" >&2
    return 1
  fi
  case "$name" in
    */*|*..*)
      printf 'install-skills.sh: skill name contains path traversal: "%s" from %s\n' "$name" "$source" >&2
      return 1
      ;;
  esac
  case "$name" in
    *[!a-z0-9-]*)
      printf 'install-skills.sh: invalid skill name: "%s" from %s\n' "$name" "$source" >&2
      printf 'install-skills.sh: skill names must start with a-z0-9 and contain only a-z0-9-\n' >&2
      return 1
      ;;
  esac
  case "${name:0:1}" in
    [a-z0-9]) ;;
    *)
      printf 'install-skills.sh: skill name must start with a-z0-9: "%s" from %s\n' "$name" "$source" >&2
      return 1
      ;;
  esac
}

ensure_contained() {
  local dest_root="$1"
  local name="$2"
  local dest_dir="${dest_root}/${name}"

  if [ ! -d "$dest_root" ]; then
    printf 'install-skills.sh: destination root does not exist: %s\n' "$dest_root" >&2
    return 1
  fi

  local real_root
  real_root="$(cd "$dest_root" && pwd -P 2>/dev/null)" || {
    printf 'install-skills.sh: cannot resolve destination root: %s\n' "$dest_root" >&2
    return 1
  }

  if [ -z "$real_root" ] || [ ! -d "$real_root" ]; then
    printf 'install-skills.sh: destination root not resolvable: %s\n' "$dest_root" >&2
    return 1
  fi

  local join_result="${real_root}/${name}"
  if [ -d "$join_result" ]; then
    join_result="$(cd "$join_result" && pwd -P 2>/dev/null)" || {
      printf 'install-skills.sh: cannot resolve destination: %s\n' "${real_root}/${name}" >&2
      return 1
    }
  fi

  case "$join_result" in
    ""|"/"|"$real_root")
      printf 'install-skills.sh: unsafe destination path: %s\n' "$join_result" >&2
      return 1
      ;;
    "$real_root"|"$real_root"/*) ;;
    *)
      printf 'install-skills.sh: destination outside root: %s\n' "$join_result" >&2
      return 1
      ;;
  esac
}

has_deeper_skill_md() {
  scan_deeper_skill_md "$1" 0
}

# Recursively scan for SKILL.md at depths deeper than one group level.
# Bounded to MAX_ENTRIES to prevent infinite recursion on deep trees.
scan_deeper_skill_md() {
  local dir="$1" depth="$2"
  [ "$depth" -gt 20 ] && return 0
  local count=0
  local child
  for child in "$dir"/*/; do
    [ -d "$child" ] || continue
    count=$((count + 1))
    [ "$count" -gt 10000 ] && return 0
    if [ -L "${child%/}" ]; then
      return 0
    fi
    if [ -f "${child}SKILL.md" ]; then
      return 0
    fi
    scan_deeper_skill_md "$child" $((depth + 1)) && return 0
  done
  return 1
}

register_discovered_skill() {
  local src_dir="$1"
  local skill_md="$2"
  local fallback_name="$3"
  local rel_dir="$4"
  local name
  name="$(extract_frontmatter "$skill_md" "name")"
  if [ -z "$name" ]; then
    name="$fallback_name"
  fi
  if ! validate_skill_name "$name" "$skill_md"; then
    exit 1
  fi
  local desc
  desc="$(extract_frontmatter "$skill_md" "description")"
  if printf '%s\n' "$names_seen" | grep -qxF "$name"; then
    printf 'install-skills.sh: duplicate skill name in repository: %s\n' "$name" >&2
    exit 1
  fi
  names_seen="${names_seen}${name}
"
  printf '%s\t%s\t%s\n' "$name" "$rel_dir" "$desc"
  found=$((found + 1))
}

discover_skills() {
  local found=0
  local names_seen=""
  for entry in "$SKILLS_DIR"/*/; do
    [ -d "$entry" ] || continue
    if [ -L "${entry%/}" ]; then
      printf 'install-skills.sh: symlinked skill directories are not supported: %s\n' "${entry%/}" >&2
      exit 1
    fi
    local entry_name
    entry_name="$(basename "$entry")"
    local root_skill_md="$entry/SKILL.md"
    if [ -f "$root_skill_md" ]; then
      if has_deeper_skill_md "$entry"; then
        printf 'install-skills.sh: skill nesting deeper than one group level is not supported: %s\n' "$entry" >&2
        exit 1
      fi
      register_discovered_skill "$entry" "$root_skill_md" "$entry_name" "$entry_name"
      continue
    fi
    local sub
    for sub in "$entry"/*/; do
      [ -d "$sub" ] || continue
      if [ -L "${sub%/}" ]; then
        printf 'install-skills.sh: symlinked skill directories are not supported: %s\n' "${sub%/}" >&2
        exit 1
      fi
      local sub_name
      sub_name="$(basename "$sub")"
      local grouped_skill_md="$sub/SKILL.md"
      if [ -f "$grouped_skill_md" ]; then
        register_discovered_skill "$sub" "$grouped_skill_md" "$sub_name" "${entry_name}/${sub_name}"
      elif has_deeper_skill_md "$sub"; then
        printf 'install-skills.sh: skill nesting deeper than one group level is not supported: %s\n' "$sub" >&2
        exit 1
      fi
    done
  done
  if [ "$found" -eq 0 ]; then
    return "$DISCOVER_NONE"
  fi
}

agent_global_dest() {
  local agent="$1"
  case "$agent" in
    codex)    printf '%s' "${CODEX_SKILLS_PATH:-${CODEX_HOME:-$HOME/.codex}/skills}" ;;
    opencode) printf '%s' "${OPENCODE_SKILLS_PATH:-$HOME/.config/opencode/skills}" ;;
    claude)   printf '%s' "${CLAUDE_SKILLS_PATH:-$HOME/.claude/skills}" ;;
    cursor)   printf '%s' "${CURSOR_SKILLS_PATH:-$HOME/.cursor/skills}" ;;
  esac
}

agent_project_dest() {
  local agent="$1" target="$2"
  case "$agent" in
    codex)    printf '%s/.codex/skills' "$target" ;;
    opencode) printf '%s/.opencode/skills' "$target" ;;
    claude)   printf '%s/.claude/skills' "$target" ;;
    cursor)   printf '%s/.cursor/skills' "$target" ;;
  esac
}

adapter_file_for_agent() {
  local agent="$1"
  local name="$2"
  local adapter="$ADAPTERS_DIR/$agent/$name/SKILL.md"
  if [ ! -f "$adapter" ]; then
    printf 'install-skills.sh: missing generated %s adapter for skill: %s\n' "$agent" "$name" >&2
    printf 'install-skills.sh: run scripts/generate-skill-adapters.py --write from the app repository\n' >&2
    return 1
  fi
  printf '%s' "$adapter"
}

validate_project_target() {
  local raw="$1"
  if [ ! -d "$raw" ]; then
    printf 'install-skills.sh: project target does not exist or is not a directory: %s\n' "$raw" >&2
    exit 1
  fi
  local target
  target="$(cd "$raw" && pwd -P)"
  # Resolve every comparison root the same way as the target (symlinked homes
  # and /tmp must still be recognised as broad).
  local home
  home="$(cd "${HOME:?}" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
  local tmp_root
  tmp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P || printf '%s' "${TMPDIR:-/tmp}")"
  local slash_tmp
  slash_tmp="$(cd /tmp 2>/dev/null && pwd -P || printf '%s' /tmp)"

  local broad
  for broad in "/" "/Users" "$home" "$home/Projects" "$tmp_root" "$slash_tmp"; do
    if [ "$target" = "$broad" ]; then
      printf 'install-skills.sh: refusing broad project target: %s\n' "$target" >&2
      exit 1
    fi
  done

  local has_marker=false
  for marker in .git package.json Cargo.toml composer.json pyproject.toml AGENTS.md .opencode .codex .cursor wp-content wordpress/wp-content; do
    if [ -e "$target/$marker" ]; then
      has_marker=true
      break
    fi
  done
  if ! $has_marker; then
    printf 'install-skills.sh: project target does not look like a project checkout: %s\n' "$target" >&2
    exit 1
  fi
  printf '%s' "$target"
}

# --- arg parsing ---

scope_global=false
scope_project=false
project_target=""
apply=false
dry_run=false
list_mode=false
quiet=false
all_skills=false
declare -a selected_skills=()
declare -a selected_agents=()
declare -a raw_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --list) list_mode=true ;;
    --quiet) quiet=true ;;
    --dry-run) dry_run=true ;;
    --apply) apply=true ;;
    --all|--core) all_skills=true ;;
    --global) scope_global=true ;;
    --project) scope_project=true ;;
    --target)
      shift
      if [ $# -eq 0 ]; then
        printf 'install-skills.sh: --target requires a path\n' >&2
        exit 1
      fi
      project_target="$1"
      ;;
    --agent)
      shift
      if [ $# -eq 0 ]; then
        printf 'install-skills.sh: --agent requires a target name\n' >&2
        exit 1
      fi
      case " $VALID_AGENTS " in
        *" $1 "*) ;;
        *)
          printf 'install-skills.sh: unknown agent: %s\n' "$1" >&2
          exit 1
          ;;
      esac
      selected_agents+=("$1")
      ;;
    --skill)
      shift
      if [ $# -eq 0 ]; then
        printf 'install-skills.sh: --skill requires a skill name\n' >&2
        exit 1
      fi
      if ! validate_skill_name "$1" "--skill arg"; then
        exit 1
      fi
      selected_skills+=("$1")
      ;;
    *)
      printf 'install-skills.sh: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# --- defaults ---
if [ ${#selected_agents[@]} -eq 0 ]; then
  selected_agents=(opencode)
fi

if $apply && $dry_run; then
  printf 'install-skills.sh: --apply and --dry-run are mutually exclusive\n' >&2
  exit 1
fi

if ! $scope_global && ! $scope_project; then
  scope_global=true
fi

if $scope_global && $scope_project; then
  printf 'install-skills.sh: only one of --global or --project may be specified\n' >&2
  exit 1
fi

if $scope_project && [ -z "$project_target" ]; then
  printf 'install-skills.sh: --project requires --target <path>\n' >&2
  exit 1
fi

if [ "${#selected_skills[@]}" -eq 0 ] && ! $all_skills; then
  all_skills=true
fi

# --- list mode ---
if $list_mode; then
  discover_rc=0
  discovered="$(discover_skills)" || discover_rc=$?
  if [ "$discover_rc" -eq "$DISCOVER_NONE" ]; then
    printf 'No skills installed in this workspace.\n'
    printf 'Add skills under the skills/ directory, then run again.\n'
    exit 0
  elif [ "$discover_rc" -ne 0 ]; then
    exit "$discover_rc"
  fi
  printf '%s\n' "$discovered" | while IFS="$(printf '\t')" read -r name dir desc; do
    printf '  %-32s %s\n' "$name" "$desc"
  done
  exit 0
fi

# --- discover skills ---
discover_rc=0
discovered="$(discover_skills)" || discover_rc=$?
if [ "$discover_rc" -eq "$DISCOVER_NONE" ]; then
  printf 'install-skills.sh: no skills found in %s\n' "$SKILLS_DIR" >&2
  exit 1
elif [ "$discover_rc" -ne 0 ]; then
  exit "$discover_rc"
fi

# build parallel arrays: name->dir
declare -a skill_names=()
declare -a skill_dirs=()
while IFS="$(printf '\t')" read -r name dir desc; do
  skill_names+=("$name")
  skill_dirs+=("$dir")
done <<< "$discovered"

skill_dir_for_name() {
  local want="$1"
  local i=0
  while [ $i -lt "${#skill_names[@]}" ]; do
    if [ "${skill_names[$i]}" = "$want" ]; then
      printf '%s' "${skill_dirs[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# --- resolve which skills to install ---
declare -a install_names=()
declare -a install_dirs=()
if $all_skills; then
  install_names=("${skill_names[@]}")
  install_dirs=("${skill_dirs[@]}")
else
  for s in "${selected_skills[@]}"; do
    d="$(skill_dir_for_name "$s")" || {
      printf 'install-skills.sh: unknown skill: %s\n' "$s" >&2
      exit 1
    }
    install_names+=("$s")
    install_dirs+=("$d")
  done
fi

if [ ${#install_names[@]} -eq 0 ]; then
  printf 'install-skills.sh: no skills to install\n' >&2
  exit 1
fi

# --- resolve project target ---
project_target_resolved=""
if $scope_project; then
  project_target_resolved="$(validate_project_target "$project_target")"
fi

# --- dry-run mode (default) ---
if ! $apply; then
  if ! $quiet; then
    printf '\nSkills Install (dry-run)\n'
    printf '  Skills: %s\n' "${install_names[*]}"
    printf '  Agents: %s\n' "${selected_agents[*]}"
    if $scope_project; then
      printf '  Scope: project (%s)\n' "$project_target_resolved"
    else
      printf '  Scope: global\n'
    fi
    printf '  Use --apply to write files.\n'
    printf '\n'
  fi
  for agent in "${selected_agents[@]}"; do
    dest=
    if $scope_project; then
      dest="$(agent_project_dest "$agent" "$project_target_resolved")"
    else
      dest="$(agent_global_dest "$agent")"
    fi
    for name in "${install_names[@]}"; do
      adapter_file_for_agent "$agent" "$name" >/dev/null
    done
    if $quiet; then
      printf '%-10s %s\n' "${agent}:" "${install_names[*]}"
    else
      printf '  %s -> %s/\n' "$agent" "$dest"
      for name in "${install_names[@]}"; do
        printf '    %s\n' "$name"
      done
    fi
  done
  exit 0
fi

# --- install mode (--apply) ---
BACKUP_ROOT="$(agent_workspace_backup_root)" || exit 1
agent_workspace_refuse_broad_backup_root "$BACKUP_ROOT" "install-skills.sh" || exit 1
backup_ts="$(date -u +%Y%m%d-%H%M%S)"

if ! $quiet; then
  printf '\nSkills Install\n'
  printf '  Skills: %s\n' "${install_names[*]}"
  printf '  Agents: %s\n' "${selected_agents[*]}"
  if $scope_project; then
    printf '  Scope: project (%s)\n' "$project_target_resolved"
  else
    printf '  Scope: global\n'
  fi
  printf '  Backups: %s\n' "$BACKUP_ROOT"
fi

# Copy one adapter to <dest_dir>/SKILL.md. An existing SKILL.md that differs is
# backed up and the backup verified before it is overwritten. Sets install_state
# to "unchanged", "installed" or "updated" on success.
install_skill_file() {
  local src_file="$1" dest_dir="$2" agent="$3" name="$4"
  local dest_file="$dest_dir/SKILL.md" backup_dir
  install_state=installed
  mkdir -p "$dest_dir" || return 1
  if [ -f "$dest_file" ]; then
    if cmp -s "$src_file" "$dest_file"; then
      install_state=unchanged
      return 0
    fi
    backup_dir="$BACKUP_ROOT/$backup_ts/${agent}-skills/$name"
    if ! mkdir -p "$backup_dir" || ! cp "$dest_file" "$backup_dir/SKILL.md" || ! cmp -s "$dest_file" "$backup_dir/SKILL.md"; then
      printf 'install-skills.sh: backup of %s to %s failed; skill left unchanged\n' "$dest_file" "$backup_dir" >&2
      return 1
    fi
    install_state=updated
  fi
  cp "$src_file" "$dest_file"
}

exit_code=0

for agent in "${selected_agents[@]}"; do
  if ! $quiet; then
    printf '\n  %s\n' "$agent"
  fi
  dest_root=
  if $scope_project; then
    dest_root="$(agent_project_dest "$agent" "$project_target_resolved")"
  else
    dest_root="$(agent_global_dest "$agent")"
  fi

  mkdir -p "$dest_root"

  i=0
  while [ $i -lt "${#install_names[@]}" ]; do
    name="${install_names[$i]}"
    src_file="$(adapter_file_for_agent "$agent" "$name")" || {
      if $quiet; then
        printf '  %-10s FAIL %s (missing adapter)\n' "${agent}:" "$name"
      else
        printf '    FAIL %s (missing adapter)\n' "$name"
      fi
      exit_code=1
      i=$((i + 1))
      continue
    }
    dest_dir="$dest_root/$name"
    if ! ensure_contained "$dest_root" "$name"; then
      if $quiet; then
        printf '  %-10s FAIL %s (containment check failed)\n' "${agent}:" "$name"
      else
        printf '    FAIL %s (containment check failed)\n' "$name"
      fi
      exit_code=1
      i=$((i + 1))
      continue
    fi
    if install_skill_file "$src_file" "$dest_dir" "$agent" "$name"; then
      if $quiet; then
        printf '  %-10s OK   %s\n' "${agent}:" "$name"
      else
        case "$install_state" in
          unchanged) printf '    unchanged %s\n' "$name" ;;
          updated)   printf '    updated %s (previous SKILL.md backed up)\n' "$name" ;;
          *)         printf '    installed %s\n' "$name" ;;
        esac
      fi
    else
      if $quiet; then
        printf '  %-10s FAIL %s (src=%s dest=%s)\n' "${agent}:" "$name" "$src_file" "$dest_dir/SKILL.md"
      else
        printf '    FAIL %s (src=%s dest=%s)\n' "$name" "$src_file" "$dest_dir/SKILL.md"
      fi
      exit_code=1
    fi
    i=$((i + 1))
  done
done

exit "$exit_code"
