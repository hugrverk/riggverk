import type { Tone } from "../ui/tone";
import type {
  FileConflictReason,
  FilesSurfaceId,
  FileUnit,
  InstallAgent,
  InstallationStatus,
  SetupSurfaceId,
} from "../types";
import { HARNESS_LABELS } from "./harnessInstallation";
import type { StateDisplay } from "./installationView";

/** The agents surface of each harness that has one. Copilot, Pi and Kilo have none. */
const AGENTS_SURFACE: Partial<Record<InstallAgent, FilesSurfaceId>> = {
  codex: "codex_agents",
  opencode: "open_code_agents",
  claude: "claude_agents",
  cursor: "cursor_agents",
};

const FILES_SURFACES: readonly SetupSurfaceId[] = ["skills", "claude_agents", "codex_agents", "open_code_agents", "cursor_agents"];

/** Whether `surface` holds skill or agent files the user can keep. */
export function isFilesSurface(surface: SetupSurfaceId): surface is FilesSurfaceId {
  return FILES_SURFACES.includes(surface);
}

/** The surfaces of `harness` that hold skill or agent files: the shared skills, and its agents when it has some. */
export function filesSurfacesOf(harness: InstallAgent): FilesSurfaceId[] {
  const agents = AGENTS_SURFACE[harness];
  return agents ? [agents, "skills"] : ["skills"];
}

/** The page whose keys act on `surface`: the harness of an agents surface, any harness page for skills. */
function pageOf(surface: FilesSurfaceId): string {
  const harness = (Object.keys(AGENTS_SURFACE) as InstallAgent[]).find(candidate => AGENTS_SURFACE[candidate] === surface);
  return harness ? `the ${HARNESS_LABELS[harness]} page` : "a harness page";
}

export const REASON_TEXT: Record<FileConflictReason, string> = {
  edited: "edited since Riggverk wrote it",
  unproven: "not written by Riggverk (no record)",
};

export interface FileConflictModel {
  surface: FilesSurfaceId;
  units: FileUnit[];
  /** Files that block the update. */
  conflicts: number;
  /** Files the user keeps. */
  kept: number;
  keptUpdates: number;
  /** Units beyond the ones listed. */
  more: number;
}

/** The files of `surface` under `status`, or null while there are no conflicting or kept files (or no such status). */
export function fileConflictModelFor(
  status: InstallationStatus | null | undefined,
  surface: SetupSurfaceId,
): FileConflictModel | null {
  if (!isFilesSurface(surface)) return null;
  const files = status?.surfaces.find(row => row.surface === surface)?.files;
  if (!files || files.units.length === 0) return null;
  return {
    surface,
    units: files.units,
    conflicts: files.conflicts,
    kept: files.kept,
    keptUpdates: files.kept_updates,
    more: files.more,
  };
}

/** The unit the keys act on: the marked one, or the first while the mark is on a unit that is gone. */
export function markedUnit(model: FileConflictModel | null, markedKey: string | null): FileUnit | null {
  if (!model) return null;
  return model.units.find(unit => unit.key === markedKey) ?? model.units[0] ?? null;
}

/** The unit after `markedKey`, wrapping around: what `c` marks. */
export function nextUnitKey(model: FileConflictModel, markedKey: string | null): string | null {
  const current = markedUnit(model, markedKey);
  if (!current || model.units.length < 2) return current?.key ?? null;
  const index = model.units.findIndex(unit => unit.key === current.key);
  return model.units[(index + 1) % model.units.length]!.key;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "SKILL.md", "SKILL.md +1 file": the files of a skill unit; an agent is its one file. */
export function unitFilesText(unit: FileUnit): string {
  if (unit.kind === "agent") return "";
  const total = unit.files.length + unit.more_files;
  const first = unit.files[0]?.rel ?? "";
  return total > 1 ? `${first} +${plural(total - 1, "file")}` : first;
}

/** One line per unit in the detail pane: what, where, and why or since when. */
export function unitLine(unit: FileUnit): { text: string; tone: Tone } {
  const state =
    unit.state === "conflict"
      ? REASON_TEXT[unit.reason]
      : ["you manage", unit.wanted ? (unit.bundle_changed ? "bundled update available" : "bundle unchanged") : "no bundled copy here"].join(" · ");
  const parts = [
    unit.name,
    unit.folder,
    unitFilesText(unit),
    state,
    ...(unit.state === "conflict" && !unit.wanted ? ["no longer bundled here"] : []),
    ...(unit.kind === "skill" && unit.read_by.length > 0 ? [`read by ${unit.read_by.join(", ")}`] : []),
  ].filter(Boolean);
  const tone: Tone = unit.state === "conflict" ? "fail" : unit.bundle_changed ? "warn" : "dim";
  return { text: parts.join(" · "), tone };
}

/** A surface row's label with the files the user has to look at: "update · 2 conflicts", "current · you manage 1". */
export function withFileConflicts(display: StateDisplay, model: FileConflictModel | null): StateDisplay {
  if (!model || (model.conflicts === 0 && model.kept === 0)) return display;
  // The words "conflict" and "you manage" are already the label of those states; the counts replace them.
  const replaced = (model.conflicts > 0 && display.label === "conflict") || (model.kept > 0 && display.label === "you manage");
  const parts = [
    ...(replaced ? [] : [display.label]),
    ...(model.conflicts > 0 ? [plural(model.conflicts, "conflict")] : []),
    ...(model.kept > 0 ? [`you manage ${model.kept}`] : []),
  ];
  const tone: Tone = model.conflicts > 0 ? "fail" : display.tone === "ok" ? "warn" : display.tone;
  return { glyph: model.conflicts > 0 ? "fail" : display.glyph === "ok" ? "partial" : display.glyph, tone, label: parts.join(" · ") };
}

/** Why an action cannot run now, or null. */
export interface FileGate {
  visible: boolean;
  reason: string | null;
}

export interface FileGates {
  /** `c`: mark the next unit. */
  next: FileGate;
  diff: FileGate;
  /** `m` on a unit in conflict: keep my version. */
  keep: FileGate;
  /** `m` on a unit the user keeps: hand it back. */
  manage: FileGate;
}

export interface FileGateContext {
  workspaceValid: boolean;
  /** Label of a workspace task in flight, or null. */
  busyLabel: string | null;
  /** A review (install, rules or this one) is open on the page: the actions wait for it to close. */
  blockedBy: string | null;
}

/** What `c`, `d` and `m` (and `:resolve ...`) may do for the marked unit right now. */
export function fileGates(model: FileConflictModel | null, unit: FileUnit | null, context: FileGateContext): FileGates {
  const hidden: FileGate = { visible: false, reason: null };
  if (!model || !unit || !context.workspaceValid) return { next: hidden, diff: hidden, keep: hidden, manage: hidden };
  const wait = context.blockedBy ?? (context.busyLabel ? `${context.busyLabel} is running` : null);
  const gate = (visible: boolean): FileGate => ({ visible, reason: visible ? wait : null });
  return {
    next: { visible: model.units.length > 1, reason: model.units.length > 1 ? context.blockedBy : null },
    diff: gate(true),
    keep: gate(unit.state === "conflict"),
    manage: gate(unit.state === "kept"),
  };
}

/** "2 in conflict", "you manage 1", "2 in conflict · you manage 1". */
export function filesCountsText(model: FileConflictModel): string {
  return [
    ...(model.conflicts > 0 ? [`${model.conflicts} in conflict`] : []),
    ...(model.kept > 0 ? [`you manage ${model.kept}`] : []),
  ].join(" · ");
}

/** What the workspace page tells about the skill and agent files it cannot act on: where the actions are. */
export function filesPageHint(model: FileConflictModel, pageLabel: string): string {
  const keys = model.units.some(unit => unit.state === "kept") && model.conflicts === 0 ? "d diff · m hand back" : "d diff · m keep mine";
  return `open the ${pageLabel} page: ${keys}`;
}

/** The pointer line in the install review's detail of a file in conflict. */
export function resolvePointer(surface: SetupSurfaceId): string | null {
  if (!isFilesSurface(surface)) return null;
  return `resolve from ${pageOf(surface)}: d diff · m keep mine`;
}
