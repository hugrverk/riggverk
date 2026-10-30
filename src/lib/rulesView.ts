import type { Tone } from "../ui/tone";
import type {
  CodexRuntimeHealth,
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
  copilot: "copilot_rules",
  pi: "pi_rules",
  kilo: "kilo_rules",
  antigravity: "antigravity_rules",
};

export function rulesSurfaceOf(harness: InstallAgent): RulesSurfaceId | null {
  return RULES_SURFACE[harness] ?? null;
}

/** The harness whose rules file is `surface`: the page that decides a conflict in it. */
export function harnessOfRulesSurface(surface: RulesSurfaceId): InstallAgent | null {
  return RULES_HARNESSES.find(harness => RULES_SURFACE[harness] === surface) ?? null;
}

/** Harnesses that have a rules surface, in the order the command line offers them. */
export const RULES_HARNESSES: readonly InstallAgent[] = ["codex", "opencode", "claude", "copilot", "pi", "kilo", "antigravity"];

export const LAYOUT_TEXT: Record<RulesLayout, string> = {
  absent: "no file yet",
  block: "managed base block",
  legacy: "plain file, no base block",
  malformed: "base block markers malformed",
};

export const CONFLICT_TEXT: Record<RulesConflictReason, string> = {
  base_block_edited: "the base block was edited",
  legacy_diverged: "the file differs from every shipped base",
  malformed_markers: "the base block markers are malformed",
  masked_by_override: "another file in the folder masks this one, so the harness never reads it",
  peer_context_file: "the harness reads another context file in the folder, which a new file would hide",
  exceeds_harness_limit: "the file would pass the size the harness reads (24,000 bytes for Antigravity)",
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
  | "malformed"
  /** Another file in the folder decides what the harness reads; the app writes nothing until that is sorted out. */
  | "blocked";

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
  /** The backend's conflict code, which decides the wording of the decision's why line; null without a conflict. */
  conflictReason: RulesConflictReason | null;
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

const MANAGED_DISPLAY: StateDisplay = { tone: "warn", label: "you manage" };

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
    conflictReason: rules.conflict_reason ?? null,
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
  if (
    rules.conflict_reason === "masked_by_override" ||
    rules.conflict_reason === "peer_context_file" ||
    rules.conflict_reason === "exceeds_harness_limit"
  ) {
    return {
      ...base,
      kind: "blocked",
      headline:
        rules.conflict_reason === "masked_by_override"
          ? "masked by another file: left as is"
          : rules.conflict_reason === "peer_context_file"
            ? "another context file would be hidden: nothing written"
            : "too large for the harness: shorten your refinements, nothing written",
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

/** The file a harness's rules surface writes, for messages. Mirrors the file name of each `target_rel`. */
const RULES_FILE_NAME: Partial<Record<InstallAgent, string>> = {
  claude: "CLAUDE.md",
  copilot: "copilot-instructions.md",
};

export function rulesFileName(harness: InstallAgent): string {
  return RULES_FILE_NAME[harness] ?? "AGENTS.md";
}

/** Whether an action is offered (`visible`) and, when it is offered but cannot run now, why not (`reason`). */
export interface RulesGate {
  visible: boolean;
  reason: string | null;
}

export interface RulesGates {
  diff: RulesGate;
  convert: RulesGate;
  /** `m` on a file the user does not manage yet: record "leave as is". */
  leave: RulesGate;
  /** `m` on a user-managed file: hand it back to the app. */
  manage: RulesGate;
}

export interface RulesGateContext {
  dataFolderOk: boolean;
  /** Label of a workspace task in flight, or null. */
  busyLabel: string | null;
  /** A review (install or rules) is open on the page: the actions wait for it to close. */
  blockedBy: string | null;
}

/** What `d`, `v` and `m` (and `:rules ...`) may do for `model` right now. */
export function rulesGates(model: RulesModel | null, context: RulesGateContext): RulesGates {
  const hidden: RulesGate = { visible: false, reason: null };
  if (!model || !context.dataFolderOk) return { diff: hidden, convert: hidden, leave: hidden, manage: hidden };
  const wait = context.blockedBy ?? (context.busyLabel ? `${context.busyLabel} is running` : null);
  const gate = (visible: boolean, reason: string | null = null): RulesGate => ({ visible, reason: visible ? wait ?? reason : null });
  return {
    diff: gate(model.kind !== "absent", model.diffDisabled || null),
    convert: gate(model.convertible || model.kind === "malformed", model.convertible ? null : "the markers are malformed; fix them by hand first"),
    leave: gate(model.convertible && !model.user_managed),
    manage: gate(model.user_managed),
  };
}

/**
 * The sentence above the buttons of a rules decision: what happened to the file and what the harness reads now.
 * Plain words, no key names. `harnessLabel` is "Claude Code", `fileName` "CLAUDE.md". Null when there is nothing to say.
 */
export function rulesWhy(model: RulesModel, harnessLabel: string, fileName: string): string | null {
  switch (model.kind) {
    case "conflict":
      return model.conflictReason === "base_block_edited"
        ? `Riggverk left ${fileName} exactly as it is, because its managed block was edited. ${harnessLabel} reads your version and doesn't have the newest Riggverk rules yet.`
        : `Riggverk left ${fileName} exactly as it is: it matches none of the versions Riggverk ships. ${harnessLabel} reads your version and doesn't have the newest Riggverk rules yet.`;
    case "managed":
      return `You manage ${fileName}, so Riggverk never writes it. ${harnessLabel} reads your version; Riggverk's newer rules are waiting if you want them.`;
    case "update":
      return `${fileName} can take the newest Riggverk rules. What you added around the block stays where it is.`;
    case "malformed":
      return `${fileName} has base block markers Riggverk cannot split, so it never rewrites the file. Fix the markers by hand; Check picks it up.`;
    case "blocked":
      return `Another file in the folder decides what ${harnessLabel} reads, so Riggverk writes nothing here. Remove or rename that file, or add the base to it by hand.`;
    default:
      // A current file, or none yet: the state pill says it all.
      return null;
  }
}

export interface RulesOverrideWarning {
  title: string;
  detail: string;
}

/**
 * Codex reads `$CODEX_HOME/AGENTS.override.md` instead of `AGENTS.md` when it has content, which silently drops the
 * base. The runtime health reports it as a `rules_override` warning check.
 */
export function rulesOverrideWarning(health: Pick<CodexRuntimeHealth, "checks"> | null | undefined): RulesOverrideWarning | null {
  const check = health?.checks?.find(candidate => candidate.id === "rules_override" && candidate.status === "warn");
  return check ? { title: check.label, detail: check.detail } : null;
}
