import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTargetMeta, DocsHealth, DocSummary, DocumentContent } from "../types";
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

afterEach(() => {
  cleanup();
});

describe("LibraryView Configs pane", () => {
  const configTargets: AgentTargetMeta[] = [
    { id: "opencode_config", label: "OpenCode config", harness: "opencode", kind: "config", source_rel: "templates/opencode.base.json", target_rel: "opencode.json" },
    { id: "codex_config", label: "Codex config", harness: "codex", kind: "config", source_rel: "templates/codex.toml", target_rel: "config.toml" },
  ];

  it("shows the editor source content for opencode_config", () => {
    render(
      <LibraryView
        {...baseProps({
          sourceType: "configs",
          configTargets,
          activeConfigTargetId: "opencode_config",
          configTemplateContent: null,
          configEditorSourceContent: makeDoc("base", "base", '{"opencode_marker": true}'),
        })}
      />,
    );
    expect(screen.getByText(/opencode_marker/)).not.toBeNull();
    expect(screen.queryByText("Select a config target to preview")).toBeNull();
    // The sidebar bundle group is gated on the same active content.
    expect(screen.getByText("OpenCode bundle")).not.toBeNull();
  });

  it("shows a loading state for opencode_config and then renders content", () => {
    const props = baseProps({
      sourceType: "configs",
      configTargets,
      activeConfigTargetId: "opencode_config",
      configEditorSourceContent: null,
    });
    const { rerender } = render(<LibraryView {...props} />);
    expect(screen.getByText("Loading config source...")).not.toBeNull();

    rerender(<LibraryView {...props} configEditorSourceContent={makeDoc("base", "base", '{"loaded_marker": 1}')} />);
    expect(screen.getByText(/loaded_marker/)).not.toBeNull();
  });

  it("shows the template content for other config targets", () => {
    render(
      <LibraryView
        {...baseProps({
          sourceType: "configs",
          configTargets,
          activeConfigTargetId: "codex_config",
          configTemplateContent: makeDoc("codex", "codex", 'model = "template_marker"'),
        })}
      />,
    );
    expect(screen.getByText(/template_marker/)).not.toBeNull();
    expect(screen.queryByText("OpenCode bundle")).toBeNull();
  });

  it("keeps the empty hint when a non-opencode target has no template yet", () => {
    render(
      <LibraryView
        {...baseProps({
          sourceType: "configs",
          configTargets,
          activeConfigTargetId: "codex_config",
          configTemplateContent: null,
        })}
      />,
    );
    expect(screen.getByText("Select a config target to preview")).not.toBeNull();
  });
});

describe("LibraryView Docs list", () => {
  const docs: DocSummary[] = [
    { id: "a", title: "Alpha", section: "Bundled", path: "docs/alpha.md", source: "bundled" },
    { id: "b", title: "Beta notes", section: "Context", path: "docs/context/beta.md", source: "custom" },
  ];

  it("groups documents by section, marks the active doc and tags custom context docs", () => {
    const { container } = render(
      <LibraryView {...baseProps({ docs, activeDoc: makeDoc("b", "Beta notes", "") })} />,
    );
    expect(screen.getByText("Bundled")).not.toBeNull();
    expect(screen.getByText("Context")).not.toBeNull();
    expect(container.querySelector(".lib-docs-list-item.active")?.textContent).toContain("Beta notes");
    expect(screen.getByText("context")).not.toBeNull();
  });

  it("filters the list by the search box", () => {
    render(<LibraryView {...baseProps({ docs })} />);
    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "alp" } });
    expect(screen.getByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta notes")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "zzz" } });
    expect(screen.getByText("No documents match the current filter.")).not.toBeNull();
  });

  it("selects a document on click", () => {
    const onSelectDoc = vi.fn();
    render(<LibraryView {...baseProps({ docs, onSelectDoc })} />);
    fireEvent.click(screen.getByRole("option", { name: /Beta notes/ }));
    expect(onSelectDoc).toHaveBeenCalledWith("b");
  });

  it("shows the stale banner only for a valid workspace with missing bundled docs", () => {
    const health: DocsHealth = { missing_count: 2, missing_prompt_template_docs: false, missing_sample: [] };
    const { rerender } = render(<LibraryView {...baseProps({ docs, docsHealth: health, workspaceValid: true })} />);
    expect(screen.getByText("Bundled docs need update")).not.toBeNull();

    rerender(<LibraryView {...baseProps({ docs, docsHealth: health, workspaceValid: false })} />);
    expect(screen.queryByText("Bundled docs need update")).toBeNull();

    rerender(<LibraryView {...baseProps({ docs, docsHealth: { ...health, missing_count: 0 }, workspaceValid: true })} />);
    expect(screen.queryByText("Bundled docs need update")).toBeNull();
  });
});
