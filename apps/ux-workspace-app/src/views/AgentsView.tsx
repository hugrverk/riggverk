import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, StatusData } from "../types";

interface AgentsViewProps {
  status: StatusData | null;
  log: ActionResult | null;
  running: string | null;
  rsc: { synced: number; total: number };
  agentTargets: AgentTargetMeta[];
  enabledSet: Set<string>;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  syncTextClass: (value: string) => string;
  targetDotClass: (value: string) => string;
  onRunAction: (action: string) => void;
  onOpenGlobalRules: () => void;
}

function statusValue(status: StatusData, id: string): string {
  switch (id) {
    case "codex_rules": return status.rules_codex;
    case "opencode_rules": return status.rules_opencode;
    case "auggie_rules": return status.rules_auggie;
    case "claude_rules": return status.rules_claude;
    case "gemini_rules": return status.rules_gemini;
    case "opencode_config": return status.opencode_config;
    default: return "unknown";
  }
}

export function AgentsView({
  status,
  log,
  running,
  rsc,
  agentTargets,
  enabledSet,
  activityIndex,
  activityCellClass,
  syncTextClass,
  targetDotClass,
  onRunAction,
  onOpenGlobalRules,
}: AgentsViewProps) {
  const ruleTargets = agentTargets.filter(t => t.kind === "rules");

  return (
    <div className="console-layout">
      <main className="console-main">
        <section className="panel log-panel">
          <div className="terminal-grid" aria-hidden="true" />
          <TerminalState
            runningLabel={running}
            result={log}
            readyLabel="ready"
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
          />
        </section>
      </main>

      <aside className="console-side">
        <section className="console-section">
          <div className="console-section-label">status</div>
          <div className="console-status-list">
            <div className="console-status-row">
              <span className="cell-label">REPO</span>
              <span className="console-status-value">{status?.repo_path ?? "—"}</span>
            </div>
            <div className="console-status-row">
              <span className="cell-label">COMMIT</span>
              <span className="console-status-value">{status?.latest_commit ?? "—"}</span>
            </div>
            <div className="console-status-row">
              <span className="cell-label">BRANCH</span>
              <span className="console-status-value">{status?.branch ?? "—"}</span>
            </div>
            <div className="console-status-row">
              <span className="cell-label">STATE</span>
              <span className={status?.dirty ? "pill pill-dirty" : "pill pill-clean"}>{status?.dirty ? "dirty" : "clean"}</span>
            </div>
            <div className="console-status-row">
              <span className="cell-label">SYNC</span>
              <span className={`console-status-value ${rsc.synced === rsc.total && rsc.total > 0 ? "status-ok" : ""}`}>{rsc.synced}/{rsc.total}</span>
            </div>
          </div>
        </section>

        <section className="console-section">
          <div className="console-section-label">actions</div>
          <div className="console-actions">
            <div className="console-action-group">
              <span className="command-group-label">repo</span>
              <div className="console-button-row">
                <button className="btn" disabled={running !== null} onClick={() => onRunAction("git_pull")}>pull</button>
                <button className="btn" disabled={running !== null} onClick={() => onRunAction("verify_state")}>verify</button>
              </div>
            </div>
            <div className="console-action-group">
              <span className="command-group-label">rules</span>
              <div className="console-button-row">
                <button className="btn" disabled={running !== null} onClick={() => onRunAction("diff_agent_rules")}>diff</button>
                <button className="btn" disabled={running !== null} onClick={() => onRunAction("sync_agent_rules")}>sync</button>
              </div>
              <span className="console-note">verify and diff check rule targets only</span>
            </div>
          </div>
        </section>

        <section className="console-section console-section-targets">
          <div className="console-section-label">rules enabled {rsc.total}/{ruleTargets.length}</div>
          <div className="targets-body">
            {ruleTargets.map(t => {
              const enabled = enabledSet.has(t.id);
              const st = status ? statusValue(status, t.id) : "—";
              const stCls = status ? syncTextClass(statusValue(status, t.id)) : "sync-text";
              const dotCls = status ? targetDotClass(statusValue(status, t.id)) : "target-dot";
              return (
                <div key={t.id} className={`targets-row ${enabled ? "" : "targets-row-disabled"}`}>
                  <div className="target-mainline">
                    <span className="target-cell">{t.label}</span>
                    <span className={`target-cell ${stCls}${enabled ? "" : " sync-text-disabled"}`}><span className={dotCls} />{st}</span>
                  </div>
                  <span className="target-cell target-cell-muted target-cell-path">{t.target_rel}</span>
                </div>
              );
            })}
          </div>
          <div className="agent-template-link">
            <button className="btn btn-sm" onClick={onOpenGlobalRules}>global rules</button>
          </div>
        </section>
      </aside>
    </div>
  );
}
