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
  onDiffConfig: () => void;
  onSyncConfig: () => void;
  onOpenConfig: () => void;
  syncTextClass: (value: string) => string;
  targetDotClass: (value: string) => string;
  activityIndex: number;
  activityCellClass: (index: number) => string;
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
  onDiffConfig,
  onSyncConfig,
  onOpenConfig,
  syncTextClass,
  targetDotClass,
  activityIndex,
  activityCellClass,
}: ConfigsViewProps) {
  const configStatus = status?.config_statuses?.[activeConfigTargetId] ?? "—";
  const selectedTarget = configTargets.find(t => t.id === activeConfigTargetId);
  const configLabel = selectedTarget?.label ?? "config template";
  const configCount = configTargets.length;

  return (
    <section className="configs-frame">
      <header className="configs-frame-header">
        <div className="configs-frame-title">
          <span className="terminal-title">CONFIGS</span>
          <span className="cell-value cell-value-muted">{configLabel}{configCount === 1 ? " (only supported config target)" : ""}</span>
        </div>
        <div className="configs-frame-actions">
          <span className={`configs-frame-status ${syncTextClass(configStatus)}`}>
            <span className={targetDotClass(configStatus)} />{configStatus}
          </span>
          {!activeConfigEnabled && <span className="configs-frame-note">config target disabled</span>}
          <button className="btn btn-sm" disabled={configRunning !== null || !configEnabled} onClick={onDiffConfig}>diff</button>
          <button className="btn btn-sm btn-primary" disabled={configRunning !== null || !configEnabled} onClick={onSyncConfig}>sync</button>
          <button className="btn btn-sm" onClick={onOpenConfig}>open</button>
        </div>
      </header>
      <div className="configs-frame-body">
        <main className="configs-template-pane">
          {activeConfigContent ? (
            <pre className="configs-code">{formatJson(activeConfigContent.content)}</pre>
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
