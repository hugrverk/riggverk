import type { CursorProfileHealth } from "../types";

export const CURSOR_STALE_RESOURCES_MESSAGE =
  "Installed Cursor scripts/templates are behind the app. Repair workspace resources, then apply the global profile.";

export function isCursorWorkspaceResourcesStale(
  health: CursorProfileHealth | null | undefined,
): boolean {
  const status = health?.workspace_resources_status;
  return status === "stale" || status === "missing";
}

export function repairWorkspaceBlockedTitle(action: string): string {
  return `${action} is blocked until workspace Cursor scripts/templates are current. Use repair workspace on this page.`;
}
