import type { InstallAgent } from "../types";

const KNOWN_HARNESSES = new Set<InstallAgent>(["codex", "opencode", "claude", "cursor"]);

export function filterVisibleMetadataTargets(
  targets: string[],
  enabledHarnessIds: readonly InstallAgent[],
): string[] | null {
  const known = targets.filter((target): target is InstallAgent =>
    KNOWN_HARNESSES.has(target as InstallAgent)
  );
  if (known.length > 0 && !known.some(target => enabledHarnessIds.includes(target))) {
    return null;
  }
  return targets.filter(target =>
    !KNOWN_HARNESSES.has(target as InstallAgent)
    || enabledHarnessIds.includes(target as InstallAgent)
  );
}
