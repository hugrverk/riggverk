import type { OverviewId } from "../hooks/useInstallationOverview";
import type { PostureLevel, SetupSurfaceId } from "../types";
import type { Tone } from "../ui/tone";
import { keyNames, type CodexConfigModel } from "./codexConfig";
import type { FileConflictModel } from "./fileConflicts";
import type { SurfaceDisplayState } from "./installationView";
import { CONFLICT_TEXT, type RulesModel } from "./rulesView";

/**
 * The six states the pages show. Runtime health and security posture are never a state: a runtime divergence that only
 * repeats a conflict is a sub-line (`runtimeSubline`), and posture is a separate mark (`postureMark`).
 */
export type UiState = "ok" | "ready" | "decide" | "yours" | "fix" | "off";

/** Precedence for aggregation (most urgent first). */
export const UI_STATE_PRECEDENCE: readonly UiState[] = ["decide", "fix", "ready", "yours", "ok", "off"];

/** Summary-row order. */
export const UI_STATE_SUMMARY_ORDER: readonly UiState[] = ["ok", "ready", "decide", "yours", "fix", "off"];

export const UI_STATE_LABEL: Record<UiState, string> = {
  ok: "Up to date",
  ready: "Update ready",
  decide: "Needs your decision",
  yours: "Yours",
  fix: "Fix by hand",
  off: "Not managed",
};

/** The label of `ready` while every counted item waits only for its first install: the label, not another state. */
export const READY_TO_INSTALL_LABEL = "Ready to install";

export interface UiItem {
  key: string;
  owner: OverviewId;
  surface: SetupSurfaceId;
  /** Null while the item is not counted (loading, failed to check, needs the workspace folder). */
  state: UiState | null;
  subline: string | null;
}

export interface SurfaceUiStateInput {
  /** `installationView.surfaceRowsFor(...).state`. */
  display: SurfaceDisplayState;
  /** The surface the row is for; picks the "off" wording of `claude_config`. */
  surface?: SetupSurfaceId;
  /** Backend detail of the surface row ("2 to update", the conflict text). */
  detail?: string;
  /** `rulesView.rulesModelFor`. */
  rules?: RulesModel | null;
  /** `fileConflicts.fileConflictModelFor`. */
  files?: FileConflictModel | null;
  /** `codexConfig.codexConfigModelFor` (`codex_config` surface only). */
  codexConfig?: CodexConfigModel | null;
  /**
   * An update was applied to another key of the Codex config while the kept keys stayed: the surface reads as up to
   * date with a "You keep ..." sub-line instead of "Yours". The status alone cannot tell, so the caller says so.
   */
  codexOtherKeysUpdated?: boolean;
  /** False while the workspace folder is unusable. Default true. */
  dataFolderOk?: boolean;
  /** The item is the workspace item (`workspace_bundle`), not a harness surface. Default false. */
  workspaceItem?: boolean;
  /** `workspaceDiagnostics.error`; the sub-line of an unusable folder on the workspace item. */
  workspaceError?: string | null;
  /** The entry's fetch failure (`OverviewEntry.error`). */
  entryError?: string | null;
}

export interface SurfaceUiState {
  state: UiState | null;
  subline: string | null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function result(state: UiState | null, subline: string | null): SurfaceUiState {
  return { state, subline };
}

const OFF_SUBLINE = "Not managed. Turn on to let Riggverk manage it.";
const OFF_SUBLINE_BY_SURFACE: Partial<Record<SetupSurfaceId, string>> = {
  claude_config: "Not managed. Claude Code keeps its default commit and PR attribution.",
};

function keepsText(config: CodexConfigModel): string {
  return `You keep ${keyNames(config.kept)}`;
}

function filesYoursSubline(files: FileConflictModel): string {
  const kept = plural(files.kept, "file");
  return files.keptUpdates > 0 ? `You manage ${kept}; ${plural(files.keptUpdates, "update")} waiting` : `You manage ${kept}`;
}

/**
 * The state and sub-line of one surface. First matching row wins:
 * unusable folder, unknown/failed, files in conflict, rules conflict, Codex keys that differ, malformed or blocked rules,
 * any other conflict, update or not installed, kept files or keys, current, off, unavailable.
 */
export function surfaceUiState(input: SurfaceUiStateInput): SurfaceUiState {
  const { display, rules, files, codexConfig } = input;

  if (input.dataFolderOk === false) {
    return input.workspaceItem
      ? result("fix", input.workspaceError || "Riggverk can't use its workspace folder")
      : result(null, "Needs the workspace folder");
  }
  // A failed fetch leaves the entry without a status, so its rows read `unknown`: the failure is the more specific row.
  if (input.entryError) return result(null, "Couldn't check. Try Check again.");
  if (display === "unknown") return result(null, "Checking…");

  if (files && files.conflicts > 0) return result("decide", `${plural(files.conflicts, "file")} you edited`);
  if (rules?.kind === "conflict") {
    return result(
      "decide",
      rules.reason === CONFLICT_TEXT.base_block_edited ? "You edited the managed block" : "Your file differs from every shipped version",
    );
  }
  if (codexConfig && codexConfig.differing.length > 0) {
    const many = codexConfig.differing.length > 1;
    return result("decide", `${keyNames(codexConfig.differing)} ${many ? "differ" : "differs"} from Riggverk's value`);
  }

  if (rules?.kind === "malformed" || rules?.kind === "blocked") return result("fix", rules.reason ?? rules.headline);
  if (display === "conflict") return result("fix", input.detail || "Conflict");

  if (display === "update_available" || display === "not_installed" || rules?.kind === "update" || rules?.kind === "absent") {
    const notInstalled = display === "not_installed" || rules?.kind === "absent";
    return result("ready", notInstalled ? "Not installed yet" : input.detail || "Update available");
  }

  if (rules?.kind === "managed") return result("yours", "You manage this file; base updates are waiting");
  if (display === "user_managed" || (display === "current" && files && files.kept > 0)) {
    return result("yours", files && files.kept > 0 ? filesYoursSubline(files) : "You manage this file");
  }
  if (display === "current" && codexConfig && codexConfig.kept.length > 0 && !input.codexOtherKeysUpdated) {
    return result("yours", keepsText(codexConfig));
  }

  if (display === "current") {
    return result("ok", codexConfig && codexConfig.kept.length > 0 ? keepsText(codexConfig) : null);
  }
  if (display === "off") return result("off", (input.surface && OFF_SUBLINE_BY_SURFACE[input.surface]) || OFF_SUBLINE);
  return result("off", "Unavailable on this system");
}

/** The most urgent state by `UI_STATE_PRECEDENCE`; null when every state is null (or there are none). */
export function aggregateState(states: readonly (UiState | null)[]): UiState | null {
  return UI_STATE_PRECEDENCE.find(candidate => states.includes(candidate)) ?? null;
}

/** The pill of one harness: its aggregate state and text. Null when none of its items is counted. */
export function harnessBadge(
  items: readonly UiItem[],
  { installing = false }: { installing?: boolean } = {},
): { state: UiState; text: string } | null {
  const state = aggregateState(items.map(item => item.state));
  if (!state) return null;
  const count = items.filter(item => item.state === state).length;
  switch (state) {
    case "decide":
      return { state, text: `${count} to decide` };
    case "fix":
      return { state, text: `${count} to fix` };
    case "ready":
      return { state, text: installing ? READY_TO_INSTALL_LABEL : UI_STATE_LABEL.ready };
    case "yours":
      return { state, text: "Yours" };
    case "ok":
      return { state, text: "Up to date" };
    case "off":
      return { state, text: "Not managed" };
  }
}

/**
 * Count per state. Every `SetupSurfaceId` counts once (the `skills` surface is shared by every harness); when entries
 * disagree about one surface the most urgent state wins. Items without a state are not counted.
 */
export function tally(items: readonly UiItem[]): Record<UiState, number> {
  const bySurface = new Map<SetupSurfaceId, UiState>();
  for (const item of items) {
    if (!item.state) continue;
    const seen = bySurface.get(item.surface);
    if (!seen || UI_STATE_PRECEDENCE.indexOf(item.state) < UI_STATE_PRECEDENCE.indexOf(seen)) bySurface.set(item.surface, item.state);
  }
  const counts: Record<UiState, number> = { ok: 0, ready: 0, decide: 0, yours: 0, fix: 0, off: 0 };
  for (const state of bySurface.values()) counts[state] += 1;
  return counts;
}

function summaryText(state: UiState, count: number, installing: boolean): string {
  const one = count === 1;
  switch (state) {
    case "ok":
      return `${count} up to date`;
    case "ready":
      return installing ? `${count} ready to install` : `${count} ${one ? "update" : "updates"} ready`;
    case "decide":
      return `${count} ${one ? "needs" : "need"} your decision`;
    case "yours":
      return `${count} yours`;
    case "fix":
      return `${count} to fix by hand`;
    case "off":
      return `${count} not managed`;
  }
}

/**
 * The summary row: non-zero states in `UI_STATE_SUMMARY_ORDER`. `installing` says the `ready` items wait only for
 * their first install, so they read "ready to install" instead of "updates ready".
 */
export function summaryParts(
  t: Record<UiState, number>,
  { installing = false }: { installing?: boolean } = {},
): Array<{ state: UiState; count: number; text: string }> {
  return UI_STATE_SUMMARY_ORDER.filter(state => t[state] > 0).map(state => ({
    state,
    count: t[state],
    text: summaryText(state, t[state], installing),
  }));
}

export interface OverviewHeadlineContext {
  dataFolderOk: boolean;
  /** Any entry has a status yet. */
  anyStatus: boolean;
  /** Every counted item is `ready` because it is not installed yet. */
  allNotInstalled: boolean;
  /** Entries whose status could not be fetched. They are not counted, so the all-clear must not be claimed. */
  failedChecks?: number;
  /** Entries still waiting for their first status. They are not counted either. */
  pendingChecks?: number;
}

/** The Overview headline. No coloured words, no counts: the summary row has them. */
export function overviewHeadline(t: Record<UiState, number>, ctx: OverviewHeadlineContext): string {
  if (!ctx.dataFolderOk) return "Riggverk can't use its folder.";
  if (!ctx.anyStatus) {
    // No status at all: still checking, unless every check has already failed.
    return (ctx.failedChecks ?? 0) > 0 && (ctx.pendingChecks ?? 0) === 0 ? "Some agents could not be checked." : "Checking your setup…";
  }
  if (ctx.allNotInstalled) return "Nothing is set up yet.";
  if (t.decide + t.fix + t.ready === 0) {
    if ((ctx.failedChecks ?? 0) > 0) return "Some agents could not be checked.";
    if ((ctx.pendingChecks ?? 0) > 0) return "Checking your setup…";
    return "Everything is set up.";
  }
  return "Your setup works.";
}

/**
 * Runtime health is never a state. It only adds a line when the harness reads as up to date or ready and the runtime
 * still warns; for every other state the state already explains the drift.
 */
export function runtimeSubline(state: UiState | null, verdict: { text: string; tone: Tone }): string | null {
  if (state !== "ok" && state !== "ready") return null;
  return verdict.tone === "warn" || verdict.tone === "fail" ? `Runtime check: ${verdict.text}` : null;
}

/** The mark of a security finding. Never counted, never part of a state. `not_covered` has no mark. */
export function postureMark(level: PostureLevel): { text: string; kind: "tip" | "set" } | null {
  switch (level) {
    case "risky":
      return { text: "Worth a look", kind: "tip" };
    case "enforced":
      return { text: "Set", kind: "set" };
    case "advice":
      return { text: "Tip", kind: "tip" };
    case "not_covered":
      return null;
  }
}
