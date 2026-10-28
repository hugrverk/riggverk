import type { KvItem } from "../ui/Kv";
import type {
  EffectiveSkillLoads,
  ForeignSkillDuplicate,
  HarnessSkillLoads,
  InstallAgent,
  SkillCopy,
  SkillLoad,
  SkillLoadFlag,
  SkillReadFolder,
} from "../types";
import type { StateDisplay } from "./installationView";

/** Flagged names listed under the summary row; the rest is counted as "+N more". */
export const MAX_FLAGGED_ROWS = 5;

/** What the pages need of the load view: the data, or why there is none. */
export interface SkillLoadsView {
  loads: EffectiveSkillLoads | null;
  error: string | null;
}

/** Whether a flag is worth a warning. Identical copies only show up in a log or a diagnostic of the harness. */
export function isWarningFlag(flag: SkillLoadFlag): boolean {
  return flag !== "duplicate_identical";
}

export interface HarnessLoadSummary {
  harness: HarnessSkillLoads;
  /** Skill names the harness loads, the user's own included. */
  names: number;
  /** Names with several copies, all of them the app's: `u` can fix them. */
  flagged: SkillLoad[];
  /** Names with several byte-identical copies (OpenCode, Kilo): information only. */
  identical: SkillLoad[];
  /** Names with several copies, some of them the user's: the app cannot fix them. */
  foreign: ForeignSkillDuplicate[];
}

/** The loads of one harness, or null while there is no data (or the harness is not enabled). */
export function summarizeSkillLoads(
  loads: EffectiveSkillLoads | null | undefined,
  harness: InstallAgent,
): HarnessLoadSummary | null {
  const own = loads?.harnesses.find((candidate) => candidate.harness === harness);
  if (!loads || !own) return null;
  return {
    harness: own,
    names: own.skills.length,
    flagged: own.skills.filter((skill) => skill.flags.some(isWarningFlag) && !skill.flags.includes("foreign_copy")),
    identical: own.skills.filter((skill) => skill.flags.includes("duplicate_identical")),
    foreign: loads.foreign_duplicates.filter((duplicate) => duplicate.harnesses.includes(harness)),
  };
}

/** Names that need a look on this harness: the app's duplicates plus the user's own. */
export function skillLoadProblemCount(summary: HarnessLoadSummary | null): number {
  return summary ? summary.flagged.length + summary.foreign.length : 0;
}

/** A surface state with the number of duplicate names after it; an ok state turns into a warning. */
export function withSkillProblems(display: StateDisplay, problems: number): StateDisplay {
  if (problems <= 0) return display;
  return {
    ...display,
    tone: display.tone === "ok" ? "warn" : display.tone,
    label: `${display.label} · ${problems} duplicate${problems === 1 ? "" : "s"}`,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function folderPath(harness: HarnessSkillLoads, folder: SkillReadFolder): string {
  return harness.folders.find((candidate) => candidate.folder === folder)?.path ?? folder;
}

/** "~/.agents/skills + ~/.codex/skills": the folders the copies of one name are in. */
function copyFolders(harness: HarnessSkillLoads, copies: readonly { folder: SkillReadFolder }[]): string {
  return [...new Set(copies.map((copy) => folderPath(harness, copy.folder)))].join(" + ");
}

/** What a warning flag means for the harness that reports it. */
function effectOf(flag: SkillLoadFlag): string {
  switch (flag) {
    case "plain_mention_ambiguous": return "plain $name mention is ambiguous";
    case "winner_nondeterministic": return "winner varies between runs";
    case "possible_duplicate": return "possible duplicate";
    case "shadowed_by_folder_order": return "first folder wins, the others are hidden";
    case "duplicate_identical": return "identical copies";
    case "foreign_copy": return "yours, Riggverk cannot fix";
  }
}

/** "3 names with 2 copies", or "2+" when the names do not all have the same number. */
function flaggedSummary(flagged: readonly SkillLoad[]): string {
  const counts = new Set(flagged.map((skill) => skill.copies.length));
  const copies = counts.size === 1 ? `${[...counts][0]}` : "2+";
  return `${plural(flagged.length, "name")} with ${copies} copies`;
}

function summaryRow(summary: HarnessLoadSummary): KvItem {
  const { names, flagged, foreign, identical } = summary;
  const label = "skill loads";
  if (flagged.length > 0 || foreign.length > 0) {
    const parts = [
      ...(flagged.length > 0 ? [flaggedSummary(flagged)] : []),
      // What Cursor does with a duplicate is documented nowhere; say so once, not on every row.
      ...(flagged.some((skill) => skill.flags.includes("possible_duplicate")) ? ["not verified for your Cursor version"] : []),
      ...(foreign.length > 0 ? [`${plural(foreign.length, "name")} of yours with several copies`] : []),
    ];
    return { label, value: parts.join(" · "), tone: "warn", wrap: true };
  }
  if (names === 0) return { label, value: "no skills found", tone: "dim" };
  if (identical.length > 0) {
    return { label, value: `${plural(names, "skill")} · ${identical.length} with identical copies`, tone: "dim", wrap: true };
  }
  return { label, value: `${plural(names, "skill")}, 1 copy each`, tone: "ok" };
}

function flaggedRow(summary: HarnessLoadSummary, skill: SkillLoad): KvItem {
  const flag = skill.flags.find(isWarningFlag) ?? skill.flags[0]!;
  const where = copyFolders(summary.harness, skill.copies);
  return { label: "", id: `flagged-${skill.name}`, value: `${skill.name} · ${where} · ${effectOf(flag)}`, tone: "warn", wrap: true };
}

/** The user's own copies of a name, which the app cannot fix: all of them kept means the app leaves them alone. */
function foreignEffect(copies: readonly SkillCopy[]): string {
  const foreign = copies.filter((copy) => copy.owner === "foreign");
  return foreign.length > 0 && foreign.every((copy) => copy.kept === true)
    ? "yours (kept), Riggverk leaves it alone"
    : effectOf("foreign_copy");
}

function foreignRow(summary: HarnessLoadSummary, duplicate: ForeignSkillDuplicate): KvItem {
  const own = summary.harness.skills.find((skill) => skill.name === duplicate.name);
  const copies = own?.copies ?? duplicate.copies;
  const where = copyFolders(summary.harness, copies);
  return { label: "", id: `foreign-${duplicate.name}`, value: `${duplicate.name} · ${foreignEffect(copies)} · ${where}`, tone: "warn", wrap: true };
}

/**
 * The `skill loads` rows of a harness page: one summary, then up to five names that need a look and how many
 * more there are. Nothing while the data is still loading; a dim row when it could not be read.
 */
export function skillLoadRows({ loads, error }: SkillLoadsView, harness: InstallAgent): KvItem[] {
  const summary = summarizeSkillLoads(loads, harness);
  if (!summary) return error ? [{ label: "skill loads", value: `not checked: ${error}`, tone: "dim", wrap: true }] : [];
  const problems: KvItem[] = [
    ...summary.flagged.map((skill) => flaggedRow(summary, skill)),
    ...summary.foreign.map((duplicate) => foreignRow(summary, duplicate)),
  ];
  const more = problems.length - MAX_FLAGGED_ROWS;
  return [
    summaryRow(summary),
    ...problems.slice(0, MAX_FLAGGED_ROWS),
    ...(more > 0 ? [{ label: "", id: "flagged-more", value: `+${more} more`, tone: "dim" as const }] : []),
  ];
}

/** The `reads` row for the skills surface: the folders this harness reads, and the ones that are missing. */
export function skillReadsRows({ loads }: SkillLoadsView, harness: InstallAgent): KvItem[] {
  const summary = summarizeSkillLoads(loads, harness);
  if (!summary || summary.harness.folders.length === 0) return [];
  const value = summary.harness.folders
    .map((folder) => {
      const note = folder.note ?? (folder.exists ? "" : "missing");
      return note ? `${folder.path} (${note})` : folder.path;
    })
    .join(", ");
  return [{ label: "reads", value, wrap: true }];
}
