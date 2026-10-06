export function runtimeChipTone(status: string): "ok" | "warn" | "fail" | "muted" {
  switch (status) {
    case "synced": return "ok";
    case "diverged": return "warn";
    case "partial": return "warn";
    case "stale": return "warn";
    case "missing": return "fail";
    case "invalid": return "fail";
    case "unsafe": return "fail";
    default: return "muted";
  }
}

export function runtimeChipLabel(status: string): string {
  switch (status) {
    case "synced": return "Synced";
    case "diverged": return "Diverged";
    case "partial": return "Partial";
    case "stale": return "Stale";
    case "missing": return "Missing";
    case "invalid": return "Invalid";
    case "unsafe": return "Unsafe";
    default: return "Unknown";
  }
}
