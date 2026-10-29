import { useEffect, useRef } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryController } from "../hooks/useLibraryController";
import { renderInFrame } from "../test/renderWithShell";
import type {
  AgentMetadataResponse,
  AgentTargetMeta,
  DocumentContent,
  InstallAgent,
  PackLibrary,
  RulesFileContent,
  RulesFileSummary,
  SkillSummary,
} from "../types";
import { LibraryView } from "./LibraryView";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => true,
}));

// ---- a small backend: what the Library asks for, in memory ----

const BEFORE = "<!-- BEGIN BASE -->\n## Verification\nEvidence first.\n<!-- END BASE -->";

interface Fixture {
  docs: Map<string, DocumentContent>;
  rulesRefinements: Map<string, string>;
  packs: PackLibrary;
  /** Text of the skills of the personal pack, by id. */
  personalSkills: Map<string, string>;
  /** When set, copy_skill_to_pack refuses with this reason. */
  refuseCopy: string | null;
  /** When set, copy_skill_to_pack answers only once this promise settles. */
  holdCopy: Promise<void> | null;
  packListFails: boolean;
  /** A copy turns packListFails on. */
  packListFailsAfterCopy: boolean;
  /** When set, read_doc of the bundled README fails with this message. */
  readDocFails: string | null;
}

function skill(id: string, description: string, extra: Partial<SkillSummary> = {}): SkillSummary {
  return { id, name: id, description, path: `skills/${id}/SKILL.md`, group: "bundled", category: "", risk: "low", targets: [], related: [], ...extra };
}

const BUNDLED_SKILLS = [skill("tdd", "Drives red, green, refactor."), skill("diagnose", "Finds the root cause.")];

const AGENTS: AgentMetadataResponse[] = [
  {
    id: "verifier.md",
    title: "verifier",
    path: "agents/verifier.md",
    exists: true,
    metadata: { role: "verify", summary: "Runs the checks and reports evidence.", targets: [], risk: "low", default_skills: [], safe_to_edit_runtime: true, notes: [] },
  },
];

const CONFIG_TARGETS: AgentTargetMeta[] = [
  { id: "codex_config", label: "Codex config", harness: "codex", kind: "config", target_rel: ".codex/config.toml", source_rel: "templates/codex-config.toml" },
];

function rulesSummary(surface: RulesFileSummary["surface"], label: string, extra: Partial<RulesFileSummary> = {}): RulesFileSummary {
  return { surface, label, file: `~/${label}.md`, layout: "block", conflict: null, malformed: null, refinement_lines: 2, editable: true, reason: null, ...extra };
}

const RULES_FILES: RulesFileSummary[] = [
  rulesSummary("claude_rules", "Claude rules"),
  rulesSummary("codex_rules", "Codex rules", { conflict: "base_block_edited", refinement_lines: 1 }),
  rulesSummary("open_code_rules", "OpenCode rules", { refinement_lines: 0 }),
];

function freshFixture(): Fixture {
  const doc = (id: string, title: string, content: string, source: string): DocumentContent => ({
    id,
    title,
    path: source === "custom" ? `docs/context/${id}.md` : `docs/${id}`,
    section: "Docs",
    source,
    content,
  });
  return {
    docs: new Map([
      ["custom:notes", doc("custom:notes", "Notes", "# Notes\nfirst", "custom")],
      ["README.md", doc("README.md", "README", "# Readme\nbundled text", "curated")],
    ]),
    rulesRefinements: new Map([
      ["claude_rules", "\n\n## Mine\nSwedish.\n"],
      ["codex_rules", "\n\n## Mine\nHand edited.\n"],
      ["open_code_rules", ""],
    ]),
    packs: {
      folder: "~/.config/riggverk/packs",
      packs: [
        { name: "mine", state: "ok", reason: "", forgettable: false },
        { name: "personal", state: "ok", reason: "", forgettable: false },
        { name: "old-pack", state: "missing", reason: "the pack folder is gone", forgettable: true },
      ],
      skills: [
        { id: "pack:mine/my-checklist", name: "my-checklist", description: "A checklist of mine.", pack: "mine", state: "active", reason: "", path: "my-checklist/SKILL.md" },
        { id: "pack:mine/tdd", name: "tdd", description: "Named like a bundled skill.", pack: "mine", state: "shadowed", reason: "the bundle wins", path: "tdd/SKILL.md" },
        { id: "pack:personal/my-notes", name: "my-notes", description: "Notes of my own.", pack: "personal", state: "active", reason: "", path: "skills/my-notes/SKILL.md" },
      ],
      ignored: [],
    },
    personalSkills: new Map([["pack:personal/my-notes", "---\nname: my-notes\n---\n\n# my-notes\n\nMy first text."]]),
    refuseCopy: null,
    holdCopy: null,
    packListFails: false,
    packListFailsAfterCopy: false,
    readDocFails: null,
  };
}

let fixture: Fixture;
let calls: Array<[string, unknown]>;

function rulesContent(summary: RulesFileSummary): RulesFileContent {
  return { ...summary, before: BEFORE, refinements: fixture.rulesRefinements.get(summary.surface) ?? "", revision: "rev-1" };
}

function ok(action: string, stdout = "saved"): unknown {
  return { success: true, action, stdout, stderr: "", exit_code: 0 };
}

function installBackend() {
  fixture = freshFixture();
  calls = [];
  invoke.mockReset();
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    switch (command) {
      case "list_docs":
        return Promise.resolve([...fixture.docs.values()].map(({ content: _content, ...summary }) => summary));
      case "read_doc":
        if (fixture.readDocFails && args!.id === "README.md") return Promise.reject(new Error(fixture.readDocFails));
        return Promise.resolve(fixture.docs.get(args!.id as string));
      case "save_doc": {
        const doc = fixture.docs.get(args!.id as string)!;
        fixture.docs.set(doc.id, { ...doc, content: args!.content as string });
        return Promise.resolve(ok("save_doc"));
      }
      case "create_doc": {
        const slug = args!.slug as string;
        const doc: DocumentContent = {
          id: `custom:${slug}`,
          title: args!.title as string,
          path: `docs/context/${slug}.md`,
          section: "Docs",
          source: "custom",
          content: `# ${args!.title as string}\n`,
        };
        fixture.docs.set(doc.id, doc);
        return Promise.resolve(doc);
      }
      case "list_skills":
        return Promise.resolve(BUNDLED_SKILLS);
      case "list_pack_skills":
        return fixture.packListFails ? Promise.reject(new Error("packs cannot be listed")) : Promise.resolve(fixture.packs);
      case "copy_skill_to_pack": {
        const newName = args!.newName as string;
        if (fixture.refuseCopy) return Promise.reject(fixture.refuseCopy);
        const id = `pack:personal/${newName}`;
        fixture.personalSkills.set(id, `---\nname: ${newName}\n---\n\n# ${newName}\n\nCopied from ${args!.name as string}.`);
        fixture.packs.skills.push({ id, name: newName, description: "A copy.", pack: "personal", state: "active", reason: "", path: `skills/${newName}/SKILL.md` });
        const made = { id, name: newName, pack: "personal", path: `~/packs/personal/skills/${newName}/SKILL.md` };
        // Listing the packs fails from here on, as in a copy made while the pack folder cannot be read.
        if (fixture.packListFailsAfterCopy) fixture.packListFails = true;
        return fixture.holdCopy ? fixture.holdCopy.then(() => made) : Promise.resolve(made);
      }
      case "save_pack_skill": {
        const id = args!.id as string;
        const unchanged = fixture.personalSkills.get(id) === args!.content;
        fixture.personalSkills.set(id, args!.content as string);
        return Promise.resolve(ok("save_pack_skill", unchanged ? "unchanged" : "saved with backup"));
      }
      case "read_skill": {
        const id = args!.id as string;
        const personal = fixture.personalSkills.get(id);
        if (personal !== undefined) {
          const name = id.slice("pack:personal/".length);
          return Promise.resolve({ id, title: name, path: `~/packs/personal/skills/${name}/SKILL.md`, section: "pack:personal", source: "pack", content: personal });
        }
        return Promise.resolve({ id, title: id, path: `skills/${id}/SKILL.md`, section: "", source: "curated", content: `# ${id} skill\n\nBody of ${id}.` });
      }
      case "forget_pack":
        fixture.packs = { ...fixture.packs, packs: fixture.packs.packs.filter(pack => pack.name !== args!.name) };
        return Promise.resolve(1);
      case "list_agent_metadata":
        return Promise.resolve({ agents: AGENTS, warnings: [] });
      case "read_agent_source":
        return Promise.resolve({ id: args!.filename, title: "verifier", path: "agents/verifier.md", content: "# verifier agent", exists: true });
      case "read_agent_template":
        return Promise.resolve({ id: "template", title: "Rules", path: "templates/rules.md", section: "", source: "curated", content: "# Base rules\n\nShipped text." });
      case "list_rules_files":
        return Promise.resolve(RULES_FILES);
      case "read_rules_file":
        return Promise.resolve(rulesContent(RULES_FILES.find(file => file.surface === args!.surface)!));
      case "save_rules_refinements":
        fixture.rulesRefinements.set(args!.surface as string, args!.content as string);
        return Promise.resolve(ok("save_rules_refinements"));
      case "read_config_template":
        return Promise.resolve({ id: `config-template:${args!.targetId as string}`, title: "config", path: "templates/codex-config.toml", section: "", source: "curated", content: "{\"model\": \"x\"}" });
      case "list_opencode_config_editor_sources":
        return Promise.resolve([]);
      default:
        return Promise.reject(new Error(`unexpected invoke: ${command}`));
    }
  });
}

// ---- the view, wired like the app does it ----

interface HarnessProps {
  showConfigs?: boolean;
  onOpenHarnessView?: (harness: InstallAgent) => void;
  /** The app cannot copy a skill: the rows and sheets offer no "Edit as my copy". */
  withoutCopy?: boolean;
  /** Starts on this topic once the Library has loaded. */
  topic?: "rules" | "skills" | "agents" | "docs" | "configs" | "packs";
}

function Harness({ showConfigs = true, onOpenHarnessView, withoutCopy = false, topic }: HarnessProps) {
  // Like the app's, these are stable: the controller's effects depend on them.
  const generation = useRef({ current: 0 }).current;
  const deps = useRef({
    setError: () => {},
    workspaceLoadGenerationRef: generation,
    isWorkspaceLoadCurrent: (g: number) => g === generation.current,
    isInvalidWorkspaceError: () => false,
    view: "library",
  }).current;
  const lib = useLibraryController(deps);
  const { loadLibraryView, setActiveConfigTargetId, setGuardedLibrarySourceType } = lib;
  useEffect(() => {
    setActiveConfigTargetId("codex_config");
    loadLibraryView();
    if (topic) void setGuardedLibrarySourceType(topic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <LibraryView
      sourceType={lib.librarySourceType}
      onSetSourceType={lib.setGuardedLibrarySourceType}
      docs={lib.docs}
      activeDoc={lib.activeDoc}
      onSelectDoc={lib.selectDoc}
      onOpenDoc={lib.openDocEditor}
      docDraft={lib.docDraft}
      docDirty={lib.docDirty}
      docSaving={lib.docSaving}
      docSaveResult={lib.docSaveResult}
      onChangeDocDraft={lib.onChangeDocDraft}
      onSaveDoc={lib.onSaveDoc}
      onResetDoc={lib.onResetDoc}
      showCreateDoc={lib.showCreateDoc}
      createDocTitle={lib.createDocTitle}
      createDocSlug={lib.createDocSlug}
      createDocError={lib.createDocError}
      createDocCreating={lib.createDocCreating}
      onSetShowCreateDoc={lib.setShowCreateDoc}
      onSetCreateDocTitle={lib.setCreateDocTitle}
      onSetCreateDocSlug={lib.setCreateDocSlug}
      onCreateDoc={lib.onCreateDoc}
      agentTemplate={lib.agentTemplate}
      agentTargets={CONFIG_TARGETS}
      rulesFiles={lib.rulesFiles}
      activeRulesSurface={lib.activeRulesSurface}
      activeRulesFile={lib.activeRulesFile}
      onSelectRulesFile={lib.selectRulesFile}
      onOpenRulesFile={lib.openRulesFile}
      rulesDraft={lib.rulesDraft}
      rulesDirty={lib.rulesDirty}
      rulesSaving={lib.rulesSaving}
      rulesSaveResult={lib.rulesSaveResult}
      onChangeRulesDraft={lib.onChangeRulesDraft}
      onSaveRules={lib.onSaveRules}
      onResetRules={lib.onResetRules}
      skills={lib.skills}
      activeSkillContent={lib.activeSkillContent}
      onSelectSkillPreview={lib.readSkill}
      skillDraft={lib.skillDraft}
      skillDirty={lib.skillDirty}
      skillSaving={lib.skillSaving}
      skillSaveResult={lib.skillSaveResult}
      onChangeSkillDraft={lib.onChangeSkillDraft}
      onSaveSkill={lib.onSaveSkill}
      onResetSkill={lib.onResetSkill}
      onCopySkill={withoutCopy ? undefined : lib.copySkillToPack}
      packLibrary={lib.packLibrary}
      packError={lib.packError}
      onForgetPack={lib.forgetPack}
      agentSources={lib.agentSources}
      activeAgentContent={lib.activeAgentContent}
      onSelectAgent={lib.selectAgent}
      configTemplateContent={lib.configTemplateContent}
      activeConfigTargetId={lib.activeConfigTargetId}
      configTargets={CONFIG_TARGETS}
      onSelectConfigTarget={lib.selectConfigTarget}
      configEditorSources={lib.configEditorSources}
      activeConfigSourceType={lib.activeConfigSourceType}
      onSelectConfigSource={lib.selectConfigSourceType}
      configEditorSourceContent={lib.configEditorSourceContent}
      dataFolderOk
      showConfigs={showConfigs}
      onOpenHarnessView={onOpenHarnessView}
      itemLoadError={lib.itemLoadError}
      onConfirmLeave={lib.confirmLeave}
    />
  );
}

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  // jsdom has no native modal dialog; emulate open/close and the `close` event browsers fire.
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
  installBackend();
});

afterEach(() => {
  cleanup();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

/** A row that only exists once the topic's items have loaded. */
const TOPIC_LOADED: Record<string, string> = {
  rules: "Claude rules",
  skills: "my-checklist",
  agents: "verifier",
  docs: "Notes",
  configs: "Codex config",
  packs: "old-pack",
};

async function renderLibrary(props: HarnessProps = {}): Promise<void> {
  renderInFrame(<Harness {...props} />, { view: "library" });
  await screen.findByText(TOPIC_LOADED[props.topic ?? "rules"]!);
}

function tab(name: string) {
  return screen.getByRole("tab", { name });
}

function rowOf(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find(item => item.querySelector("b")?.textContent === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

async function openSheet(rowName: string, verb: string): Promise<HTMLElement> {
  fireEvent.click(within(rowOf(rowName)).getByRole("button", { name: verb }));
  return screen.findByRole("dialog", { name: new RegExp(rowName, "i") });
}

async function goToTopic(name: string) {
  fireEvent.click(tab(name));
  await waitFor(() => expect(tab(name).getAttribute("aria-selected")).toBe("true"));
}

async function editNotes(text = "# Notes\nunsaved"): Promise<HTMLElement> {
  await goToTopic("Docs");
  const sheet = await openSheet("Notes", "Edit");
  const textarea = await within(sheet).findByRole("textbox", { name: "Edit document" });
  fireEvent.change(textarea, { target: { value: text } });
  await within(sheet).findByText("Unsaved changes");
  return sheet;
}

function callsTo(command: string): Array<Record<string, unknown>> {
  return calls.filter(([name]) => name === command).map(([, args]) => (args ?? {}) as Record<string, unknown>);
}

// ---- tests ----

describe("Library sheet when the item cannot be read", () => {
  it("shows the read error in the sheet instead of a permanent Loading", async () => {
    await renderLibrary();
    await goToTopic("Docs");
    fixture.readDocFails = "doc is gone";
    const sheet = await openSheet("README", "Read");
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toContain("doc is gone");
    expect(within(sheet).queryByText("Loading…")).toBeNull();
  });
});

describe("Library topics", () => {
  it("opens on Rules, lists the topic tabs and switches topic", async () => {
    await renderLibrary();
    expect(screen.getByRole("tablist", { name: "Library topics" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map(item => item.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Rules",
      "Skills",
      "Agents",
      "Docs",
      "Configs",
      "Packs",
    ]);
    expect(tab("Rules").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Your rules files" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Base template" })).toBeTruthy();

    await goToTopic("Skills");
    expect(screen.getByRole("heading", { name: "Yours" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bundled" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your rules files" })).toBeNull();
  });

  it("leaves Configs out when the view does not show configs", async () => {
    await renderLibrary({ showConfigs: false });
    expect(screen.queryByRole("tab", { name: "Configs" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("marks the Rules tab while a rules file needs a decision, and the Packs tab while a pack needs attention", async () => {
    await renderLibrary();
    expect(tab("Rules").getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(tab("Rules").getAttribute("aria-describedby")!)?.textContent).toBe("Needs your decision");
    expect(document.getElementById(tab("Packs").getAttribute("aria-describedby")!)?.textContent).toBe("A pack needs attention");
    expect(tab("Skills").getAttribute("aria-describedby")).toBeNull();
  });

  it("lists rules files with their verbs and sends a conflict to the harness page", async () => {
    const onOpenHarnessView = vi.fn();
    await renderLibrary({ onOpenHarnessView });
    expect(within(rowOf("Claude rules")).getByRole("button", { name: "Edit refinements" })).toBeTruthy();
    expect(within(rowOf("OpenCode rules")).getByRole("button", { name: "Add refinements" })).toBeTruthy();
    const conflict = rowOf("Codex rules");
    expect(within(conflict).getByText("Needs your decision")).toBeTruthy();
    fireEvent.click(within(conflict).getByRole("button", { name: "Open Codex view ›" }));
    expect(onOpenHarnessView).toHaveBeenCalledWith("codex");
  });

  it("shows the pack skills as yours (with the shadowed and missing reasons) and every bundled skill", async () => {
    await renderLibrary();
    await goToTopic("Skills");
    const mine = rowOf("my-checklist");
    expect(within(mine).getByText("A checklist of mine.")).toBeTruthy();
    const shadowed = within(screen.getByRole("heading", { name: "Yours" }).closest("section")!).getAllByRole("listitem")[1]!;
    expect(within(shadowed).getByText("shadowed · bundle wins")).toBeTruthy();
    expect(within(shadowed).getByText(/bundle wins\. Rename it in the pack/)).toBeTruthy();
    const bundled = within(screen.getByRole("heading", { name: "Bundled" }).closest("section")!);
    expect(bundled.getAllByRole("button", { name: "Read" })).toHaveLength(BUNDLED_SKILLS.length);
  });

  it("offers no Edit as my copy while the app cannot make the copy", async () => {
    await renderLibrary({ topic: "skills", withoutCopy: true });
    expect(screen.queryByRole("button", { name: "Edit as my copy" })).toBeNull();
  });

  it("offers Edit on the personal pack's skills and Read on every other pack skill", async () => {
    await renderLibrary({ topic: "skills" });
    expect(within(rowOf("my-notes")).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(rowOf("my-checklist")).getByRole("button", { name: "Read" })).toBeTruthy();
  });

  it("lists bundled agents, docs with a New doc button, and configs", async () => {
    await renderLibrary();
    await goToTopic("Agents");
    expect(within(rowOf("verifier")).getByText("Runs the checks and reports evidence.")).toBeTruthy();
    await goToTopic("Docs");
    const yours = screen.getByRole("heading", { name: "Yours" }).closest("section")!;
    expect(within(yours).getByRole("button", { name: "New doc" })).toBeTruthy();
    expect(within(yours).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(rowOf("README")).getByRole("button", { name: "Read" })).toBeTruthy();
    await goToTopic("Configs");
    expect(within(rowOf("Codex config")).getByRole("button", { name: "View" })).toBeTruthy();
  });

  it("says No packs with the packs folder when there are none", async () => {
    fixture.packs = { folder: "~/.config/riggverk/packs", packs: [], skills: [], ignored: [] };
    await renderLibrary();
    await goToTopic("Packs");
    expect(screen.getByText("No packs")).toBeTruthy();
    expect(screen.getByText("~/.config/riggverk/packs")).toBeTruthy();
    expect(tab("Packs").getAttribute("aria-describedby")).toBeNull();
  });
});

describe("Library search", () => {
  it("searches every topic with a heading per topic, and leaves no tab selected", async () => {
    await renderLibrary();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search all topics" }), { target: { value: "tdd" } });
    const results = await screen.findByRole("region", { name: "Search results" });
    expect(within(results).getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["Skills", "Packs"]);
    expect(within(results).getAllByText("tdd").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("tab").every(item => item.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("says Nothing matches for a search without results, and a topic click ends the search", async () => {
    await renderLibrary();
    const search = screen.getByRole("searchbox", { name: "Search all topics" });
    fireEvent.change(search, { target: { value: "zzzq" } });
    expect(await screen.findByText("Nothing matches “zzzq”.")).toBeTruthy();
    fireEvent.click(tab("Docs"));
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
    expect(tab("Docs").getAttribute("aria-selected")).toBe("true");
  });

  it("opens a result from another topic", async () => {
    await renderLibrary();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search all topics" }), { target: { value: "readme" } });
    const results = await screen.findByRole("region", { name: "Search results" });
    fireEvent.click(within(results).getByRole("button", { name: "Read" }));
    const sheet = await screen.findByRole("dialog", { name: /README/ });
    expect(await within(sheet).findByRole("heading", { name: "Readme" })).toBeTruthy();
  });
});

describe("Library sheet", () => {
  it("opens a read-only item as a modal with its reason and rendered text, and returns focus to the row on Close", async () => {
    await renderLibrary({ topic: "skills" });
    const bundledTdd = within(screen.getByRole("heading", { name: "Bundled" }).closest("section")!).getAllByRole("listitem")[0]!;
    fireEvent.click(within(bundledTdd).getByRole("button", { name: "Read" }));
    const sheet = await screen.findByRole("dialog", { name: /tdd/ });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(await within(sheet).findByText("bundled with the app: read-only here")).toBeTruthy();
    expect(await within(sheet).findByRole("heading", { name: "tdd skill" })).toBeTruthy();
    expect(within(sheet).queryByRole("textbox")).toBeNull();
    expect(sheet.contains(document.activeElement)).toBe(true);

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const bundled = within(screen.getByRole("heading", { name: "Bundled" }).closest("section")!);
    expect(document.activeElement).toBe(bundled.getAllByRole("button", { name: "Read" })[0]);
  });

  it("closes on Escape and on a click on the backdrop", async () => {
    await renderLibrary({ topic: "agents" });
    let sheet = await openSheet("verifier", "Read");
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    sheet = await openSheet("verifier", "Read");
    fireEvent.click(document.querySelector(".lib-sheet-back")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the window's keys out of the sheet, whose own keys still work", async () => {
    const onSwitchView = vi.fn();
    renderInFrame(<Harness topic="agents" />, { view: "library", onSwitchView });
    await screen.findByText(TOPIC_LOADED.agents!);
    const sheet = await openSheet("verifier", "Read");
    const close = within(sheet).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "2" });
    fireEvent.keyDown(close, { key: "?" });
    expect(onSwitchView).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /keyboard/i })).toBeNull();
    fireEvent.keyDown(close, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /verifier/i })).toBeNull());
  });

  it("keeps Tab inside the sheet", async () => {
    await renderLibrary({ topic: "agents" });
    const sheet = await openSheet("verifier", "Read");
    const close = within(sheet).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("edits and saves a personal doc", async () => {
    await renderLibrary();
    const sheet = await editNotes("# Notes\nsecond");
    expect(within(sheet).getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("save_doc")).toEqual([{ id: "custom:notes", content: "# Notes\nsecond" }]));
    await within(sheet).findByText("Saved");
    expect(within(sheet).queryByText("Unsaved changes")).toBeNull();
  });

  it("saves with the save key, and discards back to what is on disk", async () => {
    await renderLibrary();
    const sheet = await editNotes("# Notes\nthird");
    fireEvent.keyDown(within(sheet).getByRole("textbox"), { key: "s", ctrlKey: true });
    await waitFor(() => expect(callsTo("save_doc")).toHaveLength(1));
    await within(sheet).findByText("Saved");

    fireEvent.change(within(sheet).getByRole("textbox"), { target: { value: "changed again" } });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Discard" }));
    await waitFor(() => expect((within(sheet).getByRole("textbox") as HTMLTextAreaElement).value).toBe("# Notes\nthird"));
  });
});

describe("Library unsaved changes", () => {
  it("asks before a topic switch, and Keep editing stays on the topic with the draft", async () => {
    await renderLibrary();
    const sheet = await editNotes();
    fireEvent.click(tab("Skills"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(within(dialog).getByText("Notes has changes you have not saved.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull());
    expect(tab("Docs").getAttribute("aria-selected")).toBe("true");
    expect((within(sheet).getByRole("textbox") as HTMLTextAreaElement).value).toBe("# Notes\nunsaved");
  });

  it("Discard drops the draft and switches the topic", async () => {
    await renderLibrary();
    await editNotes();
    fireEvent.click(tab("Skills"));
    fireEvent.click(await within(await screen.findByRole("dialog", { name: "Unsaved changes" })).findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(tab("Skills").getAttribute("aria-selected")).toBe("true"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsTo("save_doc")).toEqual([]);
    // The draft did not come back: the doc opens as it is on disk.
    await goToTopic("Docs");
    const sheet = await openSheet("Notes", "Edit");
    expect((await within(sheet).findByRole("textbox", { name: "Edit document" }) as HTMLTextAreaElement).value).toBe("# Notes\nfirst");
  });

  it("Save and continue writes the draft, then switches the topic", async () => {
    await renderLibrary();
    await editNotes();
    fireEvent.click(tab("Skills"));
    fireEvent.click(await within(await screen.findByRole("dialog", { name: "Unsaved changes" })).findByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(tab("Skills").getAttribute("aria-selected")).toBe("true"));
    expect(callsTo("save_doc")).toEqual([{ id: "custom:notes", content: "# Notes\nunsaved" }]);
    expect(fixture.docs.get("custom:notes")!.content).toBe("# Notes\nunsaved");
  });

  it("asks before the sheet closes, whether by Close, Escape or the backdrop", async () => {
    await renderLibrary();
    const sheet = await editNotes();
    for (const close of [
      () => fireEvent.click(within(sheet).getByRole("button", { name: "Close" })),
      () => fireEvent.keyDown(sheet, { key: "Escape" }),
      () => fireEvent.click(document.querySelector(".lib-sheet-back")!),
    ]) {
      close();
      const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull());
      expect(screen.getByRole("dialog", { name: /Notes/ })).toBeTruthy();
    }
  });

  it("asks before another item opens", async () => {
    await renderLibrary();
    await editNotes();
    // The sheet is modal for people, but a command can still change the topic and open another item.
    const readme = within(document.querySelector(".lib-main")!).getByRole("button", { name: "Read" });
    fireEvent.click(readme);
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull());
    expect(screen.getByRole("dialog", { name: /Notes/ })).toBeTruthy();
  });
});

describe("Library rules sheet", () => {
  async function openClaude(): Promise<HTMLElement> {
    const sheet = await openSheet("Claude rules", "Edit refinements");
    await within(sheet).findByRole("textbox", { name: /your refinements/i });
    return sheet;
  }

  it("shows the managed block above the refinements, read-only", async () => {
    await renderLibrary();
    const sheet = await openClaude();
    expect(within(sheet).getAllByRole("tab").map(item => item.textContent)).toEqual(["Refinements", "Effective", "Diff against disk"]);
    expect(within(sheet).getByText("managed base · read-only")).toBeTruthy();
    expect(within(sheet).getByLabelText("Managed base").textContent).toBe(BEFORE);
    expect((within(sheet).getByRole("textbox", { name: /your refinements/i }) as HTMLTextAreaElement).value).toBe("\n\n## Mine\nSwedish.\n");
    expect(within(sheet).getByText("Backed up before saving")).toBeTruthy();
  });

  it("points out a section the managed base has too", async () => {
    await renderLibrary();
    const sheet = await openClaude();
    expect(within(sheet).queryByRole("status")).toBeNull();
    fireEvent.change(within(sheet).getByRole("textbox", { name: /your refinements/i }), { target: { value: "\n\n## Verification\nMine.\n" } });
    expect(await within(sheet).findByText(/“Verification” is also a section in the managed base\. The agent reads both; yours comes later in the file\./)).toBeTruthy();
  });

  it("shows the effective file as it will read after saving, and the diff against disk", async () => {
    await renderLibrary();
    const sheet = await openClaude();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Diff against disk" }));
    expect(within(sheet).getByText("No difference against disk.")).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("tab", { name: "Refinements" }));
    fireEvent.change(within(sheet).getByRole("textbox", { name: /your refinements/i }), { target: { value: "\n\n## Mine\nDanish.\n" } });

    fireEvent.click(within(sheet).getByRole("tab", { name: "Effective" }));
    expect(within(sheet).getByLabelText("Effective file").textContent).toBe(`${BEFORE}\n\n## Mine\nDanish.\n`);
    expect(within(sheet).getByText(/after you save/)).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("tab", { name: "Diff against disk" }));
    const diff = within(sheet).getByRole("group", { name: "Refinements against disk" });
    expect(within(diff).getByText("Swedish.").closest(".diff-line")!.classList.contains("remove")).toBe(true);
    expect(within(diff).getByText("Danish.").closest(".diff-line")!.classList.contains("add")).toBe(true);
    expect(within(sheet).queryByText("No difference against disk.")).toBeNull();
  });

  it("saves the refinements with the revision it opened", async () => {
    await renderLibrary();
    const sheet = await openClaude();
    fireEvent.change(within(sheet).getByRole("textbox", { name: /your refinements/i }), { target: { value: "\n\n## Mine\nNorwegian.\n" } });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(callsTo("save_rules_refinements")).toEqual([{ surface: "claude_rules", content: "\n\n## Mine\nNorwegian.\n", expectedRevision: "rev-1" }]),
    );
  });

  it("keeps a conflicting file read-only, explains why and points to the harness view", async () => {
    const onOpenHarnessView = vi.fn();
    await renderLibrary({ onOpenHarnessView });
    const sheet = await openSheet("Codex rules", "View");
    expect(await within(sheet).findByText("Needs your decision")).toBeTruthy();
    expect(within(sheet).getByText(/edited by hand/)).toBeTruthy();
    expect(within(sheet).queryByRole("textbox")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(sheet).getByLabelText("File on disk").textContent).toBe(`${BEFORE}\n\n## Mine\nHand edited.\n`);
    fireEvent.click(within(sheet).getByRole("button", { name: "Open Codex view ›" }));
    expect(onOpenHarnessView).toHaveBeenCalledWith("codex");
  });
});

describe("Library skills of your own", () => {
  function bundledRow(name: string): HTMLElement {
    const section = screen.getByRole("heading", { name: "Bundled" }).closest("section")!;
    return within(section).getAllByRole("listitem").find(item => item.querySelector("b")?.textContent === name)!;
  }

  async function openCopyDialog(skillName = "tdd"): Promise<HTMLElement> {
    fireEvent.click(within(bundledRow(skillName)).getByRole("button", { name: "Edit as my copy" }));
    return screen.findByRole("dialog", { name: "Edit as my copy" });
  }

  it("asks for a name, prefilled, and says what the copy is", async () => {
    await renderLibrary({ topic: "skills" });
    const dialog = await openCopyDialog();
    const name = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("tdd-mine");
    expect(document.activeElement).toBe(name);
    expect(dialog.textContent).toContain(
      "The bundled tdd keeps its name and stays active. Your copy is a new skill in pack:personal that Update installs next to it.",
    );
  });

  it("refuses a bad name before anything is sent: characters, a bundled name, a name a pack has", async () => {
    await renderLibrary({ topic: "skills" });
    const dialog = await openCopyDialog();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    const create = within(dialog).getByRole("button", { name: "Create copy" });
    const tryName = (value: string) => fireEvent.change(name, { target: { value } });

    tryName("Not Valid");
    expect(within(dialog).getByText("Use 1–64 lowercase letters, digits and dashes, and no dash first.")).toBeTruthy();
    expect(create.getAttribute("aria-disabled")).toBe("true");
    tryName("diagnose");
    expect(within(dialog).getByText("A bundled skill is already named diagnose. Choose another name.")).toBeTruthy();
    tryName("my-notes");
    expect(within(dialog).getByText("pack:personal already has my-notes.")).toBeTruthy();
    tryName("my-checklist");
    expect(within(dialog).getByText("A pack already has a skill named my-checklist.")).toBeTruthy();

    fireEvent.click(create);
    fireEvent.submit(dialog.querySelector("form")!);
    await act(async () => {});
    expect(callsTo("copy_skill_to_pack")).toEqual([]);
  });

  it("shows the backend's refusal in the dialog and keeps it open", async () => {
    fixture.refuseCopy = "cannot check skill name collisions while a pack is refused or ignored";
    await renderLibrary({ topic: "skills" });
    const dialog = await openCopyDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create copy" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("cannot check skill name collisions while a pack is refused or ignored");
    expect(screen.getByRole("dialog", { name: "Edit as my copy" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /tdd-mine/ })).toBeNull();
  });

  it("copies the skill, lists it under Yours and opens it in the sheet, ready to edit", async () => {
    await renderLibrary({ topic: "skills" });
    const dialog = await openCopyDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create copy" }));
    await waitFor(() => expect(callsTo("copy_skill_to_pack")).toEqual([{ name: "tdd", newName: "tdd-mine" }]));
    const sheet = await screen.findByRole("dialog", { name: /tdd-mine/ });
    const textarea = (await within(sheet).findByRole("textbox", { name: "Edit skill" })) as HTMLTextAreaElement;
    expect(textarea.value).toContain("Copied from tdd.");
    expect(document.activeElement).toBe(textarea);
    expect(screen.queryByRole("dialog", { name: "Edit as my copy" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeTruthy();
    // The pack library was listed again: the copy is a row of its own, with the Edit verb.
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(rowOf("tdd-mine")).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("offers the copy in the sheet of a bundled skill too", async () => {
    await renderLibrary({ topic: "skills" });
    fireEvent.click(within(bundledRow("diagnose")).getByRole("button", { name: "Read" }));
    const sheet = await screen.findByRole("dialog", { name: /diagnose/ });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Edit as my copy" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit as my copy" });
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("diagnose-mine");
  });

  it("edits and saves a skill of the personal pack, and says Update installs it", async () => {
    await renderLibrary({ topic: "skills" });
    fireEvent.click(within(rowOf("my-notes")).getByRole("button", { name: "Edit" }));
    const sheet = await screen.findByRole("dialog", { name: /my-notes/ });
    const textarea = (await within(sheet).findByRole("textbox", { name: "Edit skill" })) as HTMLTextAreaElement;
    expect(textarea.value).toContain("My first text.");
    expect(within(sheet).getByText("Update installs your saved copy")).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "# my-notes\n\nSecond text." } });
    await within(sheet).findByText("Unsaved changes");
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(callsTo("save_pack_skill")).toEqual([{ id: "pack:personal/my-notes", content: "# my-notes\n\nSecond text." }]),
    );
    await within(sheet).findByText("Saved");
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toBe("Saved · Update installs it"));
  });

  it("guards unsaved skill edits like any other draft", async () => {
    await renderLibrary({ topic: "skills" });
    fireEvent.click(within(rowOf("my-notes")).getByRole("button", { name: "Edit" }));
    const sheet = await screen.findByRole("dialog", { name: /my-notes/ });
    fireEvent.change(await within(sheet).findByRole("textbox", { name: "Edit skill" }), { target: { value: "changed" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(within(dialog).getByText("my-notes has changes you have not saved.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo("save_pack_skill")).toEqual([]);
  });

  it("opens a fresh copy for editing even when the pack list could not be read afterwards", async () => {
    fixture.packListFailsAfterCopy = true;
    await renderLibrary({ topic: "skills" });
    const dialog = await openCopyDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create copy" }));
    const sheet = await screen.findByRole("dialog", { name: /tdd-mine/ });
    expect(await within(sheet).findByRole("textbox", { name: "Edit skill" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Edit as my copy" })).toBeNull();
  });

  it("cannot be closed while the copy is being made", async () => {
    let finish: () => void = () => {};
    fixture.holdCopy = new Promise<void>(resolve => {
      finish = resolve;
    });
    await renderLibrary({ topic: "skills" });
    const dialog = await openCopyDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create copy" }));
    await within(dialog).findByText("Creating…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Edit as my copy" })).toBeTruthy();
    await act(async () => finish());
    expect(await screen.findByRole("dialog", { name: /tdd-mine/ })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Edit as my copy" })).toBeNull();
  });

  it("keeps the other pack skills read-only, with their reason", async () => {
    await renderLibrary({ topic: "skills" });
    fireEvent.click(within(rowOf("my-checklist")).getByRole("button", { name: "Read" }));
    const sheet = await screen.findByRole("dialog", { name: /my-checklist/ });
    expect(await within(sheet).findByText("from a skill pack: read-only here, edit it in the pack folder")).toBeTruthy();
    expect(within(sheet).queryByRole("textbox")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("Library new doc", () => {
  it("shows the file the title becomes, and opens the new doc for editing", async () => {
    await renderLibrary();
    await goToTopic("Docs");
    fireEvent.click(screen.getByRole("button", { name: "New doc" }));
    const dialog = await screen.findByRole("dialog", { name: "New doc" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    expect(document.activeElement).toBe(title);
    expect(dialog.querySelector(".lib-slug")!.textContent).toBe("docs/context/….md");
    expect(within(dialog).getByRole("button", { name: "Create" }).getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(title, { target: { value: "Release ritual" } });
    expect(dialog.querySelector(".lib-slug")!.textContent).toBe("docs/context/release-ritual.md");

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(callsTo("create_doc")).toEqual([{ title: "Release ritual", slug: "release-ritual", content: null }]));
    const sheet = await screen.findByRole("dialog", { name: /Release ritual/ });
    const textarea = await within(sheet).findByRole("textbox", { name: "Edit document" });
    expect((textarea as HTMLTextAreaElement).value).toBe("# Release ritual\n");
    expect(screen.queryByRole("dialog", { name: "New doc" })).toBeNull();
  });

  it("says why Create is dead when the title has no letter a-z or digit, and offers a neutral example", async () => {
    await renderLibrary();
    await goToTopic("Docs");
    fireEvent.click(screen.getByRole("button", { name: "New doc" }));
    const dialog = await screen.findByRole("dialog", { name: "New doc" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    expect(title.getAttribute("placeholder")).toBe("Project notes");
    expect(within(dialog).queryByRole("status")).toBeNull();

    fireEvent.change(title, { target: { value: "日本語" } });
    const hint = within(dialog).getByRole("status");
    expect(hint.textContent).toContain("Use at least one letter a-z or digit");
    expect(title.getAttribute("aria-describedby")).toContain(hint.id);
    expect(within(dialog).getByRole("button", { name: "Create" }).getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(title, { target: { value: "日本語 notes" } });
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  it("leaves the title alone when Mod+N is pressed inside the dialog", async () => {
    await renderLibrary();
    await goToTopic("Docs");
    fireEvent.click(screen.getByRole("button", { name: "New doc" }));
    const dialog = await screen.findByRole("dialog", { name: "New doc" });
    const title = within(dialog).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Release ritual" } });
    fireEvent.keyDown(title, { key: "n", ctrlKey: true });
    await act(async () => {});
    expect(title.value).toBe("Release ritual");
    expect(document.activeElement).toBe(title);
  });

  it("closes on Cancel without creating anything", async () => {
    await renderLibrary();
    await goToTopic("Docs");
    fireEvent.click(screen.getByRole("button", { name: "New doc" }));
    const dialog = await screen.findByRole("dialog", { name: "New doc" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New doc" })).toBeNull());
    expect(callsTo("create_doc")).toEqual([]);
  });
});

describe("Library packs", () => {
  it("asks before it forgets a pack, and only forgets once confirmed", async () => {
    await renderLibrary();
    await goToTopic("Packs");
    fireEvent.click(within(rowOf("old-pack")).getByRole("button", { name: "Forget pack" }));
    let dialog = await screen.findByRole("dialog", { name: "Forget pack old-pack?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo("forget_pack")).toEqual([]);

    fireEvent.click(within(rowOf("old-pack")).getByRole("button", { name: "Forget pack" }));
    dialog = await screen.findByRole("dialog", { name: "Forget pack old-pack?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget pack" }));
    await waitFor(() => expect(callsTo("forget_pack")).toEqual([{ name: "old-pack" }]));
    await waitFor(() => expect(screen.queryAllByRole("listitem").some(item => item.querySelector("b")?.textContent === "old-pack")).toBe(false));
  });
});

describe("Library packs focus", () => {
  it("moves focus to a row (or the tab) after a pack is forgotten, not to the page", async () => {
    await renderLibrary();
    await goToTopic("Packs");
    const button = within(rowOf("old-pack")).getByRole("button", { name: "Forget pack" });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Forget pack old-pack?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget pack" }));
    await waitFor(() => expect(screen.queryAllByRole("listitem").some(item => item.querySelector("b")?.textContent === "old-pack")).toBe(false));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    const library = screen.getByRole("region", { name: "Library" });
    expect(library.contains(document.activeElement)).toBe(true);
  });

  it("leaves focus alone when the forget is declined", async () => {
    await renderLibrary();
    await goToTopic("Packs");
    const button = within(rowOf("old-pack")).getByRole("button", { name: "Forget pack" });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Forget pack old-pack?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callsTo("forget_pack")).toEqual([]);
  });
});

describe("Library keys", () => {
  it("/ and Mod+F focus the search, [ and ] step through the topics", async () => {
    await renderLibrary();
    const search = screen.getByRole("searchbox", { name: "Search all topics" });
    const row = within(rowOf("Claude rules")).getByRole("button", { name: "Edit refinements" });
    row.focus();
    fireEvent.keyDown(row, { key: "/" });
    expect(document.activeElement).toBe(search);

    row.focus();
    fireEvent.keyDown(row, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(search);

    row.focus();
    fireEvent.keyDown(row, { key: "]" });
    await waitFor(() => expect(tab("Skills").getAttribute("aria-selected")).toBe("true"));
    const skillRow = within(rowOf("my-checklist")).getByRole("button", { name: "Read" });
    skillRow.focus();
    fireEvent.keyDown(skillRow, { key: "[" });
    await waitFor(() => expect(tab("Rules").getAttribute("aria-selected")).toBe("true"));
    // The row that had focus is gone with the old rows: the selected tab has it, so the keys keep working.
    expect(document.activeElement).toBe(tab("Rules"));
    fireEvent.keyDown(document.activeElement!, { key: "[" });
    await waitFor(() => expect(tab("Packs").getAttribute("aria-selected")).toBe("true"));
  });

  it("moves between rows with the arrow keys, and an Enter on a row opens it", async () => {
    await renderLibrary();
    const first = within(rowOf("Claude rules")).getByRole("button", { name: "Edit refinements" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(rowOf("Codex rules")).getByRole("button", { name: "View" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(rowOf("OpenCode rules")).getByRole("button", { name: "Add refinements" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(tab("Rules"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    // Enter on a focused button is a click.
    fireEvent.click(document.activeElement!);
    expect(await screen.findByRole("dialog", { name: /Claude rules/ })).toBeTruthy();
  });

  it("Mod+N opens New doc, and the sheet's own keys leave the rows alone", async () => {
    await renderLibrary();
    const row = within(rowOf("Claude rules")).getByRole("button", { name: "Edit refinements" });
    row.focus();
    fireEvent.keyDown(row, { key: "n", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "New doc" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Title" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New doc" })).toBeNull());
  });

  it("is quiet about the topic keys while the sheet is open", async () => {
    await renderLibrary({ topic: "agents" });
    const sheet = await openSheet("verifier", "Read");
    fireEvent.keyDown(sheet, { key: "]" });
    await act(async () => {});
    // The content behind the sheet is inert, so it is read from the DOM rather than through roles.
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe("Agents");
  });
});
