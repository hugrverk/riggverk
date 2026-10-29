import type { PackEntry, PackLibrary, PackSkillEntry, PackSkillState, SkillSummary } from "../types";

/** Label of a pack skill that is not active, for the list and the metadata. */
export const PACK_STATE_LABEL: Record<Exclude<PackSkillState, "active">, string> = {
  shadowed: "shadowed",
  error: "error",
  missing: "pack missing",
};

/** The id prefix of the skills in the user's own pack: the only pack skills the Library edits. */
export const PERSONAL_SKILL_PREFIX = "pack:personal/";

/** A skill of the user's own pack that is in the catalog: the only skill the Library edits. */
export function isPersonalSkill(id: string, skill: { packState?: string } | undefined): boolean {
  return id.startsWith(PERSONAL_SKILL_PREFIX) && skill?.packState === "active";
}

/** Group heading of a pack's skills in the Library list. */
export function packGroup(pack: string): string {
  return `pack:${pack}`;
}

function toSummary(skill: PackSkillEntry): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    group: packGroup(skill.pack),
    category: "",
    risk: "",
    targets: [],
    related: [],
    packState: skill.state,
    packReason: skill.reason,
  };
}

/** The Library rows for the skills of the packs, after the bundled ones. */
export function packSkillSummaries(library: PackLibrary | null): SkillSummary[] {
  return library ? library.skills.map(toSummary) : [];
}

/** The packs that need the user's decision: installed skills of a pack that cannot be read. */
export function forgettablePacks(library: PackLibrary | null): PackEntry[] {
  return library ? library.packs.filter(pack => pack.forgettable) : [];
}

export interface PackNoticeLine {
  key: string;
  label: string;
  text: string;
}

/**
 * What the Library says about packs besides their skills: why the list failed, a record the app cannot use,
 * packs it refused to read, and folders in `packs/` that are no pack. A refused pack that offers "Forget pack"
 * is worded there instead.
 */
export function packNoticeLines(library: PackLibrary | null, error: string | null): PackNoticeLine[] {
  const lines: PackNoticeLine[] = [];
  if (error) lines.push({ key: "error", label: "packs", text: `could not be listed: ${error}` });
  if (!library) return lines;
  if (library.record_problem) lines.push({ key: "record", label: "packs", text: library.record_problem });
  for (const pack of library.packs) {
    if (pack.state === "refused" && !pack.forgettable) {
      lines.push({ key: `refused:${pack.name}`, label: packGroup(pack.name), text: `refused: ${pack.reason}` });
    }
  }
  for (const entry of library.ignored) {
    lines.push({ key: `ignored:${entry.name}`, label: `${library.folder}/${entry.name}`, text: `ignored: ${entry.reason}` });
  }
  return lines;
}
