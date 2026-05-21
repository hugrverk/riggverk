import type { StatusData } from "../types";

export function syncTextClass(s: string): string {
  switch (s) { case "synced": return "sync-text sync-text-ok"; case "diverged": return "sync-text sync-text-warn"; case "missing": return "sync-text sync-text-fail"; default: return "sync-text"; }
}

export function targetDotClass(s: string): string {
  switch (s) { case "synced": return "target-dot target-dot-ok"; case "diverged": return "target-dot target-dot-warn"; case "missing": return "target-dot target-dot-fail"; default: return "target-dot"; }
}

export function ruleSyncCount(s: StatusData, enabled: Set<string>): { synced: number; total: number } {
  const items = [
    { id: "codex_rules", val: s.rules_codex },
    { id: "opencode_rules", val: s.rules_opencode },
    { id: "auggie_rules", val: s.rules_auggie },
    { id: "claude_rules", val: s.rules_claude },
  ].filter(a => enabled.has(a.id));
  return { synced: items.filter(a => a.val === "synced").length, total: items.length };
}
