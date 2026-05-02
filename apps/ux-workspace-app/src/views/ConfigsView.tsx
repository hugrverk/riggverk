import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, DocumentContent, StatusData } from "../types";

interface ConfigsViewProps {
  status: StatusData | null;
  opencodeConfig: DocumentContent | null;
  opencodeConfigEnabled: boolean;
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
  opencodeConfig,
  opencodeConfigEnabled,
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
  const configStatus = status?.opencode_config ?? "—";
  const configLabel = configTargets[0]?.label ?? "opencode config";
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
          {!opencodeConfigEnabled && <span className="configs-frame-note">config target disabled</span>}
          <button className="btn btn-sm" disabled={configRunning !== null || !opencodeConfigEnabled} onClick={onDiffConfig}>diff</button>
          <button className="btn btn-sm btn-primary" disabled={configRunning !== null || !opencodeConfigEnabled} onClick={onSyncConfig}>sync</button>
          <button className="btn btn-sm" onClick={onOpenConfig}>open</button>
        </div>
      </header>
      <div className="configs-frame-body">
        <main className="configs-template-pane">
          {opencodeConfig ? (
            <pre className="configs-code">{formatJson(opencodeConfig.content)}</pre>
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
          ) : !opencodeConfigEnabled ? (
            <div className="log-empty"><span className="log-prompt">$</span> config target disabled</div>
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
