export function SectionChip({ label, tone }: { label: string; tone: "ok" | "warn" | "fail" | "muted" }) {
  return <span className={`ws-section-chip ws-section-chip-${tone}`}>{label}</span>;
}

export function runtimeChipTone(status: string): "ok" | "warn" | "fail" | "muted" {
  switch (status) {
    case "synced": return "ok";
    case "diverged": return "warn";
    case "partial": return "warn";
    case "missing": return "fail";
    case "invalid": return "fail";
    default: return "muted";
  }
}

export function runtimeChipLabel(status: string): string {
  switch (status) {
    case "synced": return "Synced";
    case "diverged": return "Diverged";
    case "partial": return "Partial";
    case "missing": return "Missing";
    case "invalid": return "Invalid";
    default: return "Unknown";
  }
}
