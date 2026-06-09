#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$WORKSPACE_ROOT/skills"

VALID_AGENTS="codex opencode claude cursor"

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
  --dry-run           Preview without writing files
  --list              List available skills
  --quiet             Print compact app-friendly output
  --help              Show this help
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
  local dir="$1"
  local child
  for child in "$dir"/*/; do
    [ -d "$child" ] || continue
    if [ -f "${child}SKILL.md" ]; then
      return 0
    fi
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
    local entry_name
    entry_name="$(basename "$entry")"
    local root_skill_md="$entry/SKILL.md"
    if [ -f "$root_skill_md" ]; then
      register_discovered_skill "$entry" "$root_skill_md" "$entry_name" "$entry_name"
      continue
    fi
    local sub
    for sub in "$entry"/*/; do
      [ -d "$sub" ] || continue
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
    return 1
  fi
}

agent_global_dest() {
  local agent="$1"
  case "$agent" in
    codex)    printf '%s' "${CODEX_SKILLS_PATH:-$HOME/.agents/skills}" ;;
    opencode) printf '%s' "${OPENCODE_SKILLS_PATH:-$HOME/.config/opencode/skills}" ;;
    claude)   printf '%s' "${CLAUDE_SKILLS_PATH:-$HOME/.claude/skills}" ;;
    cursor)   printf '%s' "${CURSOR_SKILLS_PATH:-$HOME/.cursor/skills}" ;;
  esac
}

agent_project_dest() {
  local agent="$1" target="$2"
  case "$agent" in
    codex)    printf '%s/.agents/skills' "$target" ;;
    opencode) printf '%s/.opencode/skills' "$target" ;;
    claude)   printf '%s/.claude/skills' "$target" ;;
    cursor)   printf '%s/.cursor/skills' "$target" ;;
  esac
}

validate_project_target() {
  local raw="$1"
  if [ ! -d "$raw" ]; then
    printf 'install-skills.sh: project target does not exist or is not a directory: %s\n' "$raw" >&2
    exit 1
  fi
  local target
  target="$(cd "$raw" && pwd)"
  local home="${HOME:?}"
  local tmp_root
  tmp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd || printf '%s' "${TMPDIR:-/tmp}")"
  local slash_tmp
  slash_tmp="$(cd /tmp 2>/dev/null && pwd || printf '%s' /tmp)"

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
  if ! discovered="$(discover_skills 2>/dev/null)"; then
    printf 'No skills installed in this workspace.\n'
    printf 'Add skills under the skills/ directory, then run again.\n'
    exit 0
  fi
  printf '%s\n' "$discovered" | while IFS="$(printf '\t')" read -r name dir desc; do
    printf '  %-32s %s\n' "$name" "$desc"
  done
  exit 0
fi

# --- discover skills ---
discovered="$(discover_skills)" || {
  printf 'install-skills.sh: no skills found in %s\n' "$SKILLS_DIR" >&2
  exit 1
}

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

# --- dry-run mode ---
if $dry_run; then
  if ! $quiet; then
    printf '\nSkills Install (dry-run)\n'
    printf '  Skills: %s\n' "${install_names[*]}"
    printf '  Agents: %s\n' "${selected_agents[*]}"
    if $scope_project; then
      printf '  Scope: project (%s)\n' "$project_target_resolved"
    else
      printf '  Scope: global\n'
    fi
    printf '\n'
  fi
  for agent in "${selected_agents[@]}"; do
    dest=
    if $scope_project; then
      dest="$(agent_project_dest "$agent" "$project_target_resolved")"
    else
      dest="$(agent_global_dest "$agent")"
    fi
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

# --- install mode ---
if ! $quiet; then
  printf '\nSkills Install\n'
  printf '  Skills: %s\n' "${install_names[*]}"
  printf '  Agents: %s\n' "${selected_agents[*]}"
  if $scope_project; then
    printf '  Scope: project (%s)\n' "$project_target_resolved"
  else
    printf '  Scope: global\n'
  fi
fi

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
    dir="${install_dirs[$i]}"
    src_dir="$SKILLS_DIR/$dir"
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
    if [ -d "$dest_dir" ]; then
      rm -rf "$dest_dir"
    fi
    cp -R "$src_dir" "$dest_dir"
    if [ $? -ne 0 ]; then
      if $quiet; then
        printf '  %-10s FAIL %s (src=%s dest=%s)\n' "${agent}:" "$name" "$src_dir" "$dest_dir"
      else
        printf '    FAIL %s (src=%s dest=%s)\n' "$name" "$src_dir" "$dest_dir"
      fi
      exit_code=1
    else
      if $quiet; then
        printf '  %-10s OK   %s\n' "${agent}:" "$name"
      else
        printf '    installed %s\n' "$name"
      fi
    fi
    i=$((i + 1))
  done
done

exit "$exit_code"
