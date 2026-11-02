export function framePlatform(tauri: boolean, userAgent: string): "macos" | "native" {
  return !tauri || /Macintosh|Mac OS X/i.test(userAgent) ? "macos" : "native";
}
