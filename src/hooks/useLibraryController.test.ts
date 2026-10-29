import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../components/TerminalOutput";
import type {
  AgentMetadataResponse,
  AgentSourceContent,
  DocSummary,
  DocumentContent,
  RulesFileContent,
  RulesSurfaceId,
  SkillSummary,
} from "../types";
import { useLibraryController } from "./useLibraryController";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// The answer of the unsaved-changes dialog; tests set it. Discard by default: the loaders below never ask.
const choose = vi.fn(async (): Promise<"confirm" | "alternate" | "cancel"> => "alternate");
const confirm = vi.fn(async () => true);

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => confirm,
  useConfirmChoice: () => choose,
}));

// Personal docs: the only Library items with a draft and a save.
const docA: DocumentContent = {
  id: "doc-a",
  title: "Doc A",
  path: "docs/context/a.md",
  section: "Context",
  source: "custom",
  content: "alpha",
};

const docB: DocumentContent = {
  id: "doc-b",
  title: "Doc B",
  path: "docs/context/b.md",
  section: "Context",
  source: "custom",
  content: "beta",
};

const bundledDoc: DocumentContent = {
  id: "README.md",
  title: "Workspace README",
  path: "README.md",
  section: "Start",
  source: "curated",
  content: "bundled",
};

const agentA: AgentSourceContent = {
  id: "agent-a.md",
  title: "Agent A",
  path: "agents/a.md",
  content: "agent alpha",
  exists: true,
};

const agentB: AgentSourceContent = {
  id: "agent-b.md",
  title: "Agent B",
  path: "agents/b.md",
  content: "agent beta",
  exists: true,
};

function createDeps(workspaceGeneration = 0) {
  const workspaceLoadGenerationRef = { current: workspaceGeneration };
  return {
    deps: {
      setError: vi.fn(),
      workspaceLoadGenerationRef,
      isWorkspaceLoadCurrent: (generation: number) => generation === workspaceLoadGenerationRef.current,
      isInvalidWorkspaceError: () => false,
      view: "library",
    },
    workspaceLoadGenerationRef,
  };
}

function successResult(action: string, stdout = "saved"): ActionResult {
  return { success: true, action, stdout, stderr: "", exit_code: 0 };
}

describe("useLibraryController save operation identity", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("does not apply document A save after selecting document B", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));

    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === "read_doc" && args?.id === "doc-a") return Promise.resolve(docA);
      if (cmd === "read_doc" && args?.id === "doc-b") return Promise.resolve(docB);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.selectDoc("doc-a");
    });
    await act(async () => {
      result.current.onChangeDocDraft("alpha edited");
    });

    let resolveSave: (value: ActionResult) => void = () => {};
    const savePromise = new Promise<ActionResult>(resolve => {
      resolveSave = resolve;
    });

    invoke.mockImplementation((cmd: string, args?: { id?: string; content?: string }) => {
      if (cmd === "read_doc" && args?.id === "doc-a") return Promise.resolve(docA);
      if (cmd === "read_doc" && args?.id === "doc-b") return Promise.resolve(docB);
      if (cmd === "save_doc") return savePromise;
      if (cmd === "read_doc" && args?.id === "doc-a") {
        return Promise.resolve({ ...docA, content: "alpha saved" });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let saveHandle: Promise<boolean>;
    await act(async () => {
      saveHandle = result.current.onSaveDoc();
    });

    await act(async () => {
      await result.current.selectDoc("doc-b");
    });

    await act(async () => {
      resolveSave(successResult("save_doc"));
      await saveHandle!;
    });

    expect(result.current.activeDoc?.id).toBe("doc-b");
    expect(result.current.docDraft).toBe("beta");
    expect(result.current.docDirty).toBe(false);
    expect(result.current.docSaving).toBe(false);
    // A stale "saved" banner for document A must not show up on document B.
    expect(result.current.docSaveResult).toBeNull();
  });

  it("clears dirty on unchanged document save when still current", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));

    invoke.mockImplementation((cmd: string) => {
      if (cmd === "read_doc") return Promise.resolve(docA);
      if (cmd === "save_doc") return Promise.resolve(successResult("save_doc", "unchanged"));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.selectDoc("doc-a");
      result.current.onChangeDocDraft("alpha edited");
      await result.current.onSaveDoc();
    });

    await waitFor(() => expect(result.current.docSaving).toBe(false));
    expect(result.current.docDirty).toBe(false);
    expect(result.current.activeDoc?.id).toBe("doc-a");
  });

  it("invalidates in-flight document save when workspace generation changes", async () => {
    const { deps, workspaceLoadGenerationRef } = createDeps(0);
    const { result } = renderHook(() => useLibraryController(deps));

    invoke.mockImplementation((cmd: string) => {
      if (cmd === "read_doc") return Promise.resolve(docA);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.selectDoc("doc-a");
      result.current.onChangeDocDraft("alpha edited");
    });

    let resolveSave: (value: ActionResult) => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "save_doc") {
        return new Promise<ActionResult>(resolve => {
          resolveSave = resolve;
        });
      }
      if (cmd === "read_doc") return Promise.resolve(docA);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let saveHandle: Promise<boolean>;
    await act(async () => {
      saveHandle = result.current.onSaveDoc();
      workspaceLoadGenerationRef.current = 1;
      result.current.resetLibraryState();
    });

    await act(async () => {
      resolveSave(successResult("save_doc"));
      await saveHandle!;
    });

    expect(result.current.docSaving).toBe(false);
    expect(result.current.activeDoc).toBeNull();
  });

  it("never sends a bundled doc to save_doc, even with an edited draft", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "read_doc") return Promise.resolve(bundledDoc);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.selectDoc("README.md");
      result.current.onChangeDocDraft("edited");
      await result.current.onSaveDoc();
    });

    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["read_doc"]);
    expect(result.current.docSaving).toBe(false);
  });
});

function rulesFile(surface: RulesSurfaceId, overrides: Partial<RulesFileContent> = {}): RulesFileContent {
  return {
    surface,
    label: surface,
    file: `~/${surface}.md`,
    layout: "block",
    conflict: null,
    malformed: null,
    refinement_lines: 1,
    editable: true,
    reason: null,
    before: "base\n",
    refinements: `${surface} refinements\n`,
    revision: `rev-${surface}-1`,
    ...overrides,
  };
}

describe("useLibraryController rules refinements", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  const claude = rulesFile("claude_rules");
  const codex = rulesFile("codex_rules");

  function reads(files: Record<string, RulesFileContent>) {
    return (cmd: string, args?: { surface?: string }) => {
      if (cmd === "read_rules_file" && args?.surface && files[args.surface]) return Promise.resolve(files[args.surface]);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    };
  }

  it("drafts the refinements of the open file and saves them with the revision it was opened with", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const saved = rulesFile("claude_rules", { refinements: "new\n", revision: "rev-claude_rules-2" });
    invoke.mockImplementation(reads({ claude_rules: claude }));
    await act(async () => {
      await result.current.selectRulesFile("claude_rules");
    });
    expect(result.current.rulesDraft).toBe(claude.refinements);
    expect(result.current.rulesDirty).toBe(false);

    await act(async () => {
      result.current.onChangeRulesDraft("new\n");
    });
    expect(result.current.rulesDirty).toBe(true);
    expect(result.current.libraryDirty).toBe(true);

    invoke.mockImplementation((cmd: string, args?: { surface?: string }) => {
      if (cmd === "save_rules_refinements") return Promise.resolve(successResult(cmd, "saved with backup"));
      return reads({ claude_rules: saved })(cmd, args);
    });
    await act(async () => {
      await result.current.onSaveRules();
    });
    expect(invoke).toHaveBeenCalledWith("save_rules_refinements", {
      surface: "claude_rules",
      content: "new\n",
      expectedRevision: "rev-claude_rules-1",
    });
    expect(result.current.activeRulesFile?.revision).toBe("rev-claude_rules-2");
    expect(result.current.rulesDraft).toBe("new\n");
    expect(result.current.rulesDirty).toBe(false);
    expect(result.current.rulesSaveResult?.stdout).toBe("saved with backup");
  });

  it("does not apply file A's save after file B was opened", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation(reads({ claude_rules: claude, codex_rules: codex }));
    await act(async () => {
      await result.current.selectRulesFile("claude_rules");
      result.current.onChangeRulesDraft("edited\n");
    });

    const save = deferred<ActionResult>();
    invoke.mockImplementation((cmd: string, args?: { surface?: string }) => {
      if (cmd === "save_rules_refinements") return save.promise;
      return reads({ claude_rules: claude, codex_rules: codex })(cmd, args);
    });
    let saveHandle: Promise<boolean>;
    await act(async () => {
      saveHandle = result.current.onSaveRules();
    });
    await act(async () => {
      await result.current.selectRulesFile("codex_rules");
    });
    await act(async () => {
      save.resolve(successResult("save_rules_refinements", "saved with backup"));
      await saveHandle!;
    });

    expect(result.current.activeRulesSurface).toBe("codex_rules");
    expect(result.current.rulesDraft).toBe(codex.refinements);
    expect(result.current.rulesDirty).toBe(false);
    expect(result.current.rulesSaving).toBe(false);
    expect(result.current.rulesSaveResult).toBeNull();
  });

  it("drops an in-flight save when the workspace changes", async () => {
    const { deps, workspaceLoadGenerationRef } = createDeps(0);
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation(reads({ claude_rules: claude }));
    await act(async () => {
      await result.current.selectRulesFile("claude_rules");
      result.current.onChangeRulesDraft("edited\n");
    });
    const save = deferred<ActionResult>();
    invoke.mockImplementation((cmd: string, args?: { surface?: string }) =>
      cmd === "save_rules_refinements" ? save.promise : reads({ claude_rules: claude })(cmd, args),
    );
    let saveHandle: Promise<boolean>;
    await act(async () => {
      saveHandle = result.current.onSaveRules();
      workspaceLoadGenerationRef.current = 1;
      result.current.resetLibraryState();
    });
    await act(async () => {
      save.resolve(successResult("save_rules_refinements", "saved with backup"));
      await saveHandle!;
    });
    expect(result.current.rulesSaving).toBe(false);
    expect(result.current.activeRulesSurface).toBeNull();
    expect(result.current.activeRulesFile).toBeNull();
    expect(result.current.rulesSaveResult).toBeNull();
  });

  it("clears dirty on an unchanged save without reading the file again", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation(reads({ claude_rules: claude }));
    await act(async () => {
      await result.current.selectRulesFile("claude_rules");
      result.current.onChangeRulesDraft("edited\n");
    });
    invoke.mockClear();
    invoke.mockImplementation((cmd: string) =>
      cmd === "save_rules_refinements" ? Promise.resolve(successResult(cmd, "unchanged")) : Promise.reject(new Error(cmd)),
    );
    await act(async () => {
      await result.current.onSaveRules();
    });
    expect(result.current.rulesDirty).toBe(false);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["save_rules_refinements"]);
  });

  it("keeps the draft and takes the new revision when the file changed on disk", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation(reads({ claude_rules: claude }));
    await act(async () => {
      await result.current.selectRulesFile("claude_rules");
      result.current.onChangeRulesDraft("my draft\n");
    });
    const outside = rulesFile("claude_rules", { refinements: "written elsewhere\n", revision: "rev-claude_rules-9" });
    invoke.mockImplementation((cmd: string, args?: { surface?: string }) => {
      if (cmd === "save_rules_refinements") {
        return Promise.reject("Claude rules: nothing written: the file changed on disk since it was opened: reload it");
      }
      return reads({ claude_rules: outside })(cmd, args);
    });
    await act(async () => {
      await result.current.onSaveRules();
    });
    expect(result.current.rulesDraft).toBe("my draft\n");
    expect(result.current.rulesDirty).toBe(true);
    expect(result.current.activeRulesFile?.revision).toBe("rev-claude_rules-9");
    expect(result.current.rulesSaveResult).toMatchObject({ success: false, stderr: "changed on disk: reloaded, save again to overwrite" });

    // Saving again sends the draft with the revision of the file as it is now.
    invoke.mockImplementation((cmd: string, args?: { surface?: string }) =>
      cmd === "save_rules_refinements"
        ? Promise.resolve(successResult(cmd, "saved with backup"))
        : reads({ claude_rules: { ...outside, refinements: "my draft\n" } })(cmd, args),
    );
    await act(async () => {
      await result.current.onSaveRules();
    });
    expect(invoke).toHaveBeenCalledWith("save_rules_refinements", {
      surface: "claude_rules",
      content: "my draft\n",
      expectedRevision: "rev-claude_rules-9",
    });
  });

  it("never sends a file the backend called not editable", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const legacy = rulesFile("codex_rules", { layout: "legacy", editable: false, reason: "no base block", revision: null });
    invoke.mockImplementation(reads({ codex_rules: legacy }));
    await act(async () => {
      await result.current.selectRulesFile("codex_rules");
      result.current.onChangeRulesDraft("edited\n");
      await result.current.onSaveRules();
    });
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["read_rules_file"]);
  });

  it("never sends a file the Library shows as a conflict, even when the backend called it editable", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const edited = rulesFile("codex_rules", { conflict: "base_block_edited" });
    invoke.mockImplementation(reads({ codex_rules: edited }));
    await act(async () => {
      await result.current.selectRulesFile("codex_rules");
    });
    let saved = true;
    await act(async () => {
      result.current.onChangeRulesDraft("edited\n");
      saved = await result.current.onSaveRules();
    });
    expect(saved).toBe(false);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["read_rules_file"]);
  });

  it("returns to the bundled base when the open file's harness is switched off", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation(reads({ claude_rules: claude }));
    await act(async () => {
      await result.current.selectRulesFile("claude_rules");
    });
    invoke.mockImplementation((cmd: string) =>
      cmd === "list_rules_files" ? Promise.resolve([rulesFile("codex_rules")]) : Promise.reject(new Error(cmd)),
    );
    await act(async () => {
      await result.current.loadRulesFiles();
    });
    expect(result.current.activeRulesSurface).toBeNull();
    expect(result.current.activeRulesFile).toBeNull();
    expect(result.current.rulesFiles.map(file => file.surface)).toEqual(["codex_rules"]);
  });
});

function agentMeta(content: AgentSourceContent): AgentMetadataResponse {
  return { id: content.id, title: content.title, path: content.path, exists: true, metadata: null };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useLibraryController loaders vs. selection", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("keeps the newly selected agent when a slower agent source load resolves later", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const slowRead = deferred<AgentSourceContent>();

    invoke.mockImplementation((cmd: string, args?: { filename?: string; content?: string }) => {
      if (cmd === "list_agent_metadata") {
        return Promise.resolve({ agents: [agentMeta(agentA), agentMeta(agentB)], warnings: [] });
      }
      if (cmd === "read_agent_source" && args?.filename === "agent-a.md") return slowRead.promise;
      if (cmd === "read_agent_source" && args?.filename === "agent-b.md") return Promise.resolve(agentB);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let loadHandle: Promise<void>;
    await act(async () => {
      loadHandle = result.current.loadAgentSources();
    });
    await waitFor(() => expect(result.current.activeAgentId).toBe("agent-a.md"));

    await act(async () => {
      await result.current.selectAgent("agent-b.md");
    });
    await act(async () => {
      slowRead.resolve(agentA);
      await loadHandle!;
    });

    expect(result.current.activeAgentId).toBe("agent-b.md");
    expect(result.current.activeAgentContent?.id).toBe("agent-b.md");
    expect(result.current.activeAgentContent?.content).toBe("agent beta");
  });

  it("keeps the selected doc when a slower doc list load resolves later", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const slowRead = deferred<DocumentContent>();
    const summaries: DocSummary[] = [docA, docB].map(d => ({
      id: d.id, title: d.title, path: d.path, section: d.section, source: d.source,
    }));

    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === "list_docs") return Promise.resolve(summaries);
      if (cmd === "read_doc" && args?.id === "doc-a") return slowRead.promise;
      if (cmd === "read_doc" && args?.id === "doc-b") return Promise.resolve(docB);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let loadHandle: Promise<void>;
    await act(async () => {
      loadHandle = result.current.loadDocs();
    });
    await act(async () => {
      await result.current.selectDoc("doc-b");
    });
    await act(async () => {
      slowRead.resolve(docA);
      await loadHandle!;
    });

    expect(result.current.activeDoc?.id).toBe("doc-b");
    expect(result.current.docDraft).toBe("beta");
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("get_docs_health");
  });

  it("keeps the selected skill when a slower skill list load resolves later", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const slowRead = deferred<DocumentContent>();
    const skill = (id: string): SkillSummary => ({
      id, name: id, description: "", path: `skills/${id}`, group: "g", category: "c", risk: "low", targets: [], related: [],
    });
    const skillDoc = (id: string): DocumentContent => ({ ...docA, id, title: id, content: `body ${id}` });

    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === "list_skills") return Promise.resolve([skill("s1"), skill("s2")]);
      if (cmd === "read_skill" && args?.id === "s1") return slowRead.promise;
      if (cmd === "read_skill" && args?.id === "s2") return Promise.resolve(skillDoc("s2"));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let loadHandle: Promise<void>;
    await act(async () => {
      loadHandle = result.current.loadSkills();
    });
    await act(async () => {
      await result.current.readSkill("s2");
    });
    await act(async () => {
      slowRead.resolve(skillDoc("s1"));
      await loadHandle!;
    });

    expect(result.current.activeSkillId).toBe("s2");
    expect(result.current.activeSkillContent?.id).toBe("s2");
  });
});

describe("useLibraryController agent reload", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("shows the reloaded agent content", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    let content = "agent alpha";

    invoke.mockImplementation((cmd: string, args?: { filename?: string }) => {
      if (cmd === "list_agent_metadata") return Promise.resolve({ agents: [agentMeta(agentA)], warnings: [] });
      if (cmd === "read_agent_source" && args?.filename === "agent-a.md") return Promise.resolve({ ...agentA, content });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.loadAgentSources();
    });
    content = "agent alpha changed on disk";
    await act(async () => {
      await result.current.loadAgentSources();
    });

    expect(result.current.activeAgentContent?.content).toBe("agent alpha changed on disk");
    expect(result.current.libraryDirty).toBe(false);
  });
});

describe("useLibraryController open actions", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("reports a soft failure from the OS opener", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockResolvedValue({ success: false, action: "open_doc", stdout: "", stderr: "no default app", exit_code: 1 });

    await act(async () => {
      await result.current.openDocEditor("custom:doc-a");
    });

    expect(invoke).toHaveBeenCalledWith("open_doc", { id: "custom:doc-a" });
    await waitFor(() => expect(deps.setError).toHaveBeenCalledTimes(1));
    expect(deps.setError).toHaveBeenCalledWith("Open doc: no default app");
  });

  it("stays quiet when the opener succeeds", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockResolvedValue(successResult("open_doc", ""));

    await act(async () => {
      await result.current.openDocEditor("doc-a");
    });

    expect(deps.setError).not.toHaveBeenCalled();
  });
});

describe("useLibraryController workspace switch", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  const configSource = (content: string): DocumentContent => ({
    id: "opencode_config:base",
    title: "OpenCode config",
    path: "config/opencode.json",
    section: "config",
    source: "curated",
    content,
  });

  function backend(workspace: { config: string; template: string }) {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_opencode_config_editor_sources") return Promise.resolve([]);
      if (cmd === "read_opencode_config_source") return Promise.resolve(configSource(workspace.config));
      if (cmd === "read_agent_template") {
        return Promise.resolve({ ...docA, id: "agent-template", source: "curated", content: workspace.template });
      }
      if (cmd === "list_skills" || cmd === "list_docs" || cmd === "list_rules_files") return Promise.resolve([]);
      if (cmd === "list_agent_metadata") return Promise.resolve({ agents: [] });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
  }

  it("drops workspace A's OpenCode config source and reloads the sources for workspace B", async () => {
    const { deps, workspaceLoadGenerationRef } = createDeps(0);
    const { result } = renderHook(() => useLibraryController(deps));
    backend({ config: "config of A", template: "rules of A" });

    await act(async () => {
      result.current.setActiveConfigTargetId("opencode_config");
      await result.current.setGuardedLibrarySourceType("configs");
    });
    await waitFor(() => expect(result.current.configEditorSourceContent?.content).toBe("config of A"));

    // The workspace folder changes to B (a reset to the default folder): the reset runs first, the reload follows.
    backend({ config: "config of B", template: "rules of B" });
    await act(async () => {
      workspaceLoadGenerationRef.current = 1;
      result.current.resetLibraryState();
    });
    expect(result.current.configEditorSourceContent).toBeNull();

    await act(async () => {
      await result.current.loadWorkspaceLibraryResources(1);
    });
    await waitFor(() => expect(result.current.configEditorSourceContent?.content).toBe("config of B"));
    expect(result.current.agentTemplate?.content).toBe("rules of B");
  });
});

/** Commands that existed to edit or open bundled items; the backend no longer registers them. */
const REMOVED_COMMANDS = [
  "save_agent_template",
  "save_agent_source",
  "save_opencode_config_source",
  "open_agent_template",
  "open_agent_source",
  "open_config_template",
  "open_opencode_config_source",
  "open_skill",
  // The bundle cannot miss a doc: there is no "docs need update" state to read.
  "get_docs_health",
];

describe("useLibraryController bundled items stay read-only", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("walks every source and opens every item without invoking a write or a removed command", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const docSummary = (doc: DocumentContent): DocSummary => ({
      id: doc.id, title: doc.title, path: doc.path, section: doc.section, source: doc.source,
    });
    const skill: SkillSummary = {
      id: "s1", name: "s1", description: "", path: "skills/s1/SKILL.md", group: "g", category: "c", risk: "low", targets: [], related: [],
    };
    invoke.mockImplementation((cmd: string, args?: { id?: string; filename?: string }) => {
      switch (cmd) {
        case "list_docs": return Promise.resolve([docSummary(bundledDoc), docSummary(docA)]);
        case "read_doc": return Promise.resolve(args?.id === docA.id ? docA : bundledDoc);
        case "list_skills": return Promise.resolve([skill]);
        case "read_skill": return Promise.resolve({ ...bundledDoc, id: "s1", content: "skill" });
        case "list_agent_metadata": return Promise.resolve({ agents: [agentMeta(agentA)], warnings: [] });
        case "read_agent_source": return Promise.resolve(agentA);
        case "read_agent_template": return Promise.resolve({ ...bundledDoc, id: "agent-template" });
        case "list_opencode_config_editor_sources": return Promise.resolve([]);
        case "read_opencode_config_source": return Promise.resolve({ ...bundledDoc, id: "opencode_config:base" });
        case "read_config_template": return Promise.resolve({ ...bundledDoc, id: "config-template:codex_config" });
        case "list_rules_files": return Promise.resolve([rulesFile("claude_rules")]);
        case "read_rules_file": return Promise.resolve(rulesFile("claude_rules"));
        default: return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
      }
    });

    await act(async () => {
      result.current.loadLibraryView();
    });
    await waitFor(() => expect(result.current.activeAgentContent?.id).toBe("agent-a.md"));
    for (const type of ["rules", "skills", "agents", "configs", "docs"] as const) {
      await act(async () => {
        await result.current.setGuardedLibrarySourceType(type);
      });
    }
    await act(async () => {
      await result.current.selectDoc("README.md");
      result.current.onChangeDocDraft("edited bundled doc");
      await result.current.onSaveDoc();
      await result.current.readSkill("s1");
      // Opening and leaving a rules file without an edit writes nothing.
      await result.current.selectRulesFile("claude_rules");
      await result.current.selectRulesFile(null);
      await result.current.selectAgent("agent-a.md");
      result.current.setActiveConfigTargetId("opencode_config");
      await result.current.setGuardedLibrarySourceType("configs");
      result.current.selectConfigSourceType("policy");
      result.current.selectConfigTarget("codex_config");
    });
    await waitFor(() => expect(result.current.configTemplateContent?.id).toBe("config-template:codex_config"));

    const commands = invoke.mock.calls.map(([cmd]) => cmd as string);
    for (const removed of REMOVED_COMMANDS) expect(commands).not.toContain(removed);
    expect(commands.filter(cmd => /^(save|create|write|apply|open)_/.test(cmd))).toEqual([]);
  });
});

describe("useLibraryController leaving with unsaved changes", () => {
  beforeEach(() => {
    invoke.mockReset();
    choose.mockReset();
    choose.mockResolvedValue("alternate");
  });

  async function openEditedDoc() {
    const { deps } = createDeps();
    const hook = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "read_doc") return Promise.resolve(docA);
      if (cmd === "save_doc") return Promise.resolve(successResult("save_doc"));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    await act(async () => {
      await hook.result.current.selectDoc("doc-a");
    });
    await act(async () => {
      hook.result.current.onChangeDocDraft("alpha edited");
    });
    expect(hook.result.current.libraryDirty).toBe(true);
    return hook.result;
  }

  it("drops the draft and the dirty mark when a confirmed leave discards it, and on a source switch that discards", async () => {
    const result = await openEditedDoc();

    await act(async () => {
      result.current.discardDrafts();
    });
    expect(result.current.libraryDirty).toBe(false);
    expect(result.current.docDraft).toBe("alpha");

    await act(async () => {
      result.current.onChangeDocDraft("alpha edited again");
    });
    expect(result.current.libraryDirty).toBe(true);
    await act(async () => {
      await result.current.setGuardedLibrarySourceType("skills");
    });
    expect(choose).toHaveBeenCalledTimes(1);
    expect(result.current.libraryDirty).toBe(false);
    expect(result.current.docDraft).toBe("alpha");
    expect(result.current.librarySourceType).toBe("skills");
  });

  it("asks nothing while nothing is unsaved", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    let allowed = false;
    await act(async () => {
      allowed = await result.current.confirmLeave();
    });
    expect(allowed).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps the draft and the topic on Keep editing", async () => {
    const result = await openEditedDoc();
    choose.mockResolvedValue("cancel");
    await act(async () => {
      await result.current.setGuardedLibrarySourceType("skills");
    });
    expect(result.current.librarySourceType).toBe("rules");
    expect(result.current.libraryDirty).toBe(true);
    expect(result.current.docDraft).toBe("alpha edited");
  });

  it("writes the draft on Save and continue, and only then lets the caller go on", async () => {
    const result = await openEditedDoc();
    choose.mockResolvedValue("confirm");
    let allowed = false;
    await act(async () => {
      allowed = await result.current.confirmLeave();
    });
    expect(allowed).toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_doc", { id: "doc-a", content: "alpha edited" });
    expect(result.current.libraryDirty).toBe(false);
  });

  it("stays when the save of Save and continue fails", async () => {
    const result = await openEditedDoc();
    choose.mockResolvedValue("confirm");
    invoke.mockImplementation((cmd: string) =>
      cmd === "save_doc" ? Promise.reject(new Error("disk full")) : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    let allowed = true;
    await act(async () => {
      allowed = await result.current.confirmLeave();
    });
    expect(allowed).toBe(false);
    expect(result.current.libraryDirty).toBe(true);
  });

  it("asks only once when a discard is followed at once by the move it was for", async () => {
    const result = await openEditedDoc();
    await act(async () => {
      expect(await result.current.confirmLeave()).toBe(true);
      // The caller's closure still says dirty; the guard reads the settled draft.
      await result.current.selectDoc("doc-b");
    });
    expect(choose).toHaveBeenCalledTimes(1);
  });
});

describe("useLibraryController skills of the personal pack", () => {
  const personal: DocumentContent = { id: "pack:personal/mine", title: "mine", path: "skills/mine/SKILL.md", section: "pack:personal", source: "pack", content: "one" };
  const other: DocumentContent = { ...personal, id: "pack:team/shared", title: "shared" };

  beforeEach(() => {
    invoke.mockReset();
    choose.mockReset();
    choose.mockResolvedValue("alternate");
  });

  it("saves the draft of a personal skill and takes the text the backend now has", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "read_skill") return Promise.resolve(personal);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    await act(async () => {
      await result.current.readSkill(personal.id);
    });
    await act(async () => {
      result.current.onChangeSkillDraft("two");
    });
    expect(result.current.skillDirty).toBe(true);
    expect(result.current.libraryDirty).toBe(true);

    invoke.mockImplementation((cmd: string) => {
      if (cmd === "save_pack_skill") return Promise.resolve(successResult(cmd, "saved with backup"));
      if (cmd === "read_skill") return Promise.resolve({ ...personal, content: "two" });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    let saved = false;
    await act(async () => {
      saved = await result.current.onSaveSkill();
    });
    expect(saved).toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_pack_skill", { id: personal.id, content: "two" });
    expect(result.current.skillDirty).toBe(false);
    expect(result.current.skillDraft).toBe("two");
  });

  it("never sends a skill of another pack to be saved", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => (cmd === "read_skill" ? Promise.resolve(other) : Promise.reject(new Error(`unexpected invoke: ${cmd}`))));
    await act(async () => {
      await result.current.readSkill(other.id);
    });
    let saved = true;
    await act(async () => {
      saved = await result.current.onSaveSkill();
    });
    expect(saved).toBe(false);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "save_pack_skill")).toBe(false);
  });

  it("copies a bundled skill and lists the skills again; a refusal is thrown for the dialog", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "copy_skill_to_pack") return Promise.resolve({ id: "pack:personal/tdd-mine", name: "tdd-mine", pack: "personal", path: "~/x" });
      if (cmd === "list_skills" || cmd === "list_pack_skills") return Promise.resolve(cmd === "list_skills" ? [] : { folder: "f", packs: [], skills: [], ignored: [] });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    let copy: { id: string } | null = null;
    await act(async () => {
      copy = await result.current.copySkillToPack("tdd", "tdd-mine");
    });
    expect(copy).toMatchObject({ id: "pack:personal/tdd-mine" });
    expect(invoke).toHaveBeenCalledWith("copy_skill_to_pack", { name: "tdd", newName: "tdd-mine" });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "list_pack_skills")).toBe(true);

    invoke.mockImplementation(() => Promise.reject("a pack already has a skill with this name"));
    await expect(result.current.copySkillToPack("tdd", "x")).rejects.toBe("a pack already has a skill with this name");
  });
});

describe("useLibraryController drafts and reads", () => {
  beforeEach(() => {
    invoke.mockReset();
    choose.mockReset();
    choose.mockResolvedValue("alternate");
  });

  it("takes the text of a doc read again after an edit made elsewhere, while nothing is unsaved", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => (cmd === "read_doc" ? Promise.resolve(docA) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.selectDoc("doc-a");
    });
    invoke.mockImplementation((cmd: string) => (cmd === "read_doc" ? Promise.resolve({ ...docA, content: "alpha from outside" }) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.selectDoc("doc-a");
    });
    expect(result.current.docDraft).toBe("alpha from outside");
    expect(result.current.docDirty).toBe(false);
  });

  it("keeps unsaved edits of a doc when a read of it finishes", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => (cmd === "read_doc" ? Promise.resolve(docA) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.selectDoc("doc-a");
    });
    await act(async () => {
      result.current.onChangeDocDraft("mine");
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_docs") return Promise.resolve([{ id: "doc-a", title: "Doc A", path: "p", section: "Context", source: "custom" }]);
      if (cmd === "read_doc") return Promise.resolve({ ...docA, content: "alpha from outside" });
      return Promise.reject(new Error(cmd));
    });
    await act(async () => {
      await result.current.loadDocs();
    });
    expect(result.current.docDraft).toBe("mine");
    expect(result.current.docDirty).toBe(true);
  });

  it("takes the text of a skill read again, and keeps a skill draft that is unsaved", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const skill: DocumentContent = { id: "pack:personal/mine", title: "mine", path: "p", section: "", source: "pack", content: "one" };
    invoke.mockImplementation((cmd: string) => (cmd === "read_skill" ? Promise.resolve(skill) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.readSkill(skill.id);
    });
    invoke.mockImplementation((cmd: string) => (cmd === "read_skill" ? Promise.resolve({ ...skill, content: "two" }) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.readSkill(skill.id);
    });
    expect(result.current.skillDraft).toBe("two");
    await act(async () => {
      result.current.onChangeSkillDraft("three");
    });
    invoke.mockImplementation((cmd: string) => (cmd === "read_skill" ? Promise.resolve({ ...skill, content: "four" }) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.readSkill(skill.id);
    });
    expect(result.current.skillDraft).toBe("three");
    expect(result.current.skillDirty).toBe(true);
  });

  it("stays and says why when Save and continue could not write", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string) => (cmd === "read_doc" ? Promise.resolve(docA) : Promise.reject(new Error(cmd))));
    await act(async () => {
      await result.current.selectDoc("doc-a");
    });
    await act(async () => {
      result.current.onChangeDocDraft("edited");
    });
    choose.mockResolvedValue("confirm");
    invoke.mockImplementation((cmd: string) => (cmd === "save_doc" ? Promise.reject(new Error("disk full")) : Promise.reject(new Error(cmd))));
    let allowed = true;
    await act(async () => {
      allowed = await result.current.confirmLeave();
    });
    expect(allowed).toBe(false);
    expect(result.current.docDirty).toBe(true);
    expect(result.current.docSaveResult).toMatchObject({ success: false });
    expect(result.current.docSaveResult?.stderr).toContain("disk full");
  });

  it("keeps the source chosen with the switch to OpenCode's config, which is not a first visit", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    invoke.mockImplementation((cmd: string, args?: { sourceType?: string }) => {
      if (cmd === "read_config_template") return Promise.resolve({ ...bundledDoc, id: "config-template:codex_config" });
      if (cmd === "list_opencode_config_editor_sources") return Promise.resolve([]);
      if (cmd === "read_opencode_config_source") return Promise.resolve({ ...bundledDoc, id: `opencode_config:${args?.sourceType}` });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    await act(async () => {
      result.current.setActiveConfigTargetId("codex_config");
    });
    await waitFor(() => expect(result.current.configTemplateContent?.id).toBe("config-template:codex_config"));
    await act(async () => {
      result.current.selectConfigTarget("opencode_config");
      result.current.selectConfigSourceType("policy");
    });
    await waitFor(() => expect(result.current.configEditorSourceContent?.id).toBe("opencode_config:policy"));
    expect(result.current.activeConfigSourceType).toBe("policy");
  });
});
