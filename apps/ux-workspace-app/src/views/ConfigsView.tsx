import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, DocumentContent, StatusData } from "../types";

interface ConfigsViewProps {
  status: StatusData | null;
  activeConfigContent: DocumentContent | null;
  activeConfigTargetId: string;
  activeConfigEnabled: boolean;
  configEnabled: boolean;
  configLog: ActionResult | null;
  configRunning: string | null;
  configTargets: AgentTargetMeta[];
  onSelectConfigTarget: (targetId: string) => void;
  onDiffConfig: () => void;
  onSyncConfig: () => void;
  onOpenConfig: () => void;
  syncTextClass: (value: string) => string;
  targetDotClass: (value: string) => string;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  configDraft: string;
  configDirty: boolean;
  configSaving: boolean;
  configSaveResult: ActionResult | null;
  configMode: "preview" | "edit";
  onSetConfigMode: (mode: "preview" | "edit") => void;
  onChangeConfigDraft: (value: string) => void;
  onSaveConfig: () => void;
  onResetConfig: () => void;
}

function formatJson(content: string): string {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

export function ConfigsView({
  status,
  activeConfigContent,
  activeConfigTargetId,
  activeConfigEnabled,
  configEnabled,
  configLog,
  configRunning,
  configTargets,
  onSelectConfigTarget,
  onDiffConfig,
  onSyncConfig,
  onOpenConfig,
  syncTextClass,
  targetDotClass,
  activityIndex,
  activityCellClass,
  configDraft,
  configDirty,
  configSaving,
  configSaveResult,
  configMode,
  onSetConfigMode,
  onChangeConfigDraft,
  onSaveConfig,
  onResetConfig,
}: ConfigsViewProps) {
  const configStatus = status?.config_statuses?.[activeConfigTargetId] ?? "—";
  const selectedTarget = configTargets.find(t => t.id === activeConfigTargetId);
  const configLabel = selectedTarget?.label ?? "config template";
  const hasActiveTarget = activeConfigTargetId.length > 0;
  const sourcePath = selectedTarget?.source_rel ?? "";
  const targetPath = selectedTarget?.target_rel ?? "";

  return (
    <section className="configs-frame">
      {configTargets.length > 0 && (
        <div className="configs-target-selector">
          {configTargets.map(t => {
            const stat = status?.config_statuses?.[t.id] ?? "—";
            const isActive = t.id === activeConfigTargetId;
            return (
              <button
                key={t.id}
                className={`configs-target-chip${isActive ? " configs-target-chip-active" : ""}`}
                onClick={() => onSelectConfigTarget(t.id)}
              >
                <span className={targetDotClass(stat)} />
                <span className="configs-target-chip-label">{t.label}</span>
                <span className={`configs-target-chip-status ${syncTextClass(stat)}`}>{stat}</span>
                <span className="configs-target-chip-path">{t.source_rel}</span>
              </button>
            );
          })}
        </div>
      )}

      <header className="configs-frame-header">
        <div className="configs-frame-title">
          <span className="terminal-title">CONFIGS</span>
          <span className="cell-value cell-value-muted">{configLabel}</span>
        </div>
        <div className="configs-frame-actions">
          <span className={`configs-frame-status ${syncTextClass(configStatus)}`}>
            <span className={targetDotClass(configStatus)} />{configStatus}
          </span>
          {!activeConfigEnabled && <span className="configs-frame-note">config target disabled</span>}
          <button className="btn btn-sm" disabled={configRunning !== null || !configEnabled} onClick={onDiffConfig}>diff</button>
          <button className="btn btn-sm btn-primary" disabled={configRunning !== null || !configEnabled} onClick={onSyncConfig}>sync</button>
          <button className="btn btn-sm" disabled={!hasActiveTarget} onClick={onOpenConfig}>open</button>
        </div>
      </header>

      <div className="configs-frame-body">
        <main className="configs-template-pane">
          {activeConfigContent ? (
            <>
              <div className="configs-template-meta">
                {sourcePath && (
                  <span className="configs-meta-item">
                    <span className="configs-meta-label">template</span>
                    <span className="configs-meta-value">{sourcePath}</span>
                  </span>
                )}
                {targetPath && (
                  <span className="configs-meta-item">
                    <span className="configs-meta-label">target</span>
                    <span className="configs-meta-value">{targetPath}</span>
                  </span>
                )}
              </div>

              <div className="configs-mode-tabs" role="tablist" aria-label="Config view mode">
                <button
                  className={`btn btn-sm ${configMode === "preview" ? "btn-active" : ""}`}
                  onClick={() => onSetConfigMode("preview")}
                  role="tab"
                  aria-selected={configMode === "preview"}
                >
                  preview
                </button>
                <button
                  className={`btn btn-sm ${configMode === "edit" ? "btn-active" : ""}`}
                  onClick={() => onSetConfigMode("edit")}
                  role="tab"
                  aria-selected={configMode === "edit"}
                >
                  edit
                </button>
                {configDirty && (
                  <span className="configs-dirty-indicator" aria-label="Unsaved changes">modified</span>
                )}
              </div>

              <div className="configs-template-content">
                {configMode === "preview" ? (
                  <pre className="configs-code">{formatJson(activeConfigContent.content)}</pre>
                ) : (
                  <textarea
                    className="configs-textarea"
                    value={configDraft}
                    onChange={e => onChangeConfigDraft(e.target.value)}
                    spellCheck={false}
                    aria-label="Edit config template"
                  />
                )}
              </div>

              {configMode === "edit" && (
                <div className="configs-save-row">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={onSaveConfig}
                    disabled={configSaving || !configDirty}
                  >
                    {configSaving ? "saving..." : "save"}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={onResetConfig}
                    disabled={configSaving || !configDirty}
                  >
                    reset
                  </button>
                  {configSaveResult && (
                    <span className={`configs-save-status ${configSaveResult.success ? "configs-save-ok" : "configs-save-fail"}`}>
                      {configSaveResult.success
                        ? configSaveResult.stdout
                        : configSaveResult.stderr || "save failed"}
                    </span>
                  )}
                  <span className="configs-save-note">template only</span>
                </div>
              )}
            </>
          ) : (
            <div className="log-empty"><span className="log-prompt">$</span> no config loaded</div>
          )}
        </main>
        <aside className="configs-console-pane">
          {configRunning ? (
            <TerminalState
              runningLabel={configRunning}
              result={configLog}
              readyLabel="config ready"
              activityIndex={activityIndex}
              activityCellClass={activityCellClass}
            />
          ) : !configEnabled ? (
            <div className="log-empty"><span className="log-prompt">$</span> no enabled config targets</div>
          ) : (
            <TerminalState
              result={configLog}
              readyLabel="config ready"
              activityIndex={activityIndex}
              activityCellClass={activityCellClass}
            />
          )}
        </aside>
      </div>
    </section>
  );
}
