import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useState, type MutableRefObject } from "react";
import { buildBrainSetupBlock } from "../lib/brainSetup";
import { isInvalidWorkspaceError } from "../lib/workspaceErrors";
import type {
  BrainSetupSeedResult,
  CodexRuntimeHealth,
  CursorProfileHealth,
  OpenCodeRuntimeHealth,
  StatusData,
  WorkspaceDiagnostics,
} from "../types";

export interface WorkspaceHealthControllerDeps {
  setError: (message: string | null) => void;
  workspaceLoadGenerationRef: MutableRefObject<number>;
  isWorkspaceLoadCurrent: (generation: number) => boolean;
}

export function useWorkspaceHealthController({
  setError,
  workspaceLoadGenerationRef,
  isWorkspaceLoadCurrent,
}: WorkspaceHealthControllerDeps) {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnostics | null>(null);
  const [opencodeRuntimeHealth, setOpencodeRuntimeHealth] = useState<OpenCodeRuntimeHealth | null>(null);
  const [codexRuntimeHealth, setCodexRuntimeHealth] = useState<CodexRuntimeHealth | null>(null);
  const [cursorProfileHealth, setCursorProfileHealth] = useState<CursorProfileHealth | null>(null);
  const [brainSetupSeed, setBrainSetupSeed] = useState<BrainSetupSeedResult | null>(null);

  const fetchStatus = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const data = await invoke<StatusData>("get_status");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setStatus(data);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setStatus(null);
      if (!isInvalidWorkspaceError(e)) setError(`Status error: ${e}`);
    }
  }, [isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadWorkspaceDiagnostics = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const diagnostics = await invoke<WorkspaceDiagnostics>("get_workspace_diagnostics");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setWorkspaceDiagnostics(diagnostics);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setError(`Workspace diagnostics: ${e}`);
    }
  }, [isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadCodexRuntimeHealth = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<CodexRuntimeHealth>("get_codex_runtime_health");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setCodexRuntimeHealth(health);
    } catch {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setCodexRuntimeHealth(null);
    }
  }, [isWorkspaceLoadCurrent, workspaceLoadGenerationRef]);

  const loadOpenCodeRuntimeHealth = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<OpenCodeRuntimeHealth>("get_opencode_runtime_health");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setOpencodeRuntimeHealth(health);
    } catch {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setOpencodeRuntimeHealth(null);
    }
  }, [isWorkspaceLoadCurrent, workspaceLoadGenerationRef]);

  const loadCursorProfileHealth = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<CursorProfileHealth>("get_cursor_profile_health");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setCursorProfileHealth(health);
    } catch (e) {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setCursorProfileHealth(null);
      if (!isInvalidWorkspaceError(e)) setError(`Cursor profile: ${e}`);
    }
  }, [isWorkspaceLoadCurrent, setError, workspaceLoadGenerationRef]);

  const loadBrainSetupSeed = useCallback(async () => {
    try {
      const result = await invoke<BrainSetupSeedResult>("read_brain_setup_seed");
      setBrainSetupSeed(result);
    } catch {
      setBrainSetupSeed(null);
    }
  }, []);

  const resetWorkspaceHealthState = useCallback(() => {
    setStatus(null);
    setWorkspaceDiagnostics(null);
    setOpencodeRuntimeHealth(null);
    setCodexRuntimeHealth(null);
    setCursorProfileHealth(null);
  }, []);

  const brainSetupText = useMemo(() => {
    if (brainSetupSeed?.status === "found" && brainSetupSeed.content.trim()) {
      return brainSetupSeed.content;
    }
    return buildBrainSetupBlock();
  }, [brainSetupSeed]);

  const brainSetupSource = brainSetupSeed?.status === "found" && brainSetupSeed.content.trim()
    ? brainSetupSeed.source
    : "generated fallback";

  return {
    status,
    workspaceDiagnostics,
    opencodeRuntimeHealth,
    codexRuntimeHealth,
    cursorProfileHealth,
    brainSetupSeed,
    brainSetupText,
    brainSetupSource,
    fetchStatus,
    loadWorkspaceDiagnostics,
    loadOpenCodeRuntimeHealth,
    loadCodexRuntimeHealth,
    loadCursorProfileHealth,
    loadBrainSetupSeed,
    resetWorkspaceHealthState,
    isInvalidWorkspaceError,
  };
}
