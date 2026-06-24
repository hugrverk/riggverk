import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentSourceContent, DocumentContent } from "../types";
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
    vi.stubGlobal("confirm", () => true);
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
