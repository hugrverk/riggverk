# Shared platform path helpers for Agent Workspace installer scripts.

agent_workspace_require_home() {
  if [ -z "${HOME+x}" ] || [ -z "$HOME" ]; then
    printf 'platform-paths.sh: HOME is required to resolve Agent Workspace paths\n' >&2
    return 1
  fi
  printf '%s' "$HOME"
}

agent_workspace_backup_root() {
  if [ "${AGENT_WORKSPACE_BACKUP_DIR+x}" = "x" ]; then
    if [ -z "$AGENT_WORKSPACE_BACKUP_DIR" ]; then
      printf 'platform-paths.sh: AGENT_WORKSPACE_BACKUP_DIR is set but empty\n' >&2
      return 1
    fi
    printf '%s' "$AGENT_WORKSPACE_BACKUP_DIR"
    return 0
  fi

  local platform
  platform="$(uname -s 2>/dev/null || true)"
  case "$platform" in
    Darwin)
      local home
      home="$(agent_workspace_require_home)" || return 1
      printf '%s/Library/Application Support/ai.agentworkspace.app/backups' "$home"
      ;;
    Linux)
      if [ -n "${XDG_CONFIG_HOME:-}" ]; then
        printf '%s/ai.agentworkspace.app/backups' "$XDG_CONFIG_HOME"
      else
        local home
        home="$(agent_workspace_require_home)" || return 1
        printf '%s/.config/ai.agentworkspace.app/backups' "$home"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      printf 'platform-paths.sh: Git Bash/MSYS (%s) is not supported by the Agent Workspace CLI scripts; use the Agent Workspace app, or set AGENT_WORKSPACE_BACKUP_DIR to a backup directory\n' "$platform" >&2
      return 1
      ;;
    *)
      printf 'platform-paths.sh: unsupported platform for Agent Workspace backup root: %s\n' "${platform:-unknown}" >&2
      return 1
      ;;
  esac
}

agent_workspace_refuse_broad_backup_root() {
  local root="$1"
  local label="${2:-platform-paths.sh}"
  local home="${HOME-}"

  if [ -z "$root" ]; then
    printf '%s: refusing broad backup root: %s\n' "$label" "$root" >&2
    return 1
  fi

  if [ "$root" = "/" ]; then
    printf '%s: refusing broad backup root: %s\n' "$label" "$root" >&2
    return 1
  fi

  if [ -n "$home" ] && { [ "$root" = "$home" ] || [ "$root" = "$home/" ]; }; then
    printf '%s: refusing broad backup root: %s\n' "$label" "$root" >&2
    return 1
  fi
}

# Lexically collapse repeated slashes, "." and ".." in an absolute path without
# touching the filesystem. Relative paths are returned unchanged.
agent_workspace_normalize_path() {
  local path="$1" rest part out=""
  case "$path" in
    /*) ;;
    *) printf '%s' "$path"; return 0 ;;
  esac
  rest="${path#/}"
  while [ -n "$rest" ]; do
    case "$rest" in
      */*) part="${rest%%/*}"; rest="${rest#*/}" ;;
      *) part="$rest"; rest="" ;;
    esac
    case "$part" in
      ""|.) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$part" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

# Refuse agent target directories that are a home or config root instead of a
# dedicated agents folder. Compares after lexical normalisation, so "$HOME//"
# and "$HOME/." are caught as well.
# Usage: agent_workspace_refuse_unsafe_agents_dir <dir> <description> <script-label>
agent_workspace_refuse_unsafe_agents_dir() {
  local dir="$1" description="$2" label="${3:-platform-paths.sh}"
  if [ -z "$dir" ]; then
    printf '%s: refusing empty %s\n' "$label" "$description" >&2
    return 1
  fi
  local norm home denied
  norm="$(agent_workspace_normalize_path "$dir")"
  home="$(agent_workspace_normalize_path "${HOME-}")"
  for denied in "/" "$home" "$home/.config" "$home/.config/opencode" "$home/.claude" "$home/.codex" "$home/.cursor"; do
    if [ "$norm" = "$denied" ]; then
      printf '%s: refusing unsafe %s: %s\n' "$label" "$description" "$dir" >&2
      return 1
    fi
  done
}
