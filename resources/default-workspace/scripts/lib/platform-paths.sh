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
