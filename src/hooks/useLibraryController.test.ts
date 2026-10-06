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

const docA: DocumentContent = {
  id: "doc-a",
  title: "Doc A",
  path: "docs/a.md",
  section: "docs",
  source: "workspace",
  content: "alpha",
};

const docB: DocumentContent = {
  id: "doc-b",
  title: "Doc B",
  path: "docs/b.md",
  section: "docs",
  source: "workspace",
  content: "beta",
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

  it("does not apply agent A save after selecting agent B", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));

    invoke.mockImplementation((cmd: string, args?: { filename?: string }) => {
      if (cmd === "read_agent_source" && args?.filename === "agent-a.md") return Promise.resolve(agentA);
      if (cmd === "read_agent_source" && args?.filename === "agent-b.md") return Promise.resolve(agentB);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.selectAgent("agent-a.md");
    });
    await act(async () => {
      result.current.onChangeAgentDraft("agent alpha edited");
    });

    let resolveSave: (value: ActionResult) => void = () => {};
    const savePromise = new Promise<ActionResult>(resolve => {
      resolveSave = resolve;
    });

    invoke.mockImplementation((cmd: string, args?: { filename?: string }) => {
      if (cmd === "read_agent_source") {
        return Promise.resolve(args?.filename === "agent-b.md" ? agentB : agentA);
      }
      if (cmd === "save_agent_source") return savePromise;
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    let saveHandle: Promise<void>;
    await act(async () => {
      saveHandle = result.current.onSaveAgent();
    });

    await act(async () => {
      await result.current.selectAgent("agent-b.md");
    });

    await act(async () => {
      resolveSave(successResult("save_agent_source"));
      await saveHandle!;
    });

    expect(result.current.activeAgentId).toBe("agent-b.md");
    expect(result.current.agentDraft).toBe("agent beta");
    expect(result.current.agentDirty).toBe(false);
    expect(result.current.agentSaving).toBe(false);
    expect(result.current.agentSaveResult).toBeNull();
  });

  it("clears dirty on unchanged document save when still current", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));

    invoke.mockImplementation((cmd: string, args?: { id?: string }) => {
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
      if (cmd === "save_agent_source") return Promise.resolve(successResult("save_agent_source", "unchanged"));
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
    expect(result.current.agentDraft).toBe("agent beta");

    await act(async () => {
      await result.current.onSaveAgent();
    });
    const saves = invoke.mock.calls.filter(([cmd]) => cmd === "save_agent_source");
    expect(saves).toEqual([["save_agent_source", { filename: "agent-b.md", content: "agent beta" }]]);
  });

  it("never saves the previous agent draft under a newly selected id while its content is loading", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));
    const slowRead = deferred<AgentSourceContent>();

    invoke.mockImplementation((cmd: string, args?: { filename?: string }) => {
      if (cmd === "read_agent_source" && args?.filename === "agent-a.md") return Promise.resolve(agentA);
      if (cmd === "read_agent_source" && args?.filename === "agent-b.md") return slowRead.promise;
      if (cmd === "save_agent_source") return Promise.resolve(successResult("save_agent_source", "unchanged"));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.selectAgent("agent-a.md");
    });
    let selectHandle: Promise<void>;
    await act(async () => {
      selectHandle = result.current.selectAgent("agent-b.md");
    });
    await act(async () => {
      await result.current.onSaveAgent();
    });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "save_agent_source")).toBe(false);

    await act(async () => {
      slowRead.resolve(agentB);
      await selectHandle!;
    });
    expect(result.current.activeAgentContent?.id).toBe("agent-b.md");
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

describe("useLibraryController agent draft survives reload", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("keeps an unsaved agent draft when the same agent is reloaded", async () => {
    const { deps } = createDeps();
    const { result } = renderHook(() => useLibraryController(deps));

    invoke.mockImplementation((cmd: string, args?: { filename?: string }) => {
      if (cmd === "list_agent_metadata") return Promise.resolve({ agents: [agentMeta(agentA)], warnings: [] });
      if (cmd === "read_agent_source" && args?.filename === "agent-a.md") return Promise.resolve({ ...agentA });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await act(async () => {
      await result.current.loadAgentSources();
    });
    await act(async () => {
      result.current.onChangeAgentDraft("agent alpha edited");
    });
    expect(result.current.agentDirty).toBe(true);

    // Re-clicking the Library tab reloads the agent as a fresh object with identical content.
    await act(async () => {
      await result.current.loadAgentSources();
    });

    expect(result.current.agentDraft).toBe("agent alpha edited");
    expect(result.current.agentDirty).toBe(true);
  });

  it("adopts reloaded agent content when the draft is clean", async () => {
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

    expect(result.current.agentDraft).toBe("agent alpha changed on disk");
    expect(result.current.agentDirty).toBe(false);
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
      await result.current.openDocEditor("doc-a");
      await result.current.openAgent("agent-a.md");
      result.current.openSkill("skill-a");
    });

    expect(invoke).toHaveBeenCalledWith("open_doc", { id: "doc-a" });
    expect(invoke).toHaveBeenCalledWith("open_agent_source", { filename: "agent-a.md" });
    expect(invoke).toHaveBeenCalledWith("open_skill", { id: "skill-a" });
    await waitFor(() => expect(deps.setError).toHaveBeenCalledTimes(3));
    expect(deps.setError).toHaveBeenCalledWith("Open doc: no default app");
    expect(deps.setError).toHaveBeenCalledWith("Open agent: no default app");
    expect(deps.setError).toHaveBeenCalledWith("Open: no default app");
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
