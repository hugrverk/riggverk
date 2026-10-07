import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentMetadataResponse,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocsHealth,
  DocSummary,
  DocumentContent,
  SkillSummary,
} from "../types";
import { renderInFrame } from "../test/renderWithShell";
import { LibraryView } from "./LibraryView";

type LibraryViewProps = ComponentProps<typeof LibraryView>;

function baseProps(overrides: Partial<LibraryViewProps> = {}): LibraryViewProps {
  const noop = () => {};
  return {
    sourceType: "docs",
    onSetSourceType: noop,
    docs: [],
    docsHealth: null,
    onGoToWorkspaceRepair: noop,
    activeDoc: null,
    onSelectDoc: noop,
    onOpenDoc: noop,
    docDraft: "",
    docDirty: false,
    docSaving: false,
    docSaveResult: null,
    docMode: "preview",
    onSetDocMode: noop,
    onChangeDocDraft: noop,
    onSaveDoc: noop,
    onResetDoc: noop,
    showCreateDoc: false,
    createDocTitle: "",
    createDocSlug: "",
    createDocError: null,
    createDocCreating: false,
    onSetShowCreateDoc: noop,
    onSetCreateDocTitle: noop,
    onSetCreateDocSlug: noop,
    onCreateDoc: noop,
    agentTemplate: null,
    onOpenTemplate: noop,
    agentTemplateDraft: "",
    agentTemplateDirty: false,
    agentTemplateSaving: false,
    agentTemplateSaveResult: null,
    agentTemplateMode: "preview",
    onSetAgentTemplateMode: noop,
    onChangeAgentTemplateDraft: noop,
    onSaveAgentTemplate: noop,
    onResetAgentTemplate: noop,
    agentTargets: [],
    skills: [],
    activeSkillId: null,
    activeSkillContent: null,
    skillSearch: "",
    onSetSkillSearch: noop,
    onSelectSkillPreview: noop,
    onOpenSkill: noop,
    agentSources: [],
    activeAgentId: null,
    activeAgentContent: null,
    onSelectAgent: noop,
    onOpenAgent: noop,
    agentDraft: "",
    agentDirty: false,
    agentSaving: false,
    agentSaveResult: null,
    agentMode: "preview",
    onSetAgentMode: noop,
    onChangeAgentDraft: noop,
    onSaveAgent: noop,
    onResetAgent: noop,
    configTemplateContent: null,
    activeConfigTargetId: "",
    configTargets: [],
    onSelectConfigTarget: noop,
    onOpenConfig: noop,
    configDraft: "",
    configDirty: false,
    configSaving: false,
    configSaveResult: null,
    configMode: "preview",
    onSetConfigMode: noop,
    onChangeConfigDraft: noop,
    onSaveConfig: noop,
    onResetConfig: noop,
    configEditorSources: [],
    activeConfigSourceType: "base",
    onSelectConfigSource: noop,
    configEditorSourceSaveMessage: "",
    configEditorSourceContent: null,
    brainSetupText: "",
    brainSetupSource: "",
    workspaceValid: true,
    showConfigs: true,
    ...overrides,
  };
}

function makeDoc(id: string, title: string, content: string): DocumentContent {
  return { id, title, path: `docs/${id}.md`, section: "docs", source: "workspace", content };
}

function renderLibrary(overrides: Partial<LibraryViewProps> = {}) {
  const result = renderInFrame(<LibraryView {...baseProps(overrides)} />, { view: "library" });
  return {
    ...result,
    update: (next: Partial<LibraryViewProps>) => result.rerenderFrame(<LibraryView {...baseProps(next)} />),
  };
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key, ...init });
}

function listbox() {
  return screen.getByRole("listbox");
}

function cursorName(): string | null {
  const id = listbox().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".nm")?.textContent ?? null : null;
}

function selectedNames(): string[] {
  return within(listbox())
    .getAllByRole("option")
    .filter(option => option.getAttribute("aria-selected") === "true")
    .map(option => option.querySelector(".nm")!.textContent!);
}

function statusBarText(): string | null {
  return document.querySelector(".statusbar .ctx")!.textContent;
}

function focusList() {
  act(() => listbox().focus());
  return listbox();
}

function textarea(label?: string) {
  return (label ? screen.getByLabelText(label) : screen.getByRole("textbox")) as HTMLTextAreaElement;
}

function runCommand(line: string) {
  press(document.activeElement ?? document.body, ":", { shiftKey: true });
  const input = screen.getByRole("combobox", { name: "Command" });
  fireEvent.change(input, { target: { value: line } });
  press(input, "Enter");
}

const docs: DocSummary[] = [
  { id: "a", title: "Alpha", section: "Bundled", path: "docs/alpha.md", source: "bundled" },
  { id: "b", title: "Beta notes", section: "Context", path: "docs/context/beta.md", source: "custom" },
  { id: "c", title: "Gamma", section: "Bundled", path: "docs/gamma.md", source: "bundled" },
];

describe("LibraryView layout", () => {
  it("renders items, editor and preview panes with the source switcher and counts", () => {
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", "# A"), docDraft: "# A" });
    expect(screen.getByRole("region", { name: "Library items" }).getAttribute("data-pane-id")).toBe("items");
    expect(screen.getByRole("region", { name: "Editor" }).getAttribute("data-pane-id")).toBe("editor");
    expect(screen.getByRole("region", { name: "Preview" }).getAttribute("data-pane-id")).toBe("preview");
    const group = screen.getByRole("group", { name: "Library source type" });
    expect(within(group).getAllByRole("button").map(button => button.textContent)).toEqual([
      "docs 3",
      "rules",
      "skills",
      "agents",
      "configs",
      "brain",
    ]);
    expect(within(group).getByRole("button", { name: /^docs/ }).getAttribute("aria-current")).toBe("true");
  });

  it("hides the configs source while no editable config target is enabled", () => {
    renderLibrary({ showConfigs: false });
    const group = screen.getByRole("group", { name: "Library source type" });
    expect(within(group).queryByRole("button", { name: /configs/ })).toBeNull();
  });

  it("shows the source as status-bar context", () => {
    renderLibrary({ sourceType: "skills" });
    expect(statusBarText()).toBe("library › skills");
  });

  it("shows the editor and preview empty states while nothing is open", () => {
    renderLibrary({ docs });
    expect(screen.getByText("Select a document to preview")).not.toBeNull();
    expect(screen.getByText("Nothing to preview")).not.toBeNull();
  });
});

describe("LibraryView Configs pane", () => {
  const configTargets: AgentTargetMeta[] = [
    { id: "opencode_config", label: "OpenCode config", harness: "opencode", kind: "config", source_rel: "templates/opencode.base.json", target_rel: "opencode.json" },
    { id: "codex_config", label: "Codex config", harness: "codex", kind: "config", source_rel: "templates/codex.toml", target_rel: "config.toml" },
  ];
  const sources: ConfigEditorSourceMeta[] = [
    { id: "base", label: "Base", rel_path: "templates/opencode.base.json", editable: true, helper: "bundled base" },
    { id: "policy", label: "Policy", rel_path: "templates/opencode.policy.json", editable: true, helper: "overrides" },
    { id: "snapshot", label: "Snapshot", rel_path: "templates/opencode.json", editable: false, helper: "generated" },
  ];

  it("shows the editor source content for opencode_config", () => {
    const content = makeDoc("base", "base", '{"opencode_marker": true}');
    renderLibrary({
      sourceType: "configs",
      configTargets,
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      configTemplateContent: null,
      configEditorSourceContent: content,
      configDraft: content.content,
    });
    expect(textarea("Edit config source").value).toContain("opencode_marker");
    // The preview shows the same text pretty-printed.
    expect(document.querySelector(".configs-code")!.textContent).toContain('"opencode_marker": true');
    expect(screen.queryByText("Select a config target to preview")).toBeNull();
    // The bundle summary is gated on the same active content.
    expect(screen.getByRole("region", { name: "bundle" })).not.toBeNull();
  });

  it("shows a loading state for opencode_config and then renders content", () => {
    const props: Partial<LibraryViewProps> = {
      sourceType: "configs",
      configTargets,
      activeConfigTargetId: "opencode_config",
      configEditorSourceContent: null,
    };
    const { update } = renderLibrary(props);
    expect(screen.getByText("Loading config source...")).not.toBeNull();

    const loaded = makeDoc("base", "base", '{"loaded_marker": 1}');
    update({ ...props, configEditorSourceContent: loaded, configDraft: loaded.content });
    expect(textarea("Edit config source").value).toContain("loaded_marker");
  });

  it("shows the template content for other config targets as a read-only preview", () => {
    const template = makeDoc("codex", "codex", 'model = "template_marker"');
    renderLibrary({
      sourceType: "configs",
      configTargets,
      activeConfigTargetId: "codex_config",
      configTemplateContent: template,
      configDraft: template.content,
    });
    const editor = textarea("Edit config source");
    expect(editor.value).toContain("template_marker");
    expect(editor.readOnly).toBe(true);
    expect(screen.queryByRole("region", { name: "bundle" })).toBeNull();
  });

  it("keeps the empty hint when a non-opencode target has no template yet", () => {
    renderLibrary({
      sourceType: "configs",
      configTargets,
      activeConfigTargetId: "codex_config",
      configTemplateContent: null,
    });
    expect(screen.getByText("Select a config target to preview")).not.toBeNull();
  });

  it("lists the editor sources of opencode_config, marks the active one and flags the read-only snapshot", () => {
    const content = makeDoc("policy", "policy", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [configTargets[0]!],
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      activeConfigSourceType: "policy",
      configEditorSourceContent: content,
      configDraft: "{}",
    });
    expect(within(listbox()).getAllByRole("option").map(option => option.querySelector(".nm")!.textContent)).toEqual([
      "OpenCode config",
      "Base",
      "Policy",
      "Snapshot",
    ]);
    expect(selectedNames()).toEqual(["Policy"]);
    expect(screen.getByText("read-only")).not.toBeNull();
  });

  it("opens a source after the cursor rests on it, and never re-selects the active target", () => {
    vi.useFakeTimers();
    const onSelectConfigSource = vi.fn();
    const onSelectConfigTarget = vi.fn();
    const content = makeDoc("base", "base", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [configTargets[0]!],
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      configEditorSourceContent: content,
      configDraft: "{}",
      onSelectConfigSource,
      onSelectConfigTarget,
    });
    const list = focusList();
    // Cursor starts on the open source (Base); k reaches the target row, which must not reset the source.
    press(list, "k");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSelectConfigTarget).not.toHaveBeenCalled();
    expect(onSelectConfigSource).not.toHaveBeenCalled();
    press(list, "j");
    press(list, "j");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSelectConfigSource).toHaveBeenCalledWith("policy");
  });

  it("treats the generated snapshot as read-only: no save, editor marked read-only", () => {
    const onSaveConfig = vi.fn();
    const content = makeDoc("snapshot", "snapshot", '{"snap": 1}');
    renderLibrary({
      sourceType: "configs",
      configTargets: [configTargets[0]!],
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      activeConfigSourceType: "snapshot",
      configEditorSourceContent: content,
      configDraft: content.content,
      onSaveConfig,
    });
    expect(textarea("Edit config source").readOnly).toBe(true);
    expect(screen.getByText("generated snapshot: edit Base or Policy instead")).not.toBeNull();
    press(textarea("Edit config source"), "s", { ctrlKey: true });
    expect(onSaveConfig).not.toHaveBeenCalled();
  });

  it("saves the opencode source with Mod+s when it has unsaved edits", () => {
    const onSaveConfig = vi.fn();
    const content = makeDoc("base", "base", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [configTargets[0]!],
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      configEditorSourceContent: content,
      configDraft: '{"x": 1}',
      configDirty: true,
      onSaveConfig,
    });
    press(textarea("Edit config source"), "s", { ctrlKey: true });
    expect(onSaveConfig).toHaveBeenCalledTimes(1);
  });

  it("shows the save message of the opencode source", () => {
    const content = makeDoc("base", "base", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [configTargets[0]!],
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      configEditorSourceContent: content,
      configDraft: "{}",
      configEditorSourceSaveMessage: "saved. Use Workspace → generate to update snapshot.",
    });
    expect(screen.getByText(/Use Workspace → generate/)).not.toBeNull();
  });
});

describe("LibraryView Docs list", () => {
  it("groups documents by section, marks the open doc and tags custom context docs", () => {
    renderLibrary({ docs, activeDoc: makeDoc("b", "Beta notes", ""), docDraft: "" });
    const groups = Array.from(listbox().querySelectorAll("li.group")).map(el => el.textContent);
    expect(groups).toEqual(["Bundled", "Context"]);
    expect(within(listbox()).getAllByRole("option").map(option => option.querySelector(".nm")!.textContent)).toEqual([
      "Alpha",
      "Gamma",
      "Beta notes",
    ]);
    expect(selectedNames()).toEqual(["Beta notes"]);
    expect(cursorName()).toBe("Beta notes");
    expect(screen.getByText("context")).not.toBeNull();
  });

  it("filters the list by the search box", () => {
    renderLibrary({ docs });
    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "alp" } });
    expect(screen.getByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta notes")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "zzz" } });
    expect(screen.getByText("No documents match the current filter.")).not.toBeNull();
  });

  it("selects a document when its row is clicked, after the selection delay", () => {
    vi.useFakeTimers();
    const onSelectDoc = vi.fn();
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", ""), onSelectDoc });
    fireEvent.click(screen.getByRole("option", { name: /Beta notes/ }));
    expect(onSelectDoc).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onSelectDoc).toHaveBeenCalledTimes(1);
    expect(onSelectDoc).toHaveBeenCalledWith("b");
  });

  it("shows the stale banner only for a valid workspace with missing bundled docs", () => {
    const health: DocsHealth = { missing_count: 2, missing_prompt_template_docs: false, missing_sample: [] };
    const { update } = renderLibrary({ docs, docsHealth: health, workspaceValid: true });
    expect(screen.getByText("Bundled docs need update")).not.toBeNull();

    update({ docs, docsHealth: health, workspaceValid: false });
    expect(screen.queryByText("Bundled docs need update")).toBeNull();

    update({ docs, docsHealth: { ...health, missing_count: 0 }, workspaceValid: true });
    expect(screen.queryByText("Bundled docs need update")).toBeNull();
  });

  it("sends the stale banner action to the workspace repair page", () => {
    const onGoToWorkspaceRepair = vi.fn();
    const health: DocsHealth = { missing_count: 1, missing_prompt_template_docs: true, missing_sample: [] };
    renderLibrary({ docs, docsHealth: health, onGoToWorkspaceRepair });
    expect(screen.getByText(/Prompt Templates and other bundled docs are missing/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "open workspace update" }));
    expect(onGoToWorkspaceRepair).toHaveBeenCalledTimes(1);
  });

  it("explains an empty or invalid workspace instead of listing", () => {
    const { update } = renderLibrary({ docs: [] });
    expect(screen.getByText("No docs found")).not.toBeNull();
    update({ docs, workspaceValid: false });
    expect(screen.getByText("No valid workspace")).not.toBeNull();
  });
});

describe("LibraryView source switching", () => {
  it("steps through the sources with ] and [ (and < / > on layouts where brackets need Alt), wrapping around", () => {
    const onSetSourceType = vi.fn();
    const { update } = renderLibrary({ docs, onSetSourceType });
    const list = focusList();
    press(list, "]");
    expect(onSetSourceType).toHaveBeenLastCalledWith("rules");
    press(list, ">");
    expect(onSetSourceType).toHaveBeenLastCalledWith("rules");
    press(list, "[");
    expect(onSetSourceType).toHaveBeenLastCalledWith("brain");
    press(list, "<");
    expect(onSetSourceType).toHaveBeenLastCalledWith("brain");

    update({ sourceType: "brain", onSetSourceType, brainSetupText: "text", brainSetupSource: "src" });
    press(screen.getByRole("listbox"), "]");
    expect(onSetSourceType).toHaveBeenLastCalledWith("docs");
  });

  it("skips configs while it is hidden", () => {
    const onSetSourceType = vi.fn();
    renderLibrary({ sourceType: "agents", showConfigs: false, onSetSourceType, agentSources: [] });
    press(screen.getByRole("button", { name: /^agents/ }), "]");
    expect(onSetSourceType).toHaveBeenLastCalledWith("brain");
  });

  it("switches source with the clickable source buttons", () => {
    const onSetSourceType = vi.fn();
    renderLibrary({ onSetSourceType });
    fireEvent.click(screen.getByRole("button", { name: /^skills/ }));
    expect(onSetSourceType).toHaveBeenCalledWith("skills");
  });

  it("does not switch source while a text field has focus", () => {
    const onSetSourceType = vi.fn();
    renderLibrary({ docs, onSetSourceType });
    const filter = screen.getByLabelText("Filter documents");
    act(() => filter.focus());
    press(filter, "]");
    expect(onSetSourceType).not.toHaveBeenCalled();
  });

  it("puts focus back on the list when the list was replaced by another source's list", () => {
    const skill: SkillSummary = { id: "s", name: "tdd", description: "", path: "", group: "g", category: "", risk: "low", targets: [], related: [] };
    const { update } = renderLibrary({ docs });
    focusList();
    update({ sourceType: "skills", skills: [skill] });
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Skills" }));
  });
});

describe("LibraryView list and filter keys", () => {
  it("focuses the filter with / and returns to the list with Escape, which then clears the filter", () => {
    renderLibrary({ docs });
    const list = focusList();
    press(list, "/");
    const filter = screen.getByLabelText("Filter documents") as HTMLInputElement;
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "gam" } });
    press(filter, "Escape");
    expect(document.activeElement).toBe(listbox());
    expect(within(listbox()).getAllByRole("option")).toHaveLength(1);
    press(listbox(), "Escape");
    expect(filter.value).toBe("");
    expect(within(listbox()).getAllByRole("option")).toHaveLength(3);
  });

  it("filters skills by name, category, targets and related, and runtime agents by title and role", () => {
    const skills: SkillSummary[] = [
      { id: "tdd", name: "tdd", description: "red green", path: "", group: "workflow", category: "testing", risk: "low", targets: ["codex"], related: ["diagnose"] },
      { id: "fd", name: "frontend-design", description: "ui", path: "", group: "frontend", category: "design", risk: "medium", targets: ["claude"], related: [] },
    ];
    const { update } = renderLibrary({ sourceType: "skills", skills });
    expect(Array.from(listbox().querySelectorAll("li.group")).map(el => el.textContent)).toEqual(["workflow", "frontend"]);
    const onSetSkillSearch = vi.fn();
    update({ sourceType: "skills", skills, skillSearch: "diagnose", onSetSkillSearch });
    expect(within(listbox()).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("tdd")).not.toBeNull();

    const agents: AgentMetadataResponse[] = [
      { id: "a.md", title: "verifier", path: "agents/a.md", exists: true, metadata: { role: "verification", summary: "", targets: [], risk: "low", default_skills: [], safe_to_edit_runtime: true, notes: [] } },
      { id: "b.md", title: "planner", path: "agents/b.md", exists: false, metadata: null },
    ];
    update({ sourceType: "agents", agentSources: agents });
    fireEvent.change(screen.getByLabelText("Filter agents"), { target: { value: "verif" } });
    expect(within(listbox()).getAllByRole("option")).toHaveLength(1);
  });

  it("flags agents that are not in the workspace", () => {
    const agents: AgentMetadataResponse[] = [
      { id: "b.md", title: "planner", path: "agents/b.md", exists: false, metadata: null },
    ];
    renderLibrary({ sourceType: "agents", agentSources: agents });
    expect(screen.getByText("not in ws")).not.toBeNull();
  });

  it("moves the cursor to a new doc once its row is in the list", () => {
    const created = { id: "n", title: "Notes", section: "Context", path: "docs/context/n.md", source: "custom" };
    const { update } = renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", "") });
    update({ docs, activeDoc: makeDoc("n", "Notes", "") });
    expect(cursorName()).toBe("Alpha");
    update({ docs: [...docs, created], activeDoc: makeDoc("n", "Notes", "") });
    expect(cursorName()).toBe("Notes");
    expect(selectedNames()).toEqual(["Notes"]);
  });

  it("follows an outside change of the open item with the cursor", () => {
    const { update } = renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", "") });
    expect(cursorName()).toBe("Alpha");
    update({ docs, activeDoc: makeDoc("c", "Gamma", "") });
    expect(cursorName()).toBe("Gamma");
    expect(selectedNames()).toEqual(["Gamma"]);
  });
});

describe("LibraryView debounced selection", () => {
  it("opens the row the cursor rests on once, not one per key press", () => {
    vi.useFakeTimers();
    const onSelectDoc = vi.fn();
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", ""), onSelectDoc });
    const list = focusList();
    press(list, "j");
    expect(cursorName()).toBe("Gamma");
    act(() => {
      vi.advanceTimersByTime(60);
    });
    press(list, "j");
    expect(cursorName()).toBe("Beta notes");
    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(onSelectDoc).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSelectDoc).toHaveBeenCalledTimes(1);
    expect(onSelectDoc).toHaveBeenCalledWith("b");
  });

  it("does not open anything when the cursor returns to the open row", () => {
    vi.useFakeTimers();
    const onSelectDoc = vi.fn();
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", ""), onSelectDoc });
    const list = focusList();
    press(list, "j");
    press(list, "k");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onSelectDoc).not.toHaveBeenCalled();
  });

  it("only moves the cursor while the open item has unsaved edits, and opens a row on Enter", () => {
    vi.useFakeTimers();
    const onSelectDoc = vi.fn();
    renderLibrary({
      docs,
      activeDoc: makeDoc("a", "Alpha", "saved"),
      docDraft: "edited",
      docDirty: true,
      onSelectDoc,
    });
    const list = focusList();
    press(list, "j");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(cursorName()).toBe("Gamma");
    expect(selectedNames()).toEqual(["Alpha"]);
    expect(onSelectDoc).not.toHaveBeenCalled();

    press(list, "Enter");
    expect(onSelectDoc).toHaveBeenCalledWith("c");
  });

  it("opens a skill's content through the skill selection handler", () => {
    vi.useFakeTimers();
    const onSelectSkillPreview = vi.fn();
    const skills: SkillSummary[] = [
      { id: "one", name: "one", description: "", path: "", group: "g", category: "", risk: "", targets: [], related: [] },
      { id: "two", name: "two", description: "", path: "", group: "g", category: "", risk: "", targets: [], related: [] },
    ];
    renderLibrary({ sourceType: "skills", skills, activeSkillId: "one", onSelectSkillPreview });
    const list = focusList();
    press(list, "j");
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onSelectSkillPreview).toHaveBeenCalledWith("two");
  });
});

describe("LibraryView editor", () => {
  const doc = makeDoc("a", "Alpha", "# Saved heading");

  it("shows the open doc in the editor pane title with its path, and a modified marker while dirty", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const title = screen.getByRole("region", { name: "Editor" }).querySelector(".pane-title")!;
    expect(title.textContent).toBe("Alpha · docs/a.md");
    update({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true });
    expect(title.textContent).toBe("Alpha · docs/a.md · modified");
  });

  it("moves into the editor with Enter or i from the list, and Escape returns to the list", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const list = focusList();
    press(list, "Enter");
    const editor = textarea("Edit document");
    expect(document.activeElement).toBe(editor);

    press(editor, "Escape");
    expect(document.activeElement).toBe(listbox());

    press(listbox(), "i");
    expect(document.activeElement).toBe(editor);
  });

  it("lands on the editor pane in NORMAL mode with l, so a further l moves on instead of typing", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const list = focusList();
    press(list, "l");
    const editorPane = screen.getByRole("region", { name: "Editor" });
    expect(document.activeElement).toBe(editorPane.querySelector(".lib-editor"));
    expect(document.activeElement).not.toBe(textarea("Edit document"));
    press(document.activeElement!, "l");
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Preview" }));
    press(document.activeElement!, "h");
    press(document.activeElement!, "h");
    expect(document.activeElement).toBe(listbox());
    press(editorPane.querySelector(".lib-editor")!, "i");
    expect(document.activeElement).toBe(textarea("Edit document"));
  });

  it("does not run list keys while typing in the editor", () => {
    const onSetSourceType = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSetSourceType });
    const editor = textarea("Edit document");
    act(() => editor.focus());
    press(editor, "]");
    press(editor, "i");
    press(editor, "j");
    expect(onSetSourceType).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("opens the row and then moves into the editor when Enter is pressed before the selection landed", () => {
    const onSelectDoc = vi.fn();
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSelectDoc });
    const list = focusList();
    press(list, "j");
    press(list, "Enter");
    expect(onSelectDoc).toHaveBeenCalledWith("c");
    expect(document.activeElement).toBe(list);

    const next = makeDoc("c", "Gamma", "# Gamma");
    update({ docs, activeDoc: next, docDraft: next.content, onSelectDoc });
    expect(document.activeElement).toBe(textarea("Edit document"));
  });

  it("reports edits through the draft handler", () => {
    const onChangeDocDraft = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onChangeDocDraft });
    fireEvent.change(textarea("Edit document"), { target: { value: "# New" } });
    expect(onChangeDocDraft).toHaveBeenCalledWith("# New");
  });

  it("renders the preview from the draft, not from the saved content", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(within(preview).getByRole("heading", { name: "Saved heading" })).not.toBeNull();
    update({ docs, activeDoc: doc, docDraft: "# Draft heading", docDirty: true });
    expect(within(preview).getByRole("heading", { name: "Draft heading" })).not.toBeNull();
    expect(within(preview).queryByRole("heading", { name: "Saved heading" })).toBeNull();
  });

  it("renders tables and links in the preview", () => {
    const content = "Paragraph with [safe link](https://example.com).\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", content), docDraft: content });
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(preview.querySelector(".lib-docs-markdown")).not.toBeNull();
    expect(preview.querySelector("table")).not.toBeNull();
    expect(preview.querySelector("a[href='https://example.com']")).not.toBeNull();
  });

  it("leaves YAML front matter out of the rendered preview but keeps it in the editor", () => {
    const content = "---\nname: tdd\ndescription: Red green\n---\n\n# Tdd\n\nBody.";
    const skill: SkillSummary = { id: "tdd", name: "tdd", description: "Red green", path: "", group: "g", category: "testing", risk: "low", targets: ["codex"], related: [] };
    renderLibrary({
      sourceType: "skills",
      skills: [skill],
      activeSkillId: "tdd",
      activeSkillContent: { id: "tdd", title: "tdd", path: "skills/tdd/SKILL.md", section: "skills", source: "workspace", content },
    });
    const preview = screen.getByRole("region", { name: "Preview" });
    expect(preview.querySelector("hr")).toBeNull();
    expect(within(preview).getByRole("heading", { name: "Tdd" })).not.toBeNull();
    expect(textarea("Skill source").value).toBe(content);
  });

  it("opens the item externally from the list key and from the editor footer", () => {
    const onOpenDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onOpenDoc });
    press(focusList(), "o");
    expect(onOpenDoc).toHaveBeenCalledWith("a");
    fireEvent.click(within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: /open/ }));
    expect(onOpenDoc).toHaveBeenCalledTimes(2);
  });

  it("offers copy path in the editor footer", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    expect(within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: "Copy path" })).not.toBeNull();
  });

  it("marks skills read-only: readOnly textarea, marker, no save, open externally", () => {
    const onOpenSkill = vi.fn();
    const onSaveDoc = vi.fn();
    const skill: SkillSummary = { id: "tdd", name: "tdd", description: "", path: "", group: "g", category: "", risk: "low", targets: [], related: [] };
    renderLibrary({
      sourceType: "skills",
      skills: [skill],
      activeSkillId: "tdd",
      activeSkillContent: { id: "tdd", title: "tdd", path: "skills/tdd/SKILL.md", section: "skills", source: "workspace", content: "# Tdd" },
      onOpenSkill,
      onSaveDoc,
    });
    const editor = textarea("Skill source");
    expect(editor.readOnly).toBe(true);
    expect(screen.getByRole("region", { name: "Editor" }).querySelector(".pane-title")!.textContent).toContain("read-only");
    press(editor, "s", { ctrlKey: true });
    expect(onSaveDoc).not.toHaveBeenCalled();
    press(focusList(), "o");
    expect(onOpenSkill).toHaveBeenCalledWith("tdd");
  });

  it("shows agent metadata and notes in the preview pane", () => {
    const agents: AgentMetadataResponse[] = [
      {
        id: "v.md",
        title: "verifier",
        path: "agents/v.md",
        exists: true,
        metadata: { role: "verification", summary: "Checks things", targets: ["codex"], risk: "high", default_skills: ["tdd"], safe_to_edit_runtime: false, notes: ["first note", "second note"] },
      },
    ];
    renderLibrary({
      sourceType: "agents",
      agentSources: agents,
      activeAgentId: "v.md",
      activeAgentContent: { id: "v.md", title: "verifier", path: "agents/v.md", content: "# Verifier", exists: true },
      agentDraft: "# Verifier",
    });
    const meta = screen.getByRole("region", { name: "metadata" });
    expect(within(meta).getByText("Checks things")).not.toBeNull();
    expect(within(meta).getByText("runtime-sensitive: edit with care")).not.toBeNull();
    expect(within(meta).getByText("first note")).not.toBeNull();
    expect(within(meta).getByText("second note")).not.toBeNull();
  });
});

describe("LibraryView save", () => {
  const doc = makeDoc("a", "Alpha", "# Saved");

  it("saves the open doc with Mod+s from the editor and from the list", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onSaveDoc });
    press(textarea("Edit document"), "s", { ctrlKey: true });
    expect(onSaveDoc).toHaveBeenCalledTimes(1);
    press(focusList(), "s", { ctrlKey: true });
    expect(onSaveDoc).toHaveBeenCalledTimes(2);
  });

  it("calls the save handler of the active source only", () => {
    const handlers = {
      onSaveDoc: vi.fn(),
      onSaveAgentTemplate: vi.fn(),
      onSaveAgent: vi.fn(),
      onSaveConfig: vi.fn(),
    };
    const template = makeDoc("tpl", "tpl", "rules");
    const { update } = renderLibrary({
      sourceType: "rules",
      agentTemplate: template,
      agentTemplateDraft: "rules!",
      agentTemplateDirty: true,
      ...handlers,
    });
    press(textarea("Edit agent rules template"), "s", { ctrlKey: true });
    expect(handlers.onSaveAgentTemplate).toHaveBeenCalledTimes(1);

    update({
      sourceType: "agents",
      agentSources: [{ id: "v.md", title: "v", path: "agents/v.md", exists: true, metadata: null }],
      activeAgentId: "v.md",
      activeAgentContent: { id: "v.md", title: "v", path: "agents/v.md", content: "a", exists: true },
      agentDraft: "b",
      agentDirty: true,
      ...handlers,
    });
    press(textarea("Edit agent source"), "s", { ctrlKey: true });
    expect(handlers.onSaveAgent).toHaveBeenCalledTimes(1);
    expect(handlers.onSaveDoc).not.toHaveBeenCalled();
    expect(handlers.onSaveConfig).not.toHaveBeenCalled();
    expect(handlers.onSaveAgentTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not save a clean doc and says so in the status bar", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSaveDoc });
    press(textarea("Edit document"), "s", { ctrlKey: true });
    expect(onSaveDoc).not.toHaveBeenCalled();
    expect(statusBarText()).toBe("no changes to save");
  });

  it("does not start a second save while one is running", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, docSaving: true, onSaveDoc });
    press(textarea("Edit document"), "s", { ctrlKey: true });
    expect(onSaveDoc).not.toHaveBeenCalled();
  });

  it("saves with :w", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onSaveDoc });
    focusList();
    runCommand("w");
    expect(onSaveDoc).toHaveBeenCalledTimes(1);
  });

  it("refuses :w for a read-only item", () => {
    const onSaveConfig = vi.fn();
    const content = makeDoc("snapshot", "snapshot", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [{ id: "opencode_config", label: "OpenCode config", harness: "opencode", kind: "config", source_rel: "a", target_rel: "b" }],
      configEditorSources: [{ id: "snapshot", label: "Snapshot", rel_path: "x", editable: false, helper: "" }],
      activeConfigTargetId: "opencode_config",
      activeConfigSourceType: "snapshot",
      configEditorSourceContent: content,
      configDraft: "{}",
      onSaveConfig,
    });
    focusList();
    runCommand("w");
    expect(screen.getByRole("alert").textContent).toContain("read-only item");
    expect(onSaveConfig).not.toHaveBeenCalled();
  });

  it("shows save progress and results in the editor footer, and announces a finished save in the status bar", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, docSaving: true });
    const footer = screen.getByRole("region", { name: "Editor" }).querySelector(".pane-foot")!;
    expect(footer.textContent).toContain("saving...");
    update({
      docs,
      activeDoc: doc,
      docDraft: "# Edited",
      docDirty: true,
      docSaveResult: { success: false, action: "save_doc", stdout: "", stderr: "disk full", exit_code: 1 },
    });
    expect(footer.textContent).toContain("disk full");
    expect(statusBarText()).toBe("library › docs");

    update({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, docSaving: true });
    update({
      docs,
      activeDoc: doc,
      docDraft: "# Edited",
      docSaveResult: { success: true, action: "save_doc", stdout: "saved docs/a.md", stderr: "", exit_code: 0 },
    });
    expect(footer.textContent).toContain("saved docs/a.md");
    expect(statusBarText()).toBe("saved docs/a.md");
  });

  it("does not announce an old save result when the library is opened again", () => {
    renderLibrary({
      docs,
      activeDoc: doc,
      docDraft: doc.content,
      docSaveResult: { success: true, action: "save_doc", stdout: "saved docs/a.md", stderr: "", exit_code: 0 },
    });
    expect(statusBarText()).toBe("library › docs");
  });

  it("redacts secrets in save results", () => {
    renderLibrary({
      docs,
      activeDoc: doc,
      docDraft: doc.content,
      docSaveResult: { success: false, action: "save_doc", stdout: "", stderr: "failed with token=sk-abcdefghijklmnopqrstuvwxyz0123456789", exit_code: 1 },
    });
    const footer = screen.getByRole("region", { name: "Editor" }).querySelector(".pane-foot")!;
    expect(footer.textContent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("LibraryView close and reset", () => {
  const doc = makeDoc("a", "Alpha", "# Saved");

  it("closes a clean item with :q without asking, and hands focus to the list", async () => {
    vi.useFakeTimers();
    const onResetDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onResetDoc });
    const editor = textarea("Edit document");
    act(() => editor.focus());
    // Opening the command line from the editor needs Mod+k (":" would be typed).
    press(editor, "k", { ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Command" });
    fireEvent.change(input, { target: { value: "q" } });
    press(input, "Enter");
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.queryByRole("dialog", { name: /confirm/i })).toBeNull();
    expect(onResetDoc).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(listbox());
  });

  it("asks before closing a dirty item and discards the edits only after the confirmation", async () => {
    const onResetDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onResetDoc });
    focusList();
    runCommand("q");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Leave with unsaved changes?")).not.toBeNull();
    expect(onResetDoc).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "confirm" }));
    await act(async () => {});
    expect(onResetDoc).toHaveBeenCalledTimes(1);
  });

  it("keeps the edits when the confirmation is declined", async () => {
    const onResetDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onResetDoc });
    focusList();
    runCommand("q");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }));
    await act(async () => {});
    expect(onResetDoc).not.toHaveBeenCalled();
  });

  it("closes through the footer button with the same confirmation", async () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true });
    fireEvent.click(within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: /close/ }));
    expect(await screen.findByRole("dialog")).not.toBeNull();
  });

  it("discards edits with :reset and only offers it while there are some", () => {
    const onResetDoc = vi.fn();
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onResetDoc });
    focusList();
    press(document.activeElement!, ":", { shiftKey: true });
    const input = screen.getByRole("combobox", { name: "Command" });
    fireEvent.change(input, { target: { value: "reset" } });
    press(input, "Enter");
    expect(screen.getByRole("alert").textContent).toContain("no unsaved changes");
    expect(onResetDoc).not.toHaveBeenCalled();
    press(input, "Escape");

    update({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onResetDoc });
    focusList();
    runCommand("reset");
    expect(onResetDoc).toHaveBeenCalledTimes(1);
  });
});

describe("LibraryView new doc form", () => {
  it("opens the form with n, shows its controls and creates through the existing handlers", () => {
    const onSetShowCreateDoc = vi.fn();
    const onCreateDoc = vi.fn();
    const onSetCreateDocTitle = vi.fn();
    const { update } = renderLibrary({ docs, onSetShowCreateDoc, onCreateDoc, onSetCreateDocTitle });
    press(focusList(), "n");
    expect(onSetShowCreateDoc).toHaveBeenCalledWith(true);

    update({ docs, showCreateDoc: true, createDocTitle: "Notes", createDocSlug: "notes", onCreateDoc, onSetCreateDocTitle, onSetShowCreateDoc });
    const title = screen.getByLabelText("New doc title");
    expect(document.activeElement).toBe(title);
    expect(screen.getByLabelText("New doc slug")).not.toBeNull();
    fireEvent.change(title, { target: { value: "More" } });
    expect(onSetCreateDocTitle).toHaveBeenCalledWith("More");
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    expect(onCreateDoc).toHaveBeenCalledTimes(1);
  });

  it("disables create until title and slug are filled, and shows errors", () => {
    renderLibrary({ docs, showCreateDoc: true, createDocTitle: "", createDocSlug: "x", createDocError: "doc already exists" });
    expect((screen.getByRole("button", { name: "create" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("doc already exists");
  });

  it("cancels with Escape and returns to the list", () => {
    const onSetShowCreateDoc = vi.fn();
    renderLibrary({ docs, showCreateDoc: true, onSetShowCreateDoc });
    press(screen.getByLabelText("New doc title"), "Escape");
    expect(onSetShowCreateDoc).toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(listbox());
  });

  it("only offers new doc for the docs source of a valid workspace", () => {
    const { update } = renderLibrary({ docs });
    act(() => listbox().focus());
    const bar = within(screen.getByLabelText("Status bar"));
    expect(bar.getByRole("button", { name: /new doc/ })).not.toBeNull();
    update({ docs, workspaceValid: false });
    expect(bar.queryByRole("button", { name: /new doc/ })).toBeNull();
  });
});

describe("LibraryView Rules and Brain Setup", () => {
  it("lists the rules template with the targets it installs to", () => {
    const template = makeDoc("tpl", "tpl", "# Rules");
    renderLibrary({
      sourceType: "rules",
      agentTemplate: template,
      agentTemplateDraft: "# Rules",
      agentTargets: [
        { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", source_rel: "a", target_rel: ".claude/CLAUDE.md" },
        { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", source_rel: "a", target_rel: ".claude/agents" },
      ],
    });
    expect(within(listbox()).getByText("Global Rules")).not.toBeNull();
    const meta = screen.getByRole("region", { name: "installs to" });
    expect(within(meta).getByText(".claude/CLAUDE.md")).not.toBeNull();
    expect(within(meta).queryByText(".claude/agents")).toBeNull();
    expect(screen.getByText("template only")).not.toBeNull();
  });

  it("shows the Brain Setup block as a copyable pane and moves into it with Enter", () => {
    renderLibrary({ sourceType: "brain", brainSetupText: "BRAIN BLOCK TEXT", brainSetupSource: "templates/brain.md" });
    expect(screen.getByText("BRAIN BLOCK TEXT")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
    expect(screen.getByRole("region", { name: "Brain Setup" }).querySelector(".pane-title")!.textContent).toContain("templates/brain.md");
    press(focusList(), "Enter");
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Brain Setup" }));
  });

  it("explains an invalid workspace in Brain Setup", () => {
    renderLibrary({ sourceType: "brain", workspaceValid: false });
    expect(screen.getAllByText(/No valid workspace/).length).toBeGreaterThan(0);
  });
});
