import { TerminalState, type ActionResult } from "../components/TerminalOutput";
import { Markdown } from "../components/Markdown";
import { INSTALL_AGENTS, type InstallAgent, type SkillSummary, type DocumentContent } from "../types";

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
  activeSkillId: string | null;
  activeSkillContent: DocumentContent | null;
  skillFilter: string | null;
  skillSearch: string;
  onSetSkillFilter: (area: string | null) => void;
  onSetSkillSearch: (value: string) => void;
  onSelectSkillPreview: (id: string) => void;
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
  const area = id.split("/")[0] ?? "";
  return area || "workspace";
}

function uniqueAreas(skills: SkillSummary[]): string[] {
  const seen = new Set<string>();
  const areas: string[] = [];
  for (const s of skills) {
    const a = areaFromId(s.id);
    if (!seen.has(a)) {
      seen.add(a);
      areas.push(a);
    }
  }
  return areas;
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
  activeSkillId,
  activeSkillContent,
  skillFilter,
  skillSearch,
  onSetSkillFilter,
  onSetSkillSearch,
  onSelectSkillPreview,
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
  const areas = uniqueAreas(skills);

  const filteredSkills = (() => {
    let result = skillFilter
      ? skills.filter((s) => areaFromId(s.id) === skillFilter)
      : skills;

    if (skillSearch.trim()) {
      const q = skillSearch.toLowerCase().trim();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        areaFromId(s.id).toLowerCase().includes(q)
      );
    }

    return result;
  })();

  const orderedAgents = INSTALL_AGENTS.filter(a => installAgents.has(a));
  const hasFilter = skillFilter !== null || skillSearch.trim() !== "";

  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">SKILLS</span>
        <span className="terminal-host">
          {activeSkillId
            ? `preview: ${skills.find((s) => s.id === activeSkillId)?.name ?? activeSkillId}`
            : hasFilter
              ? `${filteredSkills.length} of ${skills.length} skills`
              : `${selectedSkills.size}/${skills.length} selected`}
        </span>
      </div>

      <div className="skills-command-strip">
        <div className="skills-cmd-group">
          <span className="cell-label">INSTALL TARGETS</span>
          {INSTALL_AGENTS.map(a => (
            <button
              key={a}
              className={`btn btn-sm ${installAgents.has(a) ? "btn-active" : ""}`}
              onClick={() => onToggleInstallAgent(a)}
            >{a}</button>
          ))}
        </div>
        <div className="skills-cmd-group">
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
        <div className="skills-cmd-push">
          <input
            className="skills-search"
            type="text"
            placeholder="search..."
            value={skillSearch}
            onChange={e => onSetSkillSearch(e.target.value)}
          />
          {skillSearch && (
            <button className="btn btn-sm" onClick={() => onSetSkillSearch("")}>x</button>
          )}
          <button className="btn btn-sm" onClick={onSelectAll}>all</button>
          <button className="btn btn-sm" onClick={onClearSelection}>clear</button>
        </div>
      </div>

      {areas.length > 1 && (
        <div className="skills-filter-row">
          <button
            className={`skills-filter-chip ${!skillFilter ? "skills-filter-chip-active" : ""}`}
            onClick={() => onSetSkillFilter(null)}
          >all</button>
          {areas.map(a => (
            <button
              key={a}
              className={`skills-filter-chip ${skillFilter === a ? "skills-filter-chip-active" : ""}`}
              onClick={() => onSetSkillFilter(a)}
            >{a}</button>
          ))}
        </div>
      )}

      <div className="skills-layout">
        <div className="skills-browser">
          <div className="skills-note">
            Rule sync supports all agents (Codex, OpenCode, Claude, Gemini, Auggie). Skill install targets depend on each tool&apos;s supported skill directory.
          </div>
          <div className="skills-browser-list">
            {invalidWorkspace ? (
              <div className="workspace-empty-state">No valid workspace selected. Create or choose a workspace in Workspace.</div>
            ) : filteredSkills.length === 0 ? (
              <div className="workspace-empty-state">
                {hasFilter ? "No skills match the current filters" : "No skills found"}
              </div>
            ) : (
              filteredSkills.map((s) => (
                <div
                  key={s.id}
                  className={`skills-row ${activeSkillId === s.id ? "skills-row-active" : ""} ${selectedSkills.has(s.name) ? "skills-row-selected" : ""}`}
                >
                  <button
                    className={`skills-row-check-button ${selectedSkills.has(s.name) ? "skills-row-check-button-on" : ""}`}
                    onClick={(e) => { e.stopPropagation(); onToggleSkill(s.name); }}
                    aria-pressed={selectedSkills.has(s.name)}
                  >
                    {selectedSkills.has(s.name) ? "x" : ""}
                  </button>
                  <button className="skills-row-preview-button" onClick={() => onSelectSkillPreview(s.id)}>
                    <span className="skills-row-name">{s.name}</span>
                    <span className="skills-row-area">{areaFromId(s.id)}</span>
                    <span className="skills-row-desc">{s.description}</span>
                  </button>
                  <span className="skills-row-action">
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onOpenSkill(s.id); }}>open</button>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="skills-right-pane">
          <div className="skills-preview">
            {activeSkillContent ? (
              <>
                <div className="skills-preview-header">
                  <div className="skills-preview-header-left">
                    <span className="skills-preview-name">{activeSkillContent.title}</span>
                    <span className="skills-preview-meta">{activeSkillContent.section} &middot; {activeSkillContent.path}</span>
                  </div>
                  <button className="btn btn-sm" onClick={() => onOpenSkill(activeSkillContent.id)}>open</button>
                </div>
                <div className="skills-preview-body"><Markdown content={activeSkillContent.content} /></div>
              </>
            ) : (
              <div className="workspace-empty-state">Select a skill to preview</div>
            )}
          </div>

          <div className="skills-install-plan">
            <div className="skills-install-summary">
              <div className="skills-plan-row">
                <span className="skills-plan-key">skills</span>
                <span className="skills-plan-value">{selectedSkills.size}/{skills.length} selected</span>
              </div>
              <div className="skills-plan-row">
                <span className="skills-plan-key">agents</span>
                <span className="skills-plan-value">
                  {orderedAgents.length > 0
                    ? `${orderedAgents.length}: ${orderedAgents.join(", ")}`
                    : "none"}
                </span>
              </div>
              <div className="skills-plan-row">
                <span className="skills-plan-key">scope</span>
                <span className="skills-plan-value">{installScope}{installScope === "project" && installTarget ? " \u00b7 " + installTarget : ""}</span>
              </div>
            </div>
            <div className="skills-install-actions">
              <button className="btn" disabled={!workspaceValid || !canInstall} onClick={onDryRun}>dry run</button>
              <button className="btn btn-primary" disabled={!workspaceValid || !canInstall} onClick={onInstallSelected}>install selected</button>
              <button className="btn btn-sm" onClick={onOpenInstallScript}>open script</button>
            </div>
            {workspaceValid && !canInstall && !installRunning && (
              <div className="skills-plan-warning">
                {selectedSkills.size === 0
                  ? "No skills selected for install."
                  : installAgents.size === 0
                    ? "No agents selected for install."
                    : installScope === "project" && !installTarget.trim()
                      ? "Project scope requires a target path."
                      : null}
              </div>
            )}
            {!workspaceValid && (
              <div className="install-disabled-note">No valid workspace selected. Create or choose a workspace in Workspace.</div>
            )}
            <div className="skills-install-output">
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
          </div>
        </div>
      </div>
    </section>
  );
}
