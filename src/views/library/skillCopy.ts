import { PERSONAL_SKILL_PREFIX } from "../../lib/packSkills";
import type { SkillSummary } from "../../types";

/** The name a copy of `skill` starts with. */
export function suggestedCopyName(skill: string): string {
  return `${skill}-mine`.slice(0, 64).replace(/-+$/, "");
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Why `name` cannot be the name of a new personal skill, or "" when it can (and while it is empty). The same checks as
 * the backend's, so a refusal shows before Create: lowercase letters, digits and dashes (1 to 64, no leading dash), and
 * a name no bundled skill and no pack skill has. The backend still decides.
 */
export function skillCopyProblem(name: string, skills: readonly SkillSummary[]): string {
  if (name === "") return "";
  if (!NAME.test(name)) return "Use 1–64 lowercase letters, digits and dashes, and no dash first.";
  if (skills.some(skill => skill.packState === undefined && skill.name === name)) {
    return `A bundled skill is already named ${name}. Choose another name.`;
  }
  const taken = skills.find(skill => skill.packState !== undefined && skill.name === name);
  if (taken) {
    return taken.id.startsWith(PERSONAL_SKILL_PREFIX) ? `pack:personal already has ${name}.` : `A pack already has a skill named ${name}.`;
  }
  return "";
}
