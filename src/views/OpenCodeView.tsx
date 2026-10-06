import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TargetPageHeader, type TargetPageFact } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import { runtimeStatusFact } from "../lib/runtimeUi";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type {
  AgentTargetMeta,
  AppSettings,
  ListAvailableModelsResult,
  OpenCodeModelSelection,
  OpenCodeRuntimeHealth,
  StatusData,
} from "../types";

interface ModelSelectionPanelProps {
  workspaceValid: boolean;
  onModelUpdated: () => void;
  onCardRefreshNeeded?: () => void;
}

function ModelSelectionPanel({ workspaceValid, onModelUpdated, onCardRefreshNeeded }: ModelSelectionPanelProps) {
  const [available, setAvailable] = useState<ListAvailableModelsResult | null>(null);
  const [selection, setSelection] = useState<OpenCodeModelSelection | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftSmall, setDraftSmall] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const selectionGenRef = useRef(0);
  const modelsGenRef = useRef(0);
  const modelSelectId = useId();
  const smallModelSelectId = useId();

  const loadSelection = useCallback(async () => {
    if (!workspaceValid) return;
    const gen = ++selectionGenRef.current;
    try {
      const sel = await invoke<OpenCodeModelSelection>("read_opencode_model_selection");
      if (gen !== selectionGenRef.current) return;
      setSelection(sel);
      setDraftModel(sel.model);
      setDraftSmall(sel.small_model);
    } catch {
      if (gen !== selectionGenRef.current) return;
      setSelection(null);
    }
  }, [workspaceValid]);

  const loadModels = useCallback(async () => {
    if (!workspaceValid) return;
    const gen = ++modelsGenRef.current;
    setLoadingModels(true);
    setModelWarning(null);
    try {
      const result = await invoke<ListAvailableModelsResult>("list_available_opencode_models");
      if (gen !== modelsGenRef.current) return;
      setAvailable(result);
      if (result.warning) setModelWarning(result.warning);
    } catch (err) {
      if (gen !== modelsGenRef.current) return;
      setAvailable(null);
      setModelWarning(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === modelsGenRef.current) setLoadingModels(false);
    }
  }, [workspaceValid]);

  // Load on mount and when workspace becomes valid
  useEffect(() => {
    if (workspaceValid) {
      loadSelection();
      loadModels();
    } else {
      setAvailable(null);
      setSelection(null);
    }
  }, [workspaceValid, loadSelection, loadModels]);

  const hasChanges = selection !== null && (draftModel !== selection.model || draftSmall !== selection.small_model);
  const modelError = draftModel && !draftModel.includes("/") ? "Must be provider/model format" : null;
  const smallError = draftSmall && !draftSmall.includes("/") ? "Must be provider/model format" : null;
  const canSave = workspaceValid && hasChanges && !modelError && !smallError && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const msg = await invoke<string>("update_opencode_model_selection", {
        model: draftModel,
        smallModel: draftSmall,
      });
      setSaveMessage(msg);
      // Refresh selection state
      await loadSelection();
      // Notify parent to refresh runtime health so Managed card shows pending
      onModelUpdated();
      // Trigger managed installation card refresh
      onCardRefreshNeeded?.();
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canSave, draftModel, draftSmall, loadSelection, onModelUpdated, onCardRefreshNeeded]);

  // Sync draft when selection reloads after save
  useEffect(() => {
    if (selection && !hasChanges) {
      setDraftModel(selection.model);
      setDraftSmall(selection.small_model);
    }
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-clear save message after 5 seconds
  useEffect(() => {
    if (!saveMessage) return;
    const timer = setTimeout(() => setSaveMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [saveMessage]);

  // Build stable, deduped, sorted union of discovered models + current configured + draft values.
  // This ensures the current selection always appears as a selectable option even when
  // the model list from `opencode models` does not include it.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of available?.models ?? []) {
      set.add(m);
    }
    if (selection?.model) set.add(selection.model);
    if (selection?.small_model) set.add(selection.small_model);
    if (draftModel && draftModel.includes("/")) set.add(draftModel);
    if (draftSmall && draftSmall.includes("/")) set.add(draftSmall);
    return [...set].sort();
  }, [available, selection, draftModel, draftSmall]);

  if (!workspaceValid) return null;

  const showModelList = modelOptions.length > 0;

  return (
    <div className="harness-action-card" role="region" aria-label="Model selection">
      <div className="ws-section-header">
        <h3 className="ws-section-title">Model selection</h3>
        <button
          className="btn btn-sm"
          onClick={loadModels}
          disabled={loadingModels || saving}
          aria-label="Refresh available models"
          type="button"
        >
          {loadingModels ? "loading…" : "refresh"}
        </button>
      </div>
      <p className="harness-action-card-desc">
        Choose the OpenCode model override. It is stored in app settings and applied on the next OpenCode Install/Update; workspace templates are not edited.
      </p>

      <div className="ws-runtime-rows">
        <div className="ws-setting-row">
          <label htmlFor={modelSelectId}>Model</label>
          {showModelList ? (
            <select
              id={modelSelectId}
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              disabled={saving}
              aria-invalid={!!modelError}
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              id={modelSelectId}
              className="settings-input"
              type="text"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              disabled={saving}
              placeholder="provider/model"
              aria-invalid={!!modelError}
              style={{ width: "auto" }}
            />
          )}
        </div>
        {modelError && <p className="ws-setting-error" role="alert">{modelError}</p>}

        <div className="ws-setting-row">
          <label htmlFor={smallModelSelectId}>Small model</label>
          {showModelList ? (
            <select
              id={smallModelSelectId}
              value={draftSmall}
              onChange={(e) => setDraftSmall(e.target.value)}
              disabled={saving}
              aria-invalid={!!smallError}
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              id={smallModelSelectId}
              className="settings-input"
              type="text"
              value={draftSmall}
              onChange={(e) => setDraftSmall(e.target.value)}
              disabled={saving}
              placeholder="provider/model"
              aria-invalid={!!smallError}
              style={{ width: "auto" }}
            />
          )}
        </div>
        {smallError && <p className="ws-setting-error" role="alert">{smallError}</p>}
      </div>

      {modelWarning && <p className="harness-action-warning ws-color-warn">{modelWarning}</p>}
      {saveMessage && (
        <p
          className="harness-action-next"
          style={{ color: saveMessage.includes("saved") || saveMessage.includes("Saved") ? "var(--accent)" : "var(--warn)" }}
        >
          {saveMessage}
        </p>
      )}

      <div className="ws-section-actions">
        <button
          className="btn btn-sm btn-primary"
          onClick={handleSave}
          disabled={!canSave}
          type="button"
        >
          {saving ? "saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

interface OpenCodeViewProps {
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  settingsSaveStatus: SettingsSaveStatus;
  onToggleTarget: (id: string) => void;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  onHarnessSetupUpdate: (surfaces: string[], label: string) => void;
  runtimeHealth: OpenCodeRuntimeHealth | null;
  onModelUpdated: () => void;
}

export function OpenCodeView({
  appSettings,
  agentTargets,
  settingsSaveStatus,
  onToggleTarget,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onHarnessSetupUpdate,
  runtimeHealth,
  onModelUpdated,
}: OpenCodeViewProps) {
  const [cardRefresh, setCardRefresh] = useState(0);
  const triggerCardRefresh = useCallback(() => setCardRefresh((n) => n + 1), []);
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const facts: TargetPageFact[] = [{ label: statusText, tone: workspaceValid ? "ok" : "warn" }];
  if (workspaceValid && runtimeHealth) facts.push(runtimeStatusFact(runtimeHealth.status));

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="OpenCode controls">
          <TargetPageHeader
            icon="opencode"
            title="OpenCode"
            summary="Install or update OpenCode rules, config, agents, and skills through one managed workflow."
            facts={facts}
            warning={!workspaceValid ? "Select a valid workspace on Start before running OpenCode actions." : undefined}
          />

          <TargetSettingsPanel
            page="opencode"
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
          />

          <ModelSelectionPanel
            workspaceValid={workspaceValid}
            onModelUpdated={onModelUpdated}
            onCardRefreshNeeded={triggerCardRefresh}
          />

          <HarnessInstallationCard
            harness="opencode"
            title="Managed installation"
            description="One update reconciles OpenCode config, agents, rules, and skills with the workspace bundle."
            workspaceValid={workspaceValid}
            busy={busy}
            onUpdate={onHarnessSetupUpdate}
            refreshKey={cardRefresh}
          />

        </div>

        <WorkspaceTerminal
          wsRunning={wsRunning}
          wsLog={wsLog}
          wsLogCompletedAt={wsLogCompletedAt}
          status={status}
          workspaceValid={workspaceValid}
          gitAvailable={gitAvailable}
          canRunReleaseCheck={canRunReleaseCheck}
          statusText={statusText}
        />
      </div>
    </section>
  );
}
