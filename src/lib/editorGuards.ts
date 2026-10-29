export function dirtyTabAriaLabel(dirty: boolean, name: string): string {
  return dirty ? `${name}, unsaved changes` : name;
}
