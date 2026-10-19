import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentMetadataResponse, AgentSourceContent, DocSummary, DocumentContent, SkillSummary } from "../types";
import { useLibraryController } from "./useLibraryController";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(async () => true),
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
      fetchStatus: vi.fn(async () => {}),
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

    let saveHandle: Promise<void>;
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

    let saveHandle: Promise<void>;
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
      if (cmd === "get_docs_health") return Promise.resolve(null);
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
      if (cmd === "list_skills" || cmd === "list_docs") return Promise.resolve([]);
      if (cmd === "list_agent_metadata") return Promise.resolve({ agents: [] });
      if (cmd === "get_docs_health") return Promise.resolve(null);
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

    // `:workspace choose` accepts workspace B: the reset runs first, the reload follows.
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
        case "get_docs_health": return Promise.resolve(null);
        case "read_doc": return Promise.resolve(args?.id === docA.id ? docA : bundledDoc);
        case "list_skills": return Promise.resolve([skill]);
        case "read_skill": return Promise.resolve({ ...bundledDoc, id: "s1", content: "skill" });
        case "list_agent_metadata": return Promise.resolve({ agents: [agentMeta(agentA)], warnings: [] });
        case "read_agent_source": return Promise.resolve(agentA);
        case "read_agent_template": return Promise.resolve({ ...bundledDoc, id: "agent-template" });
        case "list_opencode_config_editor_sources": return Promise.resolve([]);
        case "read_opencode_config_source": return Promise.resolve({ ...bundledDoc, id: "opencode_config:base" });
        case "read_config_template": return Promise.resolve({ ...bundledDoc, id: "config-template:codex_config" });
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
