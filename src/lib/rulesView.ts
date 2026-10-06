import type { Tone } from "../ui/tone";
import type {
  InstallAgent,
  InstallationState,
  InstallationStatus,
  RulesConflictReason,
  RulesDiffMode,
  RulesLayout,
  RulesMalformedReason,
  RulesStatus,
  RulesSurfaceId,
} from "../types";
import type { StateDisplay } from "./installationView";

/** The rules surface of each harness. Cursor has none: its User Rules stay a manual IDE setting. */
const RULES_SURFACE: Partial<Record<InstallAgent, RulesSurfaceId>> = {
  codex: "codex_rules",
  opencode: "open_code_rules",
  claude: "claude_rules",
};

export function rulesSurfaceOf(harness: InstallAgent): RulesSurfaceId | null {
  return RULES_SURFACE[harness] ?? null;
}

/** Harnesses that have a rules surface, in the order the command line offers them. */
export const RULES_HARNESSES: readonly InstallAgent[] = ["codex", "opencode", "claude"];

/** The block details the backend reported for `surface`, or null (surface off, not fetched, or not a rules surface). */
export function rulesStatusOf(status: InstallationStatus | null | undefined, surface: RulesSurfaceId): RulesStatus | null {
  return status?.surfaces.find(row => row.surface === surface)?.rules ?? null;
}

const LAYOUT_TEXT: Record<RulesLayout, string> = {
  absent: "no file yet",
  block: "managed base block",
  legacy: "plain file, no base block",
  malformed: "base block markers malformed",
};

const CONFLICT_TEXT: Record<RulesConflictReason, string> = {
  base_block_edited: "the base block was edited",
  legacy_diverged: "the file differs from every shipped base",
  malformed_markers: "the base block markers are malformed",
};

const MALFORMED_TEXT: Record<RulesMalformedReason, string> = {
  not_utf8: "file is not valid UTF-8",
  too_large: "file is larger than 4 MB",
  duplicate_begin: "more than one BEGIN marker",
  duplicate_end: "more than one END marker",
  missing_end: "BEGIN marker has no matching END marker",
  missing_begin: "END marker has no matching BEGIN marker",
  end_before_begin: "END marker appears before the BEGIN marker",
};

/** "14 refinement lines preserved", "1 refinement line preserved", "none". */
export function refinementText(lines: number): string {
  if (lines <= 0) return "none";
  return `${lines} refinement line${lines === 1 ? "" : "s"} preserved`;
}

export type RulesKind =
  /** No file yet; install creates it. */
  | "absent"
  | "current"
  /** The block (or an untouched plain file) takes the new base; the user's text stays. */
  | "update"
  /** A hand-edited file the update refuses; convert or leave as is. */
  | "conflict"
  /** The user keeps a hand-edited file; base updates are available but never applied. */
  | "managed"
  /** Markers that cannot be split; nothing but a manual fix helps. */
  | "malformed";

export interface RulesModel {
  surface: RulesSurfaceId;
  kind: RulesKind;
  layout: string;
  refinements: string;
  /** One line: what happens to the file. */
  headline: string;
  tone: Tone;
  /** Why the file is left as is: the conflict, plus the malformed-marker rule that failed. */
  reason: string | null;
  /** Row override for the surfaces list; null keeps the generic state display. */
  display: StateDisplay | null;
  /** Conversion and "leave as is" are offered (`base_block_edited`, `legacy_diverged`). */
  convertible: boolean;
  /** Which diff `d` opens: your edits against the shipped base for a conflict, the update otherwise. */
  diffMode: RulesDiffMode;
  /** Why `d` cannot run, or false. */
  diffDisabled: string | false;
  user_managed: boolean;
}

const MANAGED_DISPLAY: StateDisplay = { glyph: "partial", tone: "warn", label: "you manage" };

function reasonOf(rules: RulesStatus): string | null {
  if (!rules.conflict_reason) return null;
  const base = CONFLICT_TEXT[rules.conflict_reason];
  return rules.conflict_reason === "malformed_markers" && rules.malformed_reason
    ? `${base}: ${MALFORMED_TEXT[rules.malformed_reason]}`
    : base;
}

/**
 * What the pages say about a rules file. `state` is the surface state the backend reports; the block details
 * decide the wording. A user-managed file reports `current` (the planner leaves it alone), so it must never be
 * shown as current: it has base updates the user chose not to take.
 */
export function rulesModel(surface: RulesSurfaceId, state: InstallationState, rules: RulesStatus): RulesModel {
  const convertible = rules.conflict_reason === "base_block_edited" || rules.conflict_reason === "legacy_diverged";
  const reason = reasonOf(rules);
  const base = {
    surface,
    layout: LAYOUT_TEXT[rules.layout],
    refinements: refinementText(rules.refinement_lines),
    reason,
    convertible,
    user_managed: rules.user_managed,
  };
  const diffDisabled: string | false =
    rules.layout === "absent"
      ? "no rules file is installed"
      : rules.conflict_reason === "malformed_markers"
        ? "the markers are malformed; there is nothing to compare"
        : false;
  const diffMode: RulesDiffMode = convertible ? "edits" : "update";

  if (rules.conflict_reason === "malformed_markers") {
    return {
      ...base,
      kind: "malformed",
      headline: "markers malformed: left as is, never rewritten",
      tone: "fail",
      display: null,
      diffMode,
      diffDisabled,
    };
  }
  if (rules.user_managed) {
    return {
      ...base,
      kind: "managed",
      headline: "base updates available, you manage this file",
      tone: "warn",
      display: MANAGED_DISPLAY,
      diffMode,
      diffDisabled,
    };
  }
  if (convertible) {
    return {
      ...base,
      kind: "conflict",
      headline: rules.conflict_reason === "base_block_edited" ? "base block edited: left as is" : "differs from every shipped base: left as is",
      tone: "fail",
      display: null,
      diffMode,
      diffDisabled,
    };
  }
  if (rules.layout === "absent" || state === "not_installed") {
    return { ...base, kind: "absent", headline: "not installed", tone: "warn", display: null, diffMode, diffDisabled };
  }
  if (state === "update_available") {
    return {
      ...base,
      kind: "update",
      headline: rules.layout === "legacy" ? "unmodified file moves into the base block" : "base update available",
      tone: "warn",
      display: null,
      diffMode,
      diffDisabled,
    };
  }
  return { ...base, kind: "current", headline: "current", tone: "ok", display: null, diffMode, diffDisabled };
}

/** The model of `harness`'s rules file under `status`, or null when it has none or it is not in the status. */
export function rulesModelFor(harness: InstallAgent, status: InstallationStatus | null | undefined): RulesModel | null {
  const surface = rulesSurfaceOf(harness);
  if (!surface) return null;
  const row = status?.surfaces.find(candidate => candidate.surface === surface);
  if (!row?.rules) return null;
  return rulesModel(surface, row.state, row.rules);
}
