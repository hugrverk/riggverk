export function confirmLeaveDirtyEditor(): boolean {
  return window.confirm("Leave with unsaved changes?");
}

export function dirtyTabClass(dirty: boolean): string {
  return dirty ? " tab-dirty" : "";
}

export function dirtyTabAriaLabel(dirty: boolean, name: string): string {
  return dirty ? `${name}, unsaved changes` : name;
}

export function dirtyTabSuffix(dirty: boolean): string {
  return dirty ? " *" : "";
}
