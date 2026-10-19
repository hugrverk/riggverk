import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentMetadataResponse,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocSummary,
  DocumentContent,
  RulesFileContent,
  RulesFileSummary,
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
    agentTargets: [],
    rulesFiles: [],
    activeRulesSurface: null,
    activeRulesFile: null,
    onSelectRulesFile: noop,
    onOpenRulesFile: noop,
    rulesDraft: "",
    rulesDirty: false,
    rulesSaving: false,
    rulesSaveResult: null,
    onChangeRulesDraft: noop,
    onSaveRules: noop,
    onResetRules: noop,
    skills: [],
    activeSkillId: null,
    activeSkillContent: null,
    skillSearch: "",
    onSetSkillSearch: noop,
    onSelectSkillPreview: noop,
    agentSources: [],
    activeAgentId: null,
    activeAgentContent: null,
    onSelectAgent: noop,
    configTemplateContent: null,
    activeConfigTargetId: "",
    configTargets: [],
    onSelectConfigTarget: noop,
    configEditorSources: [],
    activeConfigSourceType: "base",
    onSelectConfigSource: noop,
    configEditorSourceContent: null,
    workspaceValid: true,
    showConfigs: true,
    ...overrides,
  };
}

/**
 * An open item. Docs open as personal docs (`custom`, editable) unless a test passes `curated` for a bundled
 * one; the list rows in `docs` only drive selection. Other sources ignore the doc source.
 */
function makeDoc(id: string, title: string, content: string, source = "custom"): DocumentContent {
  return { id, title, path: `docs/${id}.md`, section: "docs", source, content };
}

const BUNDLED_REASON = "bundled with the app: read-only here";

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

/** Moves focus into a pane by its accessible name (the pane hands it to its primary target). */
function focusPane(name: string) {
  act(() => screen.getByRole("region", { name }).focus());
}

/** Key hints of the focused pane live in the status bar; look them up outside `act`. */
function statusHint(name: string) {
  return within(screen.getByLabelText("Status bar")).getByRole("button", { name });
}

function queryStatusHint(name: string) {
  return within(screen.getByLabelText("Status bar")).queryByRole("button", { name });
}

function textarea(label: string) {
  return screen.getByLabelText(label) as HTMLTextAreaElement;
}

/** Edit mode: Enter or `i` on the focused document pane swaps the rendered view for the source textarea. */
function editDocument(label: string) {
  focusPane("Document");
  press(document.activeElement!, "i");
  return textarea(label);
}

/** Mod+s from the document pane, whichever mode it is in. */
function pressSave() {
  focusPane("Document");
  press(document.activeElement!, "s", { ctrlKey: true });
}

/** Mod+s on a bundled item runs nothing: its status-bar hint stays disabled and says why. */
function expectSaveRefused() {
  pressSave();
  const hint = within(screen.getByLabelText("Status bar")).getByRole("button", { name: / save$/ });
  expect(hint.getAttribute("aria-disabled")).toBe("true");
  expect(hint.getAttribute("title")).toBe(BUNDLED_REASON);
}

function runCommand(line: string) {
  press(document.activeElement ?? document.body, ":", { shiftKey: true });
  const input = screen.getByRole("combobox", { name: "Command" });
  fireEvent.change(input, { target: { value: line } });
  press(input, "Enter");
}

const docs: DocSummary[] = [
  { id: "a", title: "Alpha", section: "Bundled", path: "docs/alpha.md", source: "curated" },
  { id: "b", title: "Beta notes", section: "Context", path: "docs/context/beta.md", source: "custom" },
  { id: "c", title: "Gamma", section: "Bundled", path: "docs/gamma.md", source: "curated" },
];

describe("LibraryView layout", () => {
  it("renders the items and one document pane with the source switcher and counts", () => {
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", "# A"), docDraft: "# A" });
    expect(screen.getByRole("region", { name: "Library items" }).getAttribute("data-pane-id")).toBe("items");
    expect(screen.getByRole("region", { name: "Document" }).getAttribute("data-pane-id")).toBe("editor");
    expect(document.querySelectorAll("section.pane")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
    const group = screen.getByRole("group", { name: "Library source type" });
    expect(within(group).getAllByRole("button").map(button => button.textContent)).toEqual([
      "docs 3",
      "rules",
      "skills",
      "agents",
      "configs",
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

  it("shows one empty state in the document pane while nothing is open", () => {
    renderLibrary({ docs });
    expect(screen.getAllByText("Select a document to preview")).toHaveLength(1);
    expect(screen.queryByText("Nothing to preview")).toBeNull();
    expect(screen.getByRole("region", { name: "Document" }).querySelector(".pane-title")!.textContent).toBe("document");
  });
});

describe("LibraryView Configs pane", () => {
  const configTargets: AgentTargetMeta[] = [
    { id: "opencode_config", label: "OpenCode config", harness: "opencode", kind: "config", source_rel: "templates/opencode.base.json", target_rel: "opencode.json" },
    { id: "codex_config", label: "Codex config", harness: "codex", kind: "config", source_rel: "templates/codex.toml", target_rel: "config.toml" },
  ];
  const sources: ConfigEditorSourceMeta[] = [
    { id: "base", label: "Base", rel_path: "templates/opencode.base.json", helper: "bundled base" },
    { id: "policy", label: "Policy", rel_path: "templates/opencode.policy.json", helper: "overrides" },
    { id: "snapshot", label: "Snapshot", rel_path: "templates/opencode.json", helper: "generated" },
  ];

  it("shows the editor source content for opencode_config, rendered and read-only", () => {
    const content = makeDoc("base", "base", '{"opencode_marker": true}');
    renderLibrary({
      sourceType: "configs",
      configTargets,
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      configTemplateContent: null,
      configEditorSourceContent: content,
    });
    // Rendered: the source, pretty-printed, and never a textarea.
    expect(document.querySelector(".configs-code")!.textContent).toContain('"opencode_marker": true');
    expect(screen.queryByText("Select a config target to preview")).toBeNull();
    // The bundle summary is gated on the same active content.
    expect(screen.getByRole("region", { name: "bundle" })).not.toBeNull();
    focusPane("Document");
    press(document.activeElement!, "i");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector(".configs-code")).not.toBeNull();
    expect(screen.getByText(BUNDLED_REASON)).not.toBeNull();
  });

  it("shows a loading state for opencode_config and then renders content", () => {
    const props: Partial<LibraryViewProps> = {
      sourceType: "configs",
      configTargets,
      activeConfigTargetId: "opencode_config",
      configEditorSourceContent: null,
    };
    const { update } = renderLibrary(props);
    expect(screen.getByText("Loading config source…")).not.toBeNull();

    const loaded = makeDoc("base", "base", '{"loaded_marker": 1}');
    update({ ...props, configEditorSourceContent: loaded });
    expect(document.querySelector(".configs-code")!.textContent).toContain('"loaded_marker": 1');
  });

  it("shows the template content for other config targets as a read-only preview", () => {
    const template = makeDoc("codex", "codex", 'model = "template_marker"');
    renderLibrary({
      sourceType: "configs",
      configTargets,
      activeConfigTargetId: "codex_config",
      configTemplateContent: template,
    });
    expect(document.querySelector(".configs-code")!.textContent).toContain("template_marker");
    expect(screen.getByText(BUNDLED_REASON)).not.toBeNull();
    // Never a textarea for a read-only item, however it is asked for.
    focusPane("Document");
    press(document.activeElement!, "i");
    press(document.activeElement!, "Enter");
    expect(screen.queryByRole("textbox")).toBeNull();
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

  it("lists the editor sources of opencode_config and marks the active one", () => {
    const content = makeDoc("policy", "policy", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [configTargets[0]!],
      configEditorSources: sources,
      activeConfigTargetId: "opencode_config",
      activeConfigSourceType: "policy",
      configEditorSourceContent: content,
    });
    expect(within(listbox()).getAllByRole("option").map(option => option.querySelector(".nm")!.textContent)).toEqual([
      "OpenCode config",
      "Base",
      "Policy",
      "Snapshot",
    ]);
    expect(selectedNames()).toEqual(["Policy"]);
    // Every source is read-only: the pane says so once, no row needs its own tag.
    expect(within(listbox()).queryByText("read-only")).toBeNull();
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

  it("treats every opencode source as bundled: no textarea, Mod+s says why", () => {
    for (const source of sources) {
      const content = makeDoc(source.id, source.id, '{"snap": 1}');
      renderLibrary({
        sourceType: "configs",
        configTargets: [configTargets[0]!],
        configEditorSources: sources,
        activeConfigTargetId: "opencode_config",
        activeConfigSourceType: source.id,
        configEditorSourceContent: content,
      });
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.getByText(BUNDLED_REASON)).not.toBeNull();
      expectSaveRefused();
      cleanup();
    }
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

  it("lists the bundled docs whether or not the workspace is valid, with no stale-docs banner or action", () => {
    const { update } = renderLibrary({ docs, workspaceValid: true });
    const names = () => within(listbox()).getAllByRole("option").map(option => option.querySelector(".nm")!.textContent);
    expect(names()).toEqual(["Alpha", "Gamma", "Beta notes"]);
    expect(screen.queryByText("Bundled docs need update")).toBeNull();
    expect(screen.queryByRole("button", { name: "open workspace update" })).toBeNull();

    update({ docs, workspaceValid: false });
    expect(names()).toEqual(["Alpha", "Gamma", "Beta notes"]);
    expect(screen.queryByText("No valid workspace")).toBeNull();
    expect(screen.queryByText("Bundled docs need update")).toBeNull();
  });

  it("says so when there are no docs", () => {
    renderLibrary({ docs: [] });
    expect(screen.getByText("No docs found")).not.toBeNull();
  });

  it("opens a bundled doc in a workspace that is not valid", () => {
    const bundled = makeDoc("a", "Alpha", "# Bundled heading", "curated");
    renderLibrary({ docs, activeDoc: bundled, docDraft: bundled.content, workspaceValid: false });
    expect(screen.getByRole("heading", { name: "Bundled heading" })).not.toBeNull();
    expect(screen.queryByText("No valid workspace selected")).toBeNull();
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
    expect(onSetSourceType).toHaveBeenLastCalledWith("configs");
    press(list, "<");
    expect(onSetSourceType).toHaveBeenLastCalledWith("configs");

    update({ sourceType: "configs", onSetSourceType });
    press(screen.getByRole("listbox"), "]");
    expect(onSetSourceType).toHaveBeenLastCalledWith("docs");
  });

  it("skips configs while it is hidden", () => {
    const onSetSourceType = vi.fn();
    renderLibrary({ sourceType: "agents", showConfigs: false, onSetSourceType, agentSources: [] });
    press(screen.getByRole("button", { name: /^agents/ }), "]");
    expect(onSetSourceType).toHaveBeenLastCalledWith("docs");
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

describe("LibraryView status-bar hints", () => {
  const doc = makeDoc("a", "Alpha", "# A");

  it("offers filter, source stepping and open while the items pane has focus, and no pane footer", () => {
    const onSetSourceType = vi.fn();
    const onOpenDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSetSourceType, onOpenDoc });
    focusList();
    expect(statusHint("[ prev source")).not.toBeNull();
    expect(statusHint("o open")).not.toBeNull();

    fireEvent.click(statusHint("] next source"));
    expect(onSetSourceType).toHaveBeenLastCalledWith("rules");
    fireEvent.click(statusHint("[ prev source"));
    expect(onSetSourceType).toHaveBeenLastCalledWith("configs");
    fireEvent.click(statusHint("o open"));
    expect(onOpenDoc).toHaveBeenCalledWith("a");

    expect(screen.getByRole("region", { name: "Library items" }).querySelector(".pane-foot")).toBeNull();
  });

  it("focuses the filter from its hint, and still from the list key", () => {
    renderLibrary({ docs });
    focusList();
    fireEvent.click(statusHint("/ filter"));
    expect(document.activeElement).toBe(screen.getByLabelText("Filter documents"));
    focusList();
    press(listbox(), "/");
    expect(document.activeElement).toBe(screen.getByLabelText("Filter documents"));
  });

  it("only offers the filter for sources that have one", () => {
    const { update } = renderLibrary({ docs });
    focusList();
    expect(queryStatusHint("/ filter")).not.toBeNull();
    update({ sourceType: "rules" });
    focusList();
    expect(queryStatusHint("/ filter")).toBeNull();
  });

  it("offers edit, save and open, not the list hints, while the document pane has focus", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    focusPane("Document");
    expect(statusHint("↵ edit")).not.toBeNull();
    expect(statusHint("o open")).not.toBeNull();
    expect(queryStatusHint("/ filter")).toBeNull();
    expect(queryStatusHint("] next source")).toBeNull();
  });

  it("edits from the status-bar hint, and then offers save but no edit while typing", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    focusPane("Document");
    fireEvent.click(statusHint("↵ edit"));
    expect(document.activeElement).toBe(textarea("Edit document"));
    const bar = within(screen.getByLabelText("Status bar"));
    expect(bar.getByText("INSERT")).not.toBeNull();
    expect(bar.getByText("leave field")).not.toBeNull();
    expect(queryStatusHint("↵ edit")).toBeNull();
    expect(bar.getByRole("button", { name: /save/ })).not.toBeNull();
  });

  it("keeps the edit and open hints disabled, with the reason, for a bundled item", () => {
    const skill: SkillSummary = { id: "tdd", name: "tdd", description: "", path: "", group: "g", category: "", risk: "low", targets: [], related: [] };
    renderLibrary({
      sourceType: "skills",
      skills: [skill],
      activeSkillId: "tdd",
      activeSkillContent: makeDoc("tdd", "tdd", "# Tdd"),
    });
    focusPane("Document");
    const hint = statusHint("↵ edit");
    expect(hint.getAttribute("aria-disabled")).toBe("true");
    expect(hint.getAttribute("title")).toBe(BUNDLED_REASON);
    fireEvent.click(hint);
    expect(screen.queryByLabelText("Skill source")).toBeNull();
    const open = statusHint("o open");
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.getAttribute("title")).toBe(BUNDLED_REASON);
  });

  it("hides edit and open while nothing is open", () => {
    renderLibrary({ docs });
    focusList();
    expect(queryStatusHint("o open")).toBeNull();
    focusPane("Document");
    expect(queryStatusHint("o open")).toBeNull();
    expect(queryStatusHint("↵ edit")).toBeNull();
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

describe("LibraryView document pane", () => {
  const doc = makeDoc("a", "Alpha", "# Saved heading");

  it("shows the open doc in the pane title with its path, and a modified marker while dirty", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const title = screen.getByRole("region", { name: "Document" }).querySelector(".pane-title")!;
    expect(title.textContent).toBe("Alpha · docs/a.md");
    update({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true });
    expect(title.textContent).toBe("Alpha · docs/a.md · modified");
  });

  it("shows the document once, rendered, and no textarea until it is edited", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(within(pane).getAllByRole("heading", { name: "Saved heading" })).toHaveLength(1);
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    expect(screen.getAllByText(/Saved heading/)).toHaveLength(1);
  });

  it("moves into edit mode with Enter or i from the list, and Escape returns to the rendered view", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const list = focusList();
    press(list, "Enter");
    const editor = textarea("Edit document");
    expect(document.activeElement).toBe(editor);
    // Edit mode swaps the rendered view for the source: the text is not shown twice.
    expect(screen.queryByRole("heading", { name: "Saved heading" })).toBeNull();

    press(editor, "Escape");
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    expect(screen.getByRole("heading", { name: "Saved heading" })).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Document" }));

    press(focusList(), "i");
    expect(document.activeElement).toBe(textarea("Edit document"));
  });

  it("edits from the focused pane with Enter or i, and shows the edit rendered after Escape", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    focusPane("Document");
    press(document.activeElement!, "Enter");
    const editor = textarea("Edit document");
    expect(document.activeElement).toBe(editor);

    // Typing reaches the controller, which hands the working copy back as the draft.
    update({ docs, activeDoc: doc, docDraft: "# Draft heading", docDirty: true });
    expect(textarea("Edit document").value).toBe("# Draft heading");
    press(textarea("Edit document"), "Escape");
    const pane = screen.getByRole("region", { name: "Document" });
    expect(within(pane).getByRole("heading", { name: "Draft heading" })).not.toBeNull();
    expect(within(pane).queryByRole("heading", { name: "Saved heading" })).toBeNull();
    expect(pane.querySelector(".pane-title")!.textContent).toContain("modified");
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Document" }));

    press(document.activeElement!, "i");
    expect(document.activeElement).toBe(textarea("Edit document"));
  });

  it("lands on the document pane in NORMAL mode with l, and h returns to the list", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const list = focusList();
    press(list, "l");
    const body = screen.getByRole("group", { name: "Document" });
    expect(document.activeElement).toBe(body);
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    // It is the last pane: l stays put instead of typing or wrapping.
    press(body, "l");
    expect(document.activeElement).toBe(body);
    press(body, "h");
    expect(document.activeElement).toBe(listbox());
  });

  it("lands on the pane, not in the textarea, with h and l while the pane is still in edit mode", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const editor = editDocument("Edit document");
    // Leave through the list without Escape: the item stays in edit mode.
    act(() => listbox().focus());
    press(listbox(), "l");
    const pane = screen.getByRole("region", { name: "Document" });
    expect(document.activeElement).toBe(pane.querySelector(".lib-editor"));
    expect(document.activeElement).not.toBe(editor);
    press(document.activeElement!, "h");
    expect(document.activeElement).toBe(listbox());
    press(listbox(), "i");
    expect(document.activeElement).toBe(editor);
  });

  it("does not run list keys while typing in the editor", () => {
    const onSetSourceType = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSetSourceType });
    const editor = editDocument("Edit document");
    press(editor, "]");
    press(editor, "i");
    press(editor, "j");
    expect(onSetSourceType).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("returns to the rendered view when another item opens", () => {
    const other = makeDoc("c", "Gamma", "# Gamma heading");
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    editDocument("Edit document");
    update({ docs, activeDoc: other, docDraft: other.content });
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    expect(screen.getByRole("heading", { name: "Gamma heading" })).not.toBeNull();
    // Coming back to the first item does not resume editing it.
    update({ docs, activeDoc: doc, docDraft: doc.content });
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    expect(screen.getByRole("heading", { name: "Saved heading" })).not.toBeNull();
  });

  it("opens the row and then edits it when Enter is pressed before the selection landed", () => {
    const onSelectDoc = vi.fn();
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSelectDoc });
    const list = focusList();
    press(list, "j");
    press(list, "Enter");
    expect(onSelectDoc).toHaveBeenCalledWith("c");
    expect(document.activeElement).toBe(list);
    expect(screen.queryByLabelText("Edit document")).toBeNull();

    const next = makeDoc("c", "Gamma", "# Gamma");
    update({ docs, activeDoc: next, docDraft: next.content, onSelectDoc });
    expect(document.activeElement).toBe(textarea("Edit document"));
  });

  it("opens a read-only row with Enter into the rendered pane, not a textarea", () => {
    const onSelectSkillPreview = vi.fn();
    const skills: SkillSummary[] = [
      { id: "one", name: "one", description: "", path: "", group: "g", category: "", risk: "", targets: [], related: [] },
      { id: "two", name: "two", description: "", path: "", group: "g", category: "", risk: "", targets: [], related: [] },
    ];
    const one = makeDoc("one", "one", "# One");
    const { update } = renderLibrary({ sourceType: "skills", skills, activeSkillId: "one", activeSkillContent: one, onSelectSkillPreview });
    const list = focusList();
    press(list, "j");
    press(list, "Enter");
    expect(onSelectSkillPreview).toHaveBeenCalledWith("two");
    update({ sourceType: "skills", skills, activeSkillId: "two", activeSkillContent: makeDoc("two", "two", "# Two"), onSelectSkillPreview });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Document" }));
    expect(screen.queryByLabelText("Skill source")).toBeNull();
  });

  it("reports edits through the draft handler", () => {
    const onChangeDocDraft = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onChangeDocDraft });
    editDocument("Edit document");
    fireEvent.change(textarea("Edit document"), { target: { value: "# New" } });
    expect(onChangeDocDraft).toHaveBeenCalledWith("# New");
  });

  it("renders the document from the draft, not from the saved content", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(within(pane).getByRole("heading", { name: "Saved heading" })).not.toBeNull();
    update({ docs, activeDoc: doc, docDraft: "# Draft heading", docDirty: true });
    expect(within(pane).getByRole("heading", { name: "Draft heading" })).not.toBeNull();
    expect(within(pane).queryByRole("heading", { name: "Saved heading" })).toBeNull();
  });

  it("renders tables and links", () => {
    const content = "Paragraph with [safe link](https://example.com).\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    renderLibrary({ docs, activeDoc: makeDoc("a", "Alpha", content), docDraft: content });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(pane.querySelector(".lib-docs-markdown")).not.toBeNull();
    expect(pane.querySelector("table")).not.toBeNull();
    expect(pane.querySelector("a[href='https://example.com']")).not.toBeNull();
  });

  it("leaves YAML front matter out of the rendered skill and offers no textarea for it", () => {
    const content = "---\nname: tdd\ndescription: Red green\n---\n\n# Tdd\n\nBody.";
    const skill: SkillSummary = { id: "tdd", name: "tdd", description: "Red green", path: "", group: "g", category: "testing", risk: "low", targets: ["codex"], related: [] };
    renderLibrary({
      sourceType: "skills",
      skills: [skill],
      activeSkillId: "tdd",
      activeSkillContent: { id: "tdd", title: "tdd", path: "skills/tdd/SKILL.md", section: "skills", source: "workspace", content },
    });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(pane.querySelector("hr")).toBeNull();
    expect(within(pane).getByRole("heading", { name: "Tdd" })).not.toBeNull();
    expect(screen.queryByLabelText("Skill source")).toBeNull();
  });

  it("keeps the new-doc form at the top of the pane in both modes", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, showCreateDoc: true });
    const pane = screen.getByRole("region", { name: "Document" });
    const form = within(pane).getByRole("form", { name: "New document" });
    expect(form.nextElementSibling).toBe(pane.querySelector(".lib-docs-markdown"));
    editDocument("Edit document");
    expect(within(pane).getByRole("form", { name: "New document" }).nextElementSibling).toBe(textarea("Edit document"));
  });

  it("opens the item externally from the list key and from the status-bar hint of the document pane", () => {
    const onOpenDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onOpenDoc });
    press(focusList(), "o");
    expect(onOpenDoc).toHaveBeenCalledWith("a");
    focusPane("Document");
    fireEvent.click(statusHint("o open"));
    expect(onOpenDoc).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("region", { name: "Document" })).queryByRole("button", { name: /open/ })).toBeNull();
  });

  it("offers copy path, close and discard in the document footer", () => {
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content });
    const footer = screen.getByRole("region", { name: "Document" }).querySelector<HTMLElement>(".pane-foot")!;
    expect(within(footer).getByRole("button", { name: "Copy path" })).not.toBeNull();
    // `:q` and `:reset` are command-line commands: the status bar has no binding to offer, so they stay here.
    expect(within(footer).getByRole("button", { name: ":q close" })).not.toBeNull();
    expect(within(footer).getByRole("button", { name: ":reset discard" })).not.toBeNull();
  });

  it("marks skills read-only: rendered only, marker, no edit, no save, nothing to open", () => {
    const onSaveDoc = vi.fn();
    const onOpenDoc = vi.fn();
    const skill: SkillSummary = { id: "tdd", name: "tdd", description: "", path: "", group: "g", category: "", risk: "low", targets: [], related: [] };
    renderLibrary({
      sourceType: "skills",
      skills: [skill],
      activeSkillId: "tdd",
      activeSkillContent: { id: "tdd", title: "tdd", path: "skills/tdd/SKILL.md", section: "skills", source: "workspace", content: "# Tdd" },
      onSaveDoc,
      onOpenDoc,
    });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(within(pane).getByRole("heading", { name: "Tdd" })).not.toBeNull();
    expect(pane.querySelector(".pane-title")!.textContent).toContain("read-only");
    expect(within(pane).getByText(BUNDLED_REASON)).not.toBeNull();
    // The Library shows the bundle itself now: no note that "this copy" may differ.
    expect(pane.querySelector(".pane-foot")!.textContent).not.toContain("may differ");

    focusPane("Document");
    press(document.activeElement!, "i");
    press(document.activeElement!, "Enter");
    press(focusList(), "i");
    expect(screen.queryByLabelText("Skill source")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /source/i })).toBeNull();

    pressSave();
    expect(onSaveDoc).not.toHaveBeenCalled();
    press(focusList(), "o");
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  it("marks a bundled doc read-only with the reason everywhere, and keeps personal docs editable", () => {
    const onSaveDoc = vi.fn();
    const onOpenDoc = vi.fn();
    const bundled = makeDoc("a", "Alpha", "# Bundled heading", "curated");
    const { update } = renderLibrary({ docs, activeDoc: bundled, docDraft: bundled.content, onSaveDoc, onOpenDoc });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(pane.querySelector(".pane-title")!.textContent).toBe("Alpha · docs/a.md · read-only");
    const footer = pane.querySelector<HTMLElement>(".pane-foot")!;
    expect(within(footer).getByText(BUNDLED_REASON)).not.toBeNull();
    expect(footer.textContent).not.toContain("may differ");
    expect(within(footer).queryByRole("button", { name: ":reset discard" })).toBeNull();
    // From the list, Enter reads a bundled doc: it moves into the rendered pane.
    focusList();
    expect(statusHint("↵ read")).not.toBeNull();

    focusPane("Document");
    for (const name of ["↵ edit", "o open"]) {
      const hint = statusHint(name);
      expect(hint.getAttribute("aria-disabled")).toBe("true");
      expect(hint.getAttribute("title")).toBe(BUNDLED_REASON);
    }
    press(document.activeElement!, "Enter");
    press(document.activeElement!, "i");
    press(focusList(), "o");
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    expect(onOpenDoc).not.toHaveBeenCalled();
    expectSaveRefused();
    focusList();
    runCommand("w");
    expect(screen.getByRole("alert").textContent).toContain(BUNDLED_REASON);
    expect(onSaveDoc).not.toHaveBeenCalled();
    press(screen.getByRole("combobox", { name: "Command" }), "Escape");

    // A personal doc in the same list is the user's own text: edit and open are offered.
    const personal = makeDoc("b", "Beta notes", "# Notes");
    update({ docs, activeDoc: personal, docDraft: personal.content, onSaveDoc, onOpenDoc });
    expect(pane.querySelector(".pane-title")!.textContent).not.toContain("read-only");
    focusList();
    expect(statusHint("↵ edit")).not.toBeNull();
    press(focusList(), "o");
    expect(onOpenDoc).toHaveBeenCalledWith("b");
    expect(editDocument("Edit document").value).toBe("# Notes");
  });

  it("shows agent metadata and notes above the rendered source in the document pane", () => {
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
    });
    const pane = screen.getByRole("region", { name: "Document" });
    const meta = within(pane).getByRole("region", { name: "metadata" });
    expect(within(meta).getByText("Checks things")).not.toBeNull();
    expect(within(meta).getByText("runtime-sensitive: edit with care")).not.toBeNull();
    expect(within(meta).getByText("first note")).not.toBeNull();
    expect(within(meta).getByText("second note")).not.toBeNull();
    expect(within(pane).getByRole("heading", { name: "Verifier" })).not.toBeNull();
  });
});

describe("LibraryView save", () => {
  const doc = makeDoc("a", "Alpha", "# Saved");

  it("saves the open doc with Mod+s from the rendered pane, from the textarea and from the list", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onSaveDoc });
    pressSave();
    expect(onSaveDoc).toHaveBeenCalledTimes(1);
    press(editDocument("Edit document"), "s", { ctrlKey: true });
    expect(onSaveDoc).toHaveBeenCalledTimes(2);
    press(focusList(), "s", { ctrlKey: true });
    expect(onSaveDoc).toHaveBeenCalledTimes(3);
  });

  it("saves nothing from the bundled sources: rules and agents refuse Mod+s and :w with the reason", () => {
    const onSaveDoc = vi.fn();
    const onOpenDoc = vi.fn();
    const { update } = renderLibrary({
      sourceType: "rules",
      agentTemplate: makeDoc("tpl", "tpl", "rules"),
      onSaveDoc,
      onOpenDoc,
    });
    expectSaveRefused();

    update({
      sourceType: "agents",
      agentSources: [{ id: "v.md", title: "v", path: "agents/v.md", exists: true, metadata: null }],
      activeAgentId: "v.md",
      activeAgentContent: { id: "v.md", title: "v", path: "agents/v.md", content: "a", exists: true },
      onSaveDoc,
      onOpenDoc,
    });
    expectSaveRefused();
    focusList();
    runCommand("w");
    expect(screen.getByRole("alert").textContent).toContain(BUNDLED_REASON);
    press(screen.getByRole("combobox", { name: "Command" }), "Escape");
    press(focusList(), "o");
    press(focusList(), "i");
    expect(screen.queryByRole("textbox", { name: /agent/i })).toBeNull();
    expect(onSaveDoc).not.toHaveBeenCalled();
    expect(onOpenDoc).not.toHaveBeenCalled();
  });

  it("does not save a clean doc and says so in the status bar", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onSaveDoc });
    pressSave();
    expect(onSaveDoc).not.toHaveBeenCalled();
    expect(statusBarText()).toBe("no changes to save");
  });

  it("does not start a second save while one is running", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, docSaving: true, onSaveDoc });
    pressSave();
    expect(onSaveDoc).not.toHaveBeenCalled();
  });

  it("saves with :w", () => {
    const onSaveDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, onSaveDoc });
    focusList();
    runCommand("w");
    expect(onSaveDoc).toHaveBeenCalledTimes(1);
  });

  it("refuses :w for a read-only item with its reason", () => {
    const content = makeDoc("snapshot", "snapshot", "{}");
    renderLibrary({
      sourceType: "configs",
      configTargets: [{ id: "opencode_config", label: "OpenCode config", harness: "opencode", kind: "config", source_rel: "a", target_rel: "b" }],
      configEditorSources: [{ id: "snapshot", label: "Snapshot", rel_path: "x", helper: "" }],
      activeConfigTargetId: "opencode_config",
      activeConfigSourceType: "snapshot",
      configEditorSourceContent: content,
    });
    focusList();
    runCommand("w");
    expect(screen.getByRole("alert").textContent).toContain(BUNDLED_REASON);
  });

  it("shows save progress and results in the document footer, and announces a finished save in the status bar", () => {
    const { update } = renderLibrary({ docs, activeDoc: doc, docDraft: "# Edited", docDirty: true, docSaving: true });
    const footer = screen.getByRole("region", { name: "Document" }).querySelector(".pane-foot")!;
    expect(footer.textContent).toContain("saving…");
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
    const footer = screen.getByRole("region", { name: "Document" }).querySelector(".pane-foot")!;
    expect(footer.textContent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("LibraryView close and reset", () => {
  const doc = makeDoc("a", "Alpha", "# Saved");

  it("closes a clean item with :q without asking, and hands focus to the list", async () => {
    vi.useFakeTimers();
    const onResetDoc = vi.fn();
    renderLibrary({ docs, activeDoc: doc, docDraft: doc.content, onResetDoc });
    const editor = editDocument("Edit document");
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
    // The pane is back to the rendered view.
    expect(screen.queryByLabelText("Edit document")).toBeNull();
    expect(screen.getByRole("heading", { name: "Saved" })).not.toBeNull();
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
    fireEvent.click(within(screen.getByRole("region", { name: "Document" })).getByRole("button", { name: /close/ }));
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

describe("LibraryView bundled sources without a valid workspace", () => {
  it("shows a skill, an agent and a config source from the bundle, read-only, with no workspace message", () => {
    const skill: SkillSummary = { id: "tdd", name: "tdd", description: "", path: "skills/tdd/SKILL.md", group: "g", category: "", risk: "low", targets: [], related: [] };
    const { update } = renderLibrary({
      sourceType: "skills",
      skills: [skill],
      activeSkillId: "tdd",
      activeSkillContent: { id: "tdd", title: "tdd", path: "skills/tdd/SKILL.md", section: "workspace", source: "curated", content: "# Bundled skill" },
      workspaceValid: false,
    });
    expect(screen.getByRole("heading", { name: "Bundled skill" })).not.toBeNull();
    expect(screen.queryByText("No valid workspace selected")).toBeNull();

    const agents: AgentMetadataResponse[] = [{ id: "architect.md", title: "Architect", path: "agents/architect.md", exists: true, metadata: null }];
    update({
      sourceType: "agents",
      agentSources: agents,
      activeAgentId: "architect.md",
      activeAgentContent: { id: "architect.md", title: "Architect", path: "agents/architect.md", content: "# Bundled agent", exists: true },
      workspaceValid: false,
    });
    expect(screen.getByRole("heading", { name: "Bundled agent" })).not.toBeNull();

    update({
      sourceType: "configs",
      activeConfigTargetId: "opencode_config",
      configTargets: [{ id: "opencode_config", label: "OpenCode config", harness: "opencode", kind: "config", source_rel: "templates/opencode.json", target_rel: "opencode.json" }],
      configEditorSources: [{ id: "base", label: "Base", rel_path: "templates/opencode.base.json", helper: "bundled base" }],
      configEditorSourceContent: makeDoc("base", "base", '{"bundled_marker": true}', "curated"),
      workspaceValid: false,
    });
    expect(screen.getByText(/bundled_marker/)).not.toBeNull();
  });

  it("asks for an item to open, not for a workspace, while nothing is open", () => {
    const { update } = renderLibrary({ sourceType: "skills", workspaceValid: false });
    expect(screen.getByText("Select a skill to preview")).not.toBeNull();
    update({ sourceType: "agents", workspaceValid: false });
    expect(screen.getByText("Select an agent to preview")).not.toBeNull();
    update({ sourceType: "docs", workspaceValid: false });
    expect(screen.getByText("Select a document to preview")).not.toBeNull();
    expect(screen.queryByText("No valid workspace selected")).toBeNull();
  });
});

describe("LibraryView Rules", () => {
  it("lists the bundled rules template, read-only, with the targets it installs to", () => {
    const template = makeDoc("tpl", "tpl", "# Rules");
    renderLibrary({
      sourceType: "rules",
      agentTemplate: template,
      agentTargets: [
        { id: "claude_rules", label: "claude rules", harness: "claude", kind: "rules", source_rel: "a", target_rel: ".claude/CLAUDE.md" },
        { id: "claude_agents", label: "claude agents", harness: "claude", kind: "agents", source_rel: "a", target_rel: ".claude/agents" },
      ],
    });
    expect(within(listbox()).getAllByRole("option").map(option => option.querySelector(".nm")!.textContent)).toEqual(["Global Rules"]);
    expect(within(listbox()).getByText("bundled")).not.toBeNull();
    const meta = screen.getByRole("region", { name: "installs to" });
    expect(within(meta).getByText(".claude/CLAUDE.md")).not.toBeNull();
    expect(within(meta).queryByText(".claude/agents")).toBeNull();
    expect(screen.getByText(BUNDLED_REASON)).not.toBeNull();
    press(focusList(), "Enter");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Document" }));
  });

  function rulesFile(overrides: Partial<RulesFileContent> = {}): RulesFileContent {
    return {
      surface: "claude_rules",
      label: "Claude rules",
      file: "~/.claude/CLAUDE.md",
      layout: "block",
      conflict: null,
      malformed: null,
      refinement_lines: 2,
      editable: true,
      reason: null,
      before: "# Managed base heading\n\n- base rule\n",
      refinements: "## My refinements\n- answer in Swedish\n",
      revision: "sha256:r1",
      ...overrides,
    };
  }

  const LEGACY_REASON = "no base block: convert or install first (harness page, v)";
  const files: RulesFileSummary[] = [
    rulesFile(),
    rulesFile({ surface: "codex_rules", label: "Codex rules", file: "~/.codex/AGENTS.md", layout: "legacy", editable: false, reason: LEGACY_REASON }),
    rulesFile({ surface: "pi_rules", label: "Pi rules", file: "~/.pi/agent/AGENTS.md", conflict: "masked_by_override", editable: false, reason: "an override file in the same folder masks this file" }),
    rulesFile({ surface: "copilot_rules", label: "Copilot rules", file: "~/.copilot/copilot-instructions.md", layout: "absent", editable: false, reason: "no file yet: install rules from the harness page first" }),
  ];

  function openRulesFile(file: RulesFileContent, overrides: Partial<LibraryViewProps> = {}) {
    return renderLibrary({
      sourceType: "rules",
      agentTemplate: makeDoc("tpl", "tpl", "# Rules"),
      rulesFiles: files,
      activeRulesSurface: file.surface,
      activeRulesFile: file,
      rulesDraft: file.refinements,
      ...overrides,
    });
  }

  it("lists the user's rules files below the bundled base, with what each one allows", () => {
    vi.useFakeTimers();
    const onSelectRulesFile = vi.fn();
    renderLibrary({ sourceType: "rules", agentTemplate: makeDoc("tpl", "tpl", "# Rules"), rulesFiles: files, onSelectRulesFile });
    const rows = within(listbox()).getAllByRole("option");
    expect(rows.map(row => [row.querySelector(".nm")!.textContent, row.querySelector(".meta")!.textContent])).toEqual([
      ["Global Rules", "bundled"],
      ["Claude rules", "refinements"],
      ["Codex rules", "no base block"],
      ["Pi rules", "masked"],
      ["Copilot rules", "no file"],
    ]);
    expect(screen.getByText("bundled base")).not.toBeNull();
    expect(screen.getByText("your rules files")).not.toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /Claude rules/ }));
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onSelectRulesFile).toHaveBeenCalledWith("claude_rules");
  });

  it("lists no rules file while the workspace is not valid, and still shows the bundled base", () => {
    renderLibrary({ sourceType: "rules", agentTemplate: makeDoc("tpl", "tpl", "# Bundled rules"), rulesFiles: files, workspaceValid: false });
    expect(within(listbox()).getAllByRole("option").map(option => option.querySelector(".nm")!.textContent)).toEqual(["Global Rules"]);
    expect(screen.getByRole("heading", { name: "Bundled rules" })).not.toBeNull();
  });

  it("edits only the refinements: the managed base is shown read-only above them", () => {
    const onChangeRulesDraft = vi.fn();
    const onSaveDoc = vi.fn();
    const onOpenRulesFile = vi.fn();
    const file = rulesFile();
    openRulesFile(file, { onChangeRulesDraft, onSaveDoc, onOpenRulesFile });
    const pane = screen.getByRole("region", { name: "Document" });
    expect(pane.querySelector(".pane-title")!.textContent).toBe("Claude rules · ~/.claude/CLAUDE.md");
    const base = screen.getByRole("region", { name: "managed base · read-only" });
    expect(within(base).getByText("Managed base heading")).not.toBeNull();
    expect(within(pane.querySelector<HTMLElement>(".pane-foot")!).getByText("below the managed block only")).not.toBeNull();

    const editor = editDocument("Edit refinements");
    expect(editor.value).toBe(file.refinements);
    expect(editor.value).not.toContain("Managed base heading");
    fireEvent.change(editor, { target: { value: "## Mine\n" } });
    expect(onChangeRulesDraft).toHaveBeenCalledWith("## Mine\n");

    press(editor, "Escape");
    press(focusList(), "o");
    expect(onOpenRulesFile).toHaveBeenCalledWith("claude_rules");
    expect(onSaveDoc).not.toHaveBeenCalled();
  });

  it("saves the refinements through the rules handler, with Mod+s and :w", () => {
    const onSaveRules = vi.fn();
    const onSaveDoc = vi.fn();
    const file = rulesFile();
    openRulesFile(file, { rulesDraft: "## Changed\n", rulesDirty: true, onSaveRules, onSaveDoc });
    pressSave();
    expect(onSaveRules).toHaveBeenCalledTimes(1);
    focusList();
    runCommand("w");
    expect(onSaveRules).toHaveBeenCalledTimes(2);
    expect(onSaveDoc).not.toHaveBeenCalled();
  });

  it("shows why a rules file is not editable, offers no edit or save, and still opens an existing file", () => {
    const onSaveRules = vi.fn();
    const onOpenRulesFile = vi.fn();
    const legacy = { ...files[1]!, before: "", refinements: "", revision: null } as RulesFileContent;
    const { update } = openRulesFile(legacy, { onSaveRules, onOpenRulesFile });
    const footer = screen.getByRole("region", { name: "Document" }).querySelector<HTMLElement>(".pane-foot")!;
    expect(within(footer).getByText(LEGACY_REASON)).not.toBeNull();
    expect(screen.queryByRole("region", { name: "managed base · read-only" })).toBeNull();
    focusPane("Document");
    const edit = statusHint("↵ edit");
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("title")).toBe(LEGACY_REASON);
    press(document.activeElement!, "i");
    expect(screen.queryByLabelText("Edit refinements")).toBeNull();
    pressSave();
    focusList();
    runCommand("w");
    expect(screen.getByRole("alert").textContent).toContain(LEGACY_REASON);
    expect(onSaveRules).not.toHaveBeenCalled();
    press(screen.getByRole("combobox", { name: "Command" }), "Escape");
    press(focusList(), "o");
    expect(onOpenRulesFile).toHaveBeenCalledWith("codex_rules");

    // No file at all: nothing to open either.
    const absent = { ...files[3]!, before: "", refinements: "", revision: null } as RulesFileContent;
    update({ sourceType: "rules", rulesFiles: files, activeRulesSurface: absent.surface, activeRulesFile: absent, onOpenRulesFile });
    focusPane("Document");
    const open = statusHint("o open");
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.getAttribute("title")).toBe(absent.reason);
  });
});
