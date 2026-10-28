import type { PackEntry, PackLibrary, PackSkillEntry, PackSkillState, SkillSummary } from "../types";

/** Label of a pack skill that is not active, for the list and the metadata. */
export const PACK_STATE_LABEL: Record<Exclude<PackSkillState, "active">, string> = {
  shadowed: "shadowed",
  error: "error",
  missing: "pack missing",
};

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
