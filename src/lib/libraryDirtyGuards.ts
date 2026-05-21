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
    case "brain": return false;
  }
}
