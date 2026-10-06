/**
 * Message shown by the themed confirm modal when leaving a dirty editor.
 * Import and pass to `confirm(message)` from `useConfirm()`.
 */
export const LEAVE_DIRTY_MESSAGE = "Leave with unsaved changes?";

export function dirtyTabAriaLabel(dirty: boolean, name: string): string {
  return dirty ? `${name}, unsaved changes` : name;
}
