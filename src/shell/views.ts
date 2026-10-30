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
  | "grok"
  | "history"
  | "library"
  | "settings";

export interface ViewDef {
  id: AppView;
  /** Sidebar text and accessible name. */
  label: string;
  /** Canonical command name (`:codex`). Stable regardless of sidebar numbering. */
  command: string;
  aliases: readonly string[];
  /** Set for harness pages, which are hidden when the harness is disabled in Settings. */
  harness?: InstallAgent;
}

/** Sidebar order: overview, agents, history, library, settings. The id of Overview stays `start` (landing view, commands). */
export const VIEW_DEFS: readonly ViewDef[] = [
  { id: "start", label: "Overview", command: "workspace", aliases: ["overview", "start", "ws"] },
  ...HARNESS_NAV_ORDER.map((harness): ViewDef => ({
    id: harness,
    label: HARNESS_LABELS[harness],
    command: harness,
    aliases: [],
    harness,
  })),
  { id: "history", label: "History", command: "history", aliases: [] },
  { id: "library", label: "Library", command: "library", aliases: ["lib"] },
  { id: "settings", label: "Settings", command: "settings", aliases: [] },
];

export function viewDef(view: AppView): ViewDef {
  return VIEW_DEFS.find(def => def.id === view) ?? VIEW_DEFS[0]!;
}

/** Destinations shown in the sidebar; disabled harnesses are hidden. */
export function visibleViews(enabledHarnessIds: readonly InstallAgent[]): ViewDef[] {
  return VIEW_DEFS.filter(def => !def.harness || enabledHarnessIds.includes(def.harness));
}

/**
 * The digit key of each destination. The digits are fixed, not positional: they do not move when an agent is turned
 * off or on, and the most-used destinations always have one. Overview is 1, the four central agents 2-5, then
 * History 6, Library 7 and Settings 8. The optional agents (Copilot, Pi, Kilo, Grok) have none: they open from the sidebar
 * or with `:copilot`, `:pi`, `:kilo`, `:grok`. The digit of an agent that is turned off does nothing. `Mod+,` also opens Settings.
 */
export const VIEW_DIGITS: Readonly<Partial<Record<AppView, string>>> = {
  start: "1",
  codex: "2",
  opencode: "3",
  cursor: "4",
  claude: "5",
  history: "6",
  library: "7",
  settings: "8",
};
