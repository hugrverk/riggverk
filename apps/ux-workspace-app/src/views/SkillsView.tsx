import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import type { SkillSummary } from "../types";

type InstallAgent = "opencode" | "codex" | "auggie";
type InstallScope = "global" | "project";

interface SkillsViewProps {
  skills: SkillSummary[];
  workspaceValid: boolean;
  selectedSkills: Set<string>;
  installAgents: Set<string>;
  installScope: InstallScope;
  installTarget: string;
  installResult: ActionResult | null;
  installRunning: boolean;
  canInstall: boolean;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  onToggleSkill: (name: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onToggleInstallAgent: (agent: InstallAgent) => void;
  onSetInstallScope: (scope: InstallScope) => void;
  onSetInstallTarget: (value: string) => void;
  onDryRun: () => void;
  onInstallSelected: () => void;
  onOpenSkill: (id: string) => void;
  onOpenInstallScript: () => void;
}

function areaFromId(id: string): string {
  return id.split("/")[0] ?? "";
}

export function SkillsView({
  skills,
  workspaceValid,
  selectedSkills,
  installAgents,
  installScope,
  installTarget,
  installResult,
  installRunning,
  canInstall,
  activityIndex,
  activityCellClass,
  onToggleSkill,
  onSelectAll,
  onClearSelection,
  onToggleInstallAgent,
  onSetInstallScope,
  onSetInstallTarget,
  onDryRun,
  onInstallSelected,
  onOpenSkill,
  onOpenInstallScript,
}: SkillsViewProps) {
  const invalidWorkspace = !workspaceValid && skills.length === 0;

  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">SKILLS</span>
        <span className="terminal-host">{selectedSkills.size}/{skills.length} selected</span>
      </div>
      <div className="skills-layout">
        <div className="skills-main">
          <div className="install-controls">
            <div className="install-control-group">
              <span className="cell-label">AGENT</span>
              {(["opencode", "codex", "auggie"] as const).map(a => (
                <button
                  key={a}
                  className={`btn btn-sm ${installAgents.has(a) ? "btn-active" : ""}`}
                  onClick={() => onToggleInstallAgent(a)}
                >{a}</button>
              ))}
            </div>
            <div className="install-control-group">
              <span className="cell-label">SCOPE</span>
              {(["global", "project"] as const).map(s => (
                <button key={s} className={`btn btn-sm ${installScope === s ? "btn-active" : ""}`} onClick={() => onSetInstallScope(s)}>{s}</button>
              ))}
              {installScope === "project" && (
                <input
                  className="install-target-input"
                  type="text"
                  placeholder="/path/to/project"
                  value={installTarget}
                  onChange={e => onSetInstallTarget(e.target.value)}
                />
              )}
            </div>
            <div className="install-control-group install-control-push">
              <button className="btn btn-sm" onClick={onSelectAll}>all</button>
              <button className="btn btn-sm" onClick={onClearSelection}>clear</button>
            </div>
          </div>
          <div className="table-wrap">
            {invalidWorkspace ? (
              <div className="workspace-empty-state">No valid workspace selected. Create or choose a workspace in Settings.</div>
            ) : skills.length === 0 ? (
              <div className="workspace-empty-state">No workspace skills found</div>
            ) : (
              skills.map((s) => (
                <div key={s.id} className={`table-row table-row-install ${selectedSkills.has(s.name) ? "table-row-selected" : ""}`} onClick={() => onToggleSkill(s.name)}>
                  <div className="table-cell table-cell-check">
                    <span className={`install-checkbox ${selectedSkills.has(s.name) ? "install-checkbox-on" : ""}`}>
                      {selectedSkills.has(s.name) ? "x" : ""}
                    </span>
                  </div>
                  <div className="table-cell table-cell-name"><span className="cell-label">{s.name}</span></div>
                  <div className="table-cell table-cell-area"><span className="cell-value cell-value-muted">{areaFromId(s.id)}</span></div>
                  <div className="table-cell table-cell-desc"><span className="cell-value cell-value-muted">{s.description}</span></div>
                  <div className="table-cell table-cell-action">
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onOpenSkill(s.id); }}>open</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <aside className="install-panel">
          <div className="install-actions">
            <button className="btn" disabled={!workspaceValid || !canInstall} onClick={onDryRun}>dry run</button>
            <button className="btn btn-primary" disabled={!workspaceValid || !canInstall} onClick={onInstallSelected}>install selected</button>
            <button className="btn btn-sm" onClick={onOpenInstallScript}>open script</button>
          </div>
          {!workspaceValid && (
            <div className="install-disabled-note">No valid workspace selected. Create or choose a workspace in Settings.</div>
          )}
          <div className="install-output">
            <TerminalState
              runningLabel={installRunning ? "installing" : null}
              result={installResult}
              readyLabel="ready"
              activityIndex={activityIndex}
              activityCellClass={activityCellClass}
              sectioned={false}
              showNoOutput={false}
            />
          </div>
        </aside>
      </div>
    </section>
  );
}
