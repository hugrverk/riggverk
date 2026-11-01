import { IMPORTED_PACK } from "../../lib/packSkills";
import { unifiedLineDiff } from "../../lib/lineDiff";
import type { ImportCandidate, ImportFileChange, ImportFlag, ImportProvenance, SkillImportResult, SkillSummary } from "../../types";

/** Said above the buttons of every import: the import only fills the pack, the Update review decides the rest. */
export const IMPORT_DESTINATION = "Goes into pack:imported. Agents get it at the next Update, where you review it again.";

/** The Agent Skills name rule: 1–64 lowercase letters, digits and single dashes, no dash first or last. */
const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A candidate that can be ticked: nothing refuses it, and it is not the import already in place. */
export function canImport(candidate: ImportCandidate): boolean {
  return candidate.problems.length === 0 && (candidate.status === "new" || candidate.status === "update");
}

/** The name a bundled-name collision is offered instead. */
export function suggestedImportName(name: string): string {
  return `${name}-imported`.slice(0, 64).replace(/-+$/, "");
}

/**
 * Why `name` cannot be the name `candidate` is imported under, or "". The backend's checks, so a refusal shows before
 * Import: the spec's name rule, no bundled skill's name, no other pack's, and no other import's (the candidate's own
 * name is the import it updates). The backend still decides.
 */
export function importNameProblem(name: string, candidate: ImportCandidate, skills: readonly SkillSummary[]): string {
  if (name === "") return "Give the skill a name.";
  if (name.length > 64 || !SPEC_NAME.test(name)) return "Use 1–64 lowercase letters, digits and single dashes, no dash first or last.";
  if (skills.some(skill => skill.packState === undefined && skill.name === name)) return `A bundled skill is named ${name}. Choose another name.`;
  const taken = skills.find(skill => skill.packState !== undefined && skill.name === name);
  if (!taken) return "";
  if (taken.group !== `pack:${IMPORTED_PACK}`) return `${taken.group} already has a skill named ${name}.`;
  return name === candidate.name ? "" : `An imported skill is already named ${name}. Choose another name.`;
}

/** The status of a candidate in words. */
export function importStatus(candidate: ImportCandidate): string {
  switch (candidate.status) {
    case "new": return candidate.collision === "bundled" ? "new · a bundled skill has this name" : "new";
    case "update": return `update · replaces the import in place (${plural(candidate.changes.length, "file")} differ)`;
    case "unchanged": return "already imported, unchanged";
    case "refused": return "cannot be imported";
  }
}

const FLAG_ORDER: Record<ImportFlag["kind"], number> = { key: 0, shell: 1, openai: 2, executable: 3, binary: 4, unicode: 5 };
const KEY_ORDER = ["allowed-tools", "hooks", "context", "agent", "background", "model"];

/**
 * The flags in the order the dialog lists them: the keys that act without asking (`allowed-tools`, `hooks`, then the
 * keys that change where the skill runs), `!` commands, `agents/openai.yaml`, scripts, binaries, hidden Unicode.
 */
export function orderedFlags(flags: readonly ImportFlag[]): ImportFlag[] {
  const keyRank = (flag: ImportFlag) => (flag.kind === "key" ? KEY_ORDER.indexOf(flag.label) : 0);
  return [...flags].sort((a, b) => FLAG_ORDER[a.kind] - FLAG_ORDER[b.kind] || keyRank(a) - keyRank(b));
}

/** The unified diff of one changed file, for `DiffView`; "" for a binary or oversized file. */
export function changeDiff(change: ImportFileChange): string {
  if (change.before === null && change.after === null) return "";
  return unifiedLineDiff(change.before ?? "", change.after ?? "");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The command that takes a skill repository from GitHub into the packs folder. The app runs no git: the user does. */
export function cloneCommand(packsFolder: string): string {
  return `git clone <url> ${packsFolder}/<name>`;
}

/** The notice after an import. */
export function importDoneText(result: SkillImportResult): string {
  const parts = [
    result.imported.length > 0 ? `Imported ${result.imported.join(", ")}` : "",
    result.updated.length > 0 ? `${result.imported.length > 0 ? "updated" : "Updated"} ${result.updated.join(", ")}` : "",
  ].filter(Boolean);
  return `${parts.join(" · ")} · Update installs it`;
}

/** Where an imported skill came from, in one line. */
export function provenanceText(provenance: ImportProvenance): string {
  const date = new Date(provenance.imported_at * 1000);
  const day = Number.isNaN(date.getTime()) ? "" : ` on ${date.toISOString().slice(0, 10)}`;
  return `imported from ${provenance.source}${day}`;
}

/**
 * What an import under another name writes: `text` with its one top-level `name:` frontmatter line replaced by
 * `name: <name>` (line ending kept), nothing else changed; null when there is no such line. The same rewrite as the
 * backend's `renamed_skill_md`, which re-derives these bytes from the previewed text at Import and refuses any other.
 */
export function renamedSkillMd(text: string, name: string): string | null {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (lines[0]?.trimEnd() !== "---") return null;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    const bare = line.replace(/[\r\n]+$/, "");
    if (bare.trimEnd() === "---") return null;
    if (bare.startsWith("name:")) {
      return [...lines.slice(0, index), `name: ${name}${line.slice(bare.length)}`, ...lines.slice(index + 1)].join("");
    }
  }
  return null;
}
