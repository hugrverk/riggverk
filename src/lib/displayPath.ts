/** Strip Windows extended-length prefixes for user-facing display only. */
export function displayPath(path: string): string {
  const stripped = path.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  if (/^[a-zA-Z]:\\/.test(stripped) || /^[a-zA-Z]:\//.test(stripped)) {
    return stripped.replace(/\\/g, "/");
  }
  return stripped;
}
