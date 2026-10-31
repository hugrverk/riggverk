import { INSTALL_AGENTS, type InstallAgent } from "../types";

const KNOWN_HARNESSES = new Set<InstallAgent>(INSTALL_AGENTS);

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
