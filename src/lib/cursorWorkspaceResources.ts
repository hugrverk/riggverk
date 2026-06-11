import type { CursorProfileHealth } from "../types";

export const CURSOR_STALE_RESOURCES_MESSAGE =
  "Installed Cursor resources are behind the app. Run Install or Update.";

export function isCursorWorkspaceResourcesStale(
  health: CursorProfileHealth | null | undefined,
): boolean {
  const status = health?.workspace_resources_status;
  return status === "stale" || status === "missing";
}

export function repairWorkspaceBlockedTitle(action: string): string {
  return `${action} is blocked until workspace Cursor resources are current. Run Install or Update on this page.`;
}
