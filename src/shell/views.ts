import { HARNESS_LABELS, HARNESS_NAV_ORDER } from "../lib/harnessInstallation";
import type { InstallAgent } from "../types";

export type AppView =
  | "start"
  | "codex"
  | "opencode"
  | "cursor"
  | "claude"
  | "copilot"
  | "pi"
  | "kilo"
  | "library"
  | "settings";

export interface ViewDef {
  id: AppView;
  /** Accessible name of the tab. */
  label: string;
  /** Tab text. */
  tab: string;
  /** Tab text below the width breakpoint. */
  short: string;
  /** Canonical command name (`:codex`). Stable regardless of tab numbering. */
  command: string;
  aliases: readonly string[];
  /** Set for harness pages, which are hidden when the harness is disabled in Settings. */
  harness?: InstallAgent;
}

const HARNESS_SHORT: Record<InstallAgent, string> = {
  codex: "cdx",
  opencode: "oc",
  cursor: "cur",
  claude: "cl",
  copilot: "cop",
  pi: "pi",
  kilo: "kilo",
};

/** Tab order: workspace, harnesses, library, settings. */
export const VIEW_DEFS: readonly ViewDef[] = [
  { id: "start", label: "Workspace", tab: "workspace", short: "ws", command: "workspace", aliases: ["start", "ws"] },
  ...HARNESS_NAV_ORDER.map((harness): ViewDef => ({
    id: harness,
    label: HARNESS_LABELS[harness],
    tab: harness,
    short: HARNESS_SHORT[harness],
    command: harness,
    aliases: [],
    harness,
  })),
  { id: "library", label: "Library", tab: "library", short: "lib", command: "library", aliases: ["lib"] },
  { id: "settings", label: "Settings", tab: "settings", short: "set", command: "settings", aliases: [] },
];

export function viewDef(view: AppView): ViewDef {
  return VIEW_DEFS.find(def => def.id === view) ?? VIEW_DEFS[0]!;
}

/** Destinations shown as tabs; disabled harnesses are hidden and the remaining tabs renumber. */
export function visibleViews(enabledHarnessIds: readonly InstallAgent[]): ViewDef[] {
  return VIEW_DEFS.filter(def => !def.harness || enabledHarnessIds.includes(def.harness));
}
