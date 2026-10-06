export const INVALID_WORKSPACE_TEXT = "invalid workspace path";
export const NO_WORKSPACE_TEXT = "no workspace selected";

export function isInvalidWorkspaceError(e: unknown): boolean {
  const message = String(e).toLowerCase();
  return message.includes(INVALID_WORKSPACE_TEXT) || message.includes(NO_WORKSPACE_TEXT);
}

/** Why a workspace switch is refused while a workspace task (apply, uninstall, rollback, ...) runs. */
export function workspaceTaskBlockedMessage(label: string): string {
  return `${label} is running; wait for it to finish before switching workspace`;
}
