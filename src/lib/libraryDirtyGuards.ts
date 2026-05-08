import type { LibrarySourceType } from "../views/LibraryView";

export function isLibrarySourceTypeDirty(
  sourceType: LibrarySourceType,
  docDirty: boolean,
  ruleDirty: boolean,
  agentDirty: boolean,
  configDirty: boolean,
): boolean {
  switch (sourceType) {
    case "docs": return docDirty;
    case "rules": return ruleDirty;
    case "agents": return agentDirty;
    case "configs": return configDirty;
    case "skills": return false;
  }
}

export function guardedSwitchSourceType(
  nextType: LibrarySourceType,
  currentType: LibrarySourceType,
  isCurrentDirty: boolean,
  onSetType: (t: LibrarySourceType) => void,
): boolean {
  if (nextType === currentType) return true; // no-op, not blocked
  if (isCurrentDirty && !window.confirm("Leave with unsaved changes?")) return false;
  onSetType(nextType);
  return true;
}
