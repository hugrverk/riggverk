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

/** Destinations shown in the sidebar; disabled harnesses are hidden and the destinations after them renumber. */
export function visibleViews(enabledHarnessIds: readonly InstallAgent[]): ViewDef[] {
  return VIEW_DEFS.filter(def => !def.harness || enabledHarnessIds.includes(def.harness));
}

/** Digit keys 1-9 switch views; a tenth item and any after it have no digit (`Mod+,` still opens Settings). */
export const MAX_NUMBERED_TABS = 9;
