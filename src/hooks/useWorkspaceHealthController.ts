import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState, type MutableRefObject } from "react";
import { isLightAgent } from "../lib/harnessInstallation";
import { isInvalidWorkspaceError } from "../lib/workspaceErrors";
import type {
  ClaudeRuntimeHealth,
  CodexRuntimeHealth,
  CursorProfileHealth,
  LightAgent,
  LightRuntimeHealth,
  OpenCodeRuntimeHealth,
  StatusData,
  WorkspaceDiagnostics,
  InstallAgent,
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
  const [claudeRuntimeHealth, setClaudeRuntimeHealth] = useState<ClaudeRuntimeHealth | null>(null);
  // Copilot, Pi and Kilo share one command and one page; a harness that is off has no entry.
  const [lightRuntimeHealth, setLightRuntimeHealth] = useState<Partial<Record<LightAgent, LightRuntimeHealth | null>>>({});

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

  const loadClaudeRuntimeHealth = useCallback(async (generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<ClaudeRuntimeHealth>("get_claude_runtime_health");
      if (!isWorkspaceLoadCurrent(generation)) return;
      setClaudeRuntimeHealth(health);
    } catch {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setClaudeRuntimeHealth(null);
    }
  }, [isWorkspaceLoadCurrent, workspaceLoadGenerationRef]);

  const loadLightRuntimeHealth = useCallback(async (harness: LightAgent, generation = workspaceLoadGenerationRef.current) => {
    try {
      const health = await invoke<LightRuntimeHealth>("get_light_runtime_health", { harness });
      if (!isWorkspaceLoadCurrent(generation)) return;
      setLightRuntimeHealth(previous => ({ ...previous, [harness]: health }));
    } catch {
      if (!isWorkspaceLoadCurrent(generation)) return;
      setLightRuntimeHealth(previous => ({ ...previous, [harness]: null }));
    }
  }, [isWorkspaceLoadCurrent, workspaceLoadGenerationRef]);

  const resetWorkspaceHealthState = useCallback(() => {
    setStatus(null);
    setWorkspaceDiagnostics(null);
    setOpencodeRuntimeHealth(null);
    setCodexRuntimeHealth(null);
    setCursorProfileHealth(null);
    setClaudeRuntimeHealth(null);
    setLightRuntimeHealth({});
  }, []);

  const clearHarnessHealth = useCallback((harness: InstallAgent) => {
    if (isLightAgent(harness)) {
      setLightRuntimeHealth(previous => ({ ...previous, [harness]: null }));
      return;
    }
    switch (harness) {
      case "codex": setCodexRuntimeHealth(null); break;
      case "opencode": setOpencodeRuntimeHealth(null); break;
      case "claude": setClaudeRuntimeHealth(null); break;
      case "cursor": setCursorProfileHealth(null); break;
    }
  }, []);

  return {
    status,
    workspaceDiagnostics,
    opencodeRuntimeHealth,
    codexRuntimeHealth,
    cursorProfileHealth,
    claudeRuntimeHealth,
    lightRuntimeHealth,
    fetchStatus,
    loadWorkspaceDiagnostics,
    loadOpenCodeRuntimeHealth,
    loadCodexRuntimeHealth,
    loadCursorProfileHealth,
    loadClaudeRuntimeHealth,
    loadLightRuntimeHealth,
    resetWorkspaceHealthState,
    clearHarnessHealth,
    isInvalidWorkspaceError,
  };
}
