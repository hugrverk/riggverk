/** Client-side hint for Cursor profile/config root (backend validates on save). */
export function cursorProfilePathValidationError(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.endsWith("/bin/cursor")
    || (normalized.endsWith("/bin") && normalized.includes("/programs/cursor/"))
    || (normalized.endsWith("/cursor") && normalized.includes("/bin/"))
  ) {
    return "This looks like the Cursor CLI/program path, not the Cursor profile/config directory.";
  }

  if (!trimmed.startsWith("~/") && !trimmed.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return "Cursor profile path must be absolute or start with ~/.";
  }

  return null;
}
