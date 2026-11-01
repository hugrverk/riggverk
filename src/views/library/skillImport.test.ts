import { describe, expect, it } from "vitest";
import { packSkillSummaries } from "../../lib/packSkills";
import type { ImportCandidate, ImportFlag, PackLibrary, SkillSummary } from "../../types";
import { topicGroups, type LibraryModelInput } from "./model";
import {
  canImport,
  changeDiff,
  cloneCommand,
  importDoneText,
  importNameProblem,
  orderedFlags,
  provenanceText,
  suggestedImportName,
} from "./skillImport";

function skill(id: string, name: string, group: string, packState?: SkillSummary["packState"]): SkillSummary {
  return { id, name, description: "", path: "", group, category: "", risk: "", targets: [], related: [], packState };
}

const SKILLS = [
  skill("tdd", "tdd", "bundled"),
  skill("pack:imported/pdf-tools", "pdf-tools", "pack:imported", "active"),
  skill("pack:team/shared", "shared", "pack:team", "active"),
];

function candidate(extra: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    key: "0", kind: "folder", source: "~/Downloads/x", name: "x", description: "d", license: "", compatibility: "",
    files: [], omitted: [], flags: [], problems: [], skill_md: "", digest: "", status: "new", collision: null, changes: [], ...extra,
  };
}

describe("importNameProblem", () => {
  it("holds the Agent Skills name rule: lowercase letters, digits and single dashes, 1–64", () => {
    expect(importNameProblem("my-tdd", candidate(), SKILLS)).toBe("");
    for (const name of ["My-tdd", "my--tdd", "-tdd", "tdd-", "my_tdd", "a".repeat(65)]) {
      expect(importNameProblem(name, candidate(), SKILLS)).toMatch(/^Use 1–64 lowercase letters/);
    }
    expect(importNameProblem("", candidate(), SKILLS)).toBe("Give the skill a name.");
  });

  it("refuses a bundled name, another pack's name, and another import's name, but not the import it updates", () => {
    expect(importNameProblem("tdd", candidate(), SKILLS)).toBe("A bundled skill is named tdd. Choose another name.");
    expect(importNameProblem("shared", candidate(), SKILLS)).toBe("pack:team already has a skill named shared.");
    expect(importNameProblem("pdf-tools", candidate(), SKILLS)).toMatch(/^An imported skill is already named pdf-tools/);
    expect(importNameProblem("pdf-tools", candidate({ name: "pdf-tools" }), SKILLS)).toBe("");
  });

  it("suggests <name>-imported for a bundled collision", () => {
    expect(suggestedImportName("tdd")).toBe("tdd-imported");
    expect(suggestedImportName("a".repeat(64)).length).toBeLessThanOrEqual(64);
  });
});

describe("candidates", () => {
  it("can be ticked only when nothing refuses them and they change something", () => {
    expect(canImport(candidate())).toBe(true);
    expect(canImport(candidate({ status: "update" }))).toBe(true);
    expect(canImport(candidate({ status: "unchanged" }))).toBe(false);
    expect(canImport(candidate({ status: "refused", problems: ["SKILL.md is a link"] }))).toBe(false);
  });

  it("list the flags in a fixed order: keys that act without asking, ! commands, openai.yaml, scripts, binaries, Unicode", () => {
    const flag = (kind: ImportFlag["kind"], label: string): ImportFlag => ({ kind, label, detail: "" });
    const flags = [flag("unicode", "hidden Unicode"), flag("binary", "binary files"), flag("key", "model"), flag("shell", "! commands"), flag("executable", "scripts"), flag("openai", "agents/openai.yaml"), flag("key", "hooks"), flag("key", "allowed-tools")];
    expect(orderedFlags(flags).map(f => f.label)).toEqual(["allowed-tools", "hooks", "model", "! commands", "agents/openai.yaml", "scripts", "binary files", "hidden Unicode"]);
  });

  it("diff a changed text file and show nothing for a binary one", () => {
    expect(changeDiff({ path: "a.md", change: "changed", before: "one\n", after: "two\n" })).toBe("-one\n+two");
    expect(changeDiff({ path: "a.md", change: "added", before: null, after: "new\n" })).toBe("+new");
    expect(changeDiff({ path: "b.bin", change: "changed", before: null, after: null })).toBe("");
  });

  it("word the outcome, the source and the git hint", () => {
    expect(importDoneText({ imported: ["a", "b"], updated: ["c"] })).toBe("Imported a, b · updated c · Update installs it");
    expect(importDoneText({ imported: [], updated: ["c"] })).toBe("Updated c · Update installs it");
    expect(provenanceText({ source: "~/Downloads/x", kind: "folder", imported_at: 1761984000, digest: "" })).toBe("imported from ~/Downloads/x on 2025-11-01");
    expect(cloneCommand("~/.config/riggverk/packs")).toBe("git clone <url> ~/.config/riggverk/packs/<name>");
  });
});

describe("the Library model of imports", () => {
  const library: PackLibrary = {
    folder: "~/.config/riggverk/packs",
    packs: [{ name: "imported", state: "ok", reason: "", forgettable: false, routing: [], routing_problem: null }],
    skills: [
      { id: "pack:imported/pdf-tools", name: "pdf-tools", description: "PDFs.", pack: "imported", state: "active", reason: "", path: "skills/pdf-tools/SKILL.md", privileged: [], provenance: { source: "~/Downloads/pdf-tools", kind: "folder", imported_at: 1761984000, digest: "" } },
    ],
    ignored: [],
    undo_import: { action: "import", name: "pdf-tools" },
  };
  const input = (extra: Partial<LibraryModelInput> = {}): LibraryModelInput => ({
    dataFolderOk: true, docs: [], agentTemplateLoaded: true, rulesFiles: [], skills: packSkillSummaries(library), agentSources: [],
    configTargets: [], configEditorSources: [], packLibrary: library, packError: null, canCopySkill: true, canForgetPack: true,
    canOpenHarness: true, canImportSkill: true, ...extra,
  });

  it("gives the Packs group Import skill… and an imported skill its source and verbs", () => {
    const [group] = topicGroups("packs", input());
    expect(group?.action).toEqual({ label: "Import skill…", id: "import-skill" });
    const row = group?.rows.find(r => r.name === "pdf-tools");
    expect(row?.note).toBe("imported from ~/Downloads/pdf-tools on 2025-11-01");
    expect(row?.verbs.map(v => v.label)).toEqual(["Read", "Edit as my copy", "Remove import", "Undo import"]);
    expect(row?.verbs[1]?.action).toEqual({ type: "copy", skill: "pack:imported/pdf-tools" });
  });

  it("puts Undo remove on the imported pack's row once the last event is a removal", () => {
    const removed = { ...library, skills: [], undo_import: { action: "remove" as const, name: "pdf-tools" } };
    const [group] = topicGroups("packs", input({ packLibrary: removed, skills: [] }));
    expect(group?.rows[0]?.verbs.map(v => v.label)).toEqual(["Undo remove of pdf-tools"]);
  });

  it("offers nothing to import while the app cannot", () => {
    const [group] = topicGroups("packs", input({ canImportSkill: false }));
    expect(group?.action).toBeUndefined();
    expect(group?.rows.find(r => r.name === "pdf-tools")?.verbs.map(v => v.label)).toEqual(["Read"]);
  });
});
