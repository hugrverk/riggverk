import { useState, useMemo } from "react";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { TargetPage } from "../lib/targetGroups";
import { SectionChip } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, InstallAgent, SkillSummary, StatusData, TargetProfileMeta } from "../types";
import { INSTALL_AGENTS } from "../types";

interface WorkspaceViewProps {
  pageLabel?: string;
  targetPage?: TargetPage;
  appSettings?: AppSettings | null;
  agentTargets?: AgentTargetMeta[];
  targetProfiles?: TargetProfileMeta[];
  activeProfileId?: string | null;
  settingsDirty?: boolean;
  onToggleTarget?: (id: string) => void;
  onApplyProfile?: (profileId: string) => void;
  // operations
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  ruleTargetsEnabled: boolean;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onReleaseCheck: () => void;
  // skills compact
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  installAgents: string[];
  skillsCanInstall: boolean;
  onDryRunSkills: () => void;
  onInstallSkills: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onToggleInstallAgent: (agent: InstallAgent) => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
  // backups
  backupCount: number;
  onRefreshBackups: () => void;
  onOpenBackupsFolder: () => void;
}

export function WorkspaceView({
  pageLabel,
  targetPage,
  appSettings,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsDirty,
  onToggleTarget,
  onApplyProfile,
  // operations
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  ruleTargetsEnabled,
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  onReleaseCheck,
  // skills
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  installAgents,
  skillsCanInstall,
  onDryRunSkills,
  onInstallSkills,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onToggleInstallAgent,
  onSetSkillSearch,
  onOpenInstallScript,
  // backups
  backupCount,
  onRefreshBackups,
  onOpenBackupsFolder,
}: WorkspaceViewProps) {
  const [showSkillSelector, setShowSkillSelector] = useState(false);

  const skillsCount = skills.length;
  const selectedSkillsCount = selectedSkills.size;

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return skills;
    const q = skillSearch.toLowerCase().trim();
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  }, [skills, skillSearch]);

  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label={pageLabel ? `${pageLabel} controls` : "Workspace controls"}>
          {pageLabel && (
            <div className="ws-page-label">{pageLabel}</div>
          )}

          {targetPage && agentTargets && targetProfiles && onToggleTarget && onApplyProfile && (
            <TargetSettingsPanel
              page={targetPage}
              appSettings={appSettings ?? null}
              agentTargets={agentTargets}
              targetProfiles={targetProfiles}
              activeProfileId={activeProfileId ?? null}
              settingsDirty={settingsDirty ?? false}
              onToggleTarget={onToggleTarget}
              onApplyProfile={onApplyProfile}
            />
          )}

          {/* ---- Rules section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Rules sync">
              <div className="ws-section-header">
                <span className="ws-section-title">RULES</span>
              </div>
              <div className="ws-section-actions">
                <button className="btn btn-sm" disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null} onClick={onDiffRules}>diff</button>
                <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null} onClick={onSyncRules}>sync</button>
              </div>
            </div>
          )}

          {/* ---- Skills section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Skills install">
              <div className="ws-section-header">
                <span className="ws-section-title">SKILLS</span>
                {skillsCount > 0 && (() => {
                  const tone: "ok" | "warn" | "fail" | "muted" = selectedSkillsCount === skillsCount ? "ok" : selectedSkillsCount > 0 ? "warn" : "muted";
                  return <SectionChip label={`${selectedSkillsCount}/${skillsCount} selected`} tone={tone} />;
                })()}
              </div>
              <div className="ws-section-actions">
                <button className="btn btn-sm" disabled={!workspaceValid || !skillsCanInstall || wsRunning !== null} onClick={onDryRunSkills}>dry run</button>
                <button className="btn btn-sm btn-primary" disabled={!workspaceValid || !skillsCanInstall || wsRunning !== null} onClick={onInstallSkills}>install</button>
                {skillsLoaded && skillsCount > 0 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => setShowSkillSelector(prev => !prev)}
                    aria-expanded={showSkillSelector}
                  >
                    {showSkillSelector ? "hide selector" : "select skills"}
                  </button>
                )}
                <button className="btn btn-sm" onClick={onOpenInstallScript}>open script</button>
              </div>
              <div className="ws-card-targets">
                <span className="ws-card-targets-label">agents (global)</span>
                <div className="ws-card-target-buttons">
                  {INSTALL_AGENTS.map(a => (
                    <button
                      key={a}
                      className={`btn btn-sm ${installAgents.includes(a) ? "btn-active" : ""}`}
                      onClick={() => onToggleInstallAgent(a)}
                      aria-pressed={installAgents.includes(a)}
                    >{a}</button>
                  ))}
                </div>
              </div>
              {workspaceValid && !skillsLoaded && !wsRunning && (
                <div className="ws-card-warn">Loading skills...</div>
              )}
              {workspaceValid && skillsLoaded && !skillsCanInstall && !wsRunning && (
                <div className="ws-card-warn">
                  {skills.length === 0
                    ? "No skills found in workspace."
                    : selectedSkillsCount === 0
                      ? "No skills selected."
                      : installAgents.length === 0
                        ? "No agents selected."
                        : null}
                </div>
              )}

              {/* Expandable skills selector */}
              {showSkillSelector && (
                <div className="ws-skill-selector" role="region" aria-label="Skill selection">
                  <div className="ws-skill-selector-controls">
                    <input
                      className="skills-search"
                      type="text"
                      placeholder="search skills..."
                      value={skillSearch}
                      onChange={e => onSetSkillSearch(e.target.value)}
                      aria-label="Search workspace skills"
                    />
                    {skillSearch && (
                      <button className="btn btn-sm btn-clear-search" onClick={() => onSetSkillSearch("")} aria-label="Clear workspace skills search">clear</button>
                    )}
                    <button className="btn btn-sm" onClick={onSelectAllSkills}>all</button>
                    <button className="btn btn-sm" onClick={onClearSelectionSkills}>clear</button>
                  </div>
                  <div className="ws-skill-selector-list">
                    {filteredSkills.length === 0 ? (
                      <div className="ws-skill-selector-empty">
                        {skillSearch ? "No matching skills" : "No skills found"}
                      </div>
                    ) : (
                      filteredSkills.map(s => {
                        const isSelected = selectedSkills.has(s.name);
                        return (
                          <div key={s.id} className={`ws-skill-selector-row ${isSelected ? "ws-skill-selector-row-on" : ""}`}>
                            <button
                              className={`skills-row-check-button ${isSelected ? "skills-row-check-button-on" : ""}`}
                              onClick={() => onToggleSkill(s.name)}
                              aria-pressed={isSelected}
                              aria-label={`${isSelected ? "Deselect" : "Select"} skill ${s.name}`}
                            >
                              {isSelected ? "x" : ""}
                            </button>
                            <span className="ws-skill-selector-name">{s.name}</span>
                            <span className="ws-skill-selector-desc">{s.description}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- Verify section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Verification and backups">
              <div className="ws-section-header">
                <span className="ws-section-title">VERIFY</span>
              </div>
              <div className="ws-section-actions">
                <button className="btn btn-sm btn-primary" disabled={!canRunReleaseCheck || wsRunning !== null} onClick={onReleaseCheck}>release-check</button>
                <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onRefreshBackups}>refresh</button>
                <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onOpenBackupsFolder}>open folder</button>
              </div>
              <div className="ws-section-context">
                {backupCount > 0 ? <span>{backupCount} backup runs</span> : <span>no backups</span>}
              </div>
            </div>
          )}


        </div>

        <WorkspaceTerminal
          wsRunning={wsRunning}
          wsLog={wsLog}
          wsLogCompletedAt={wsLogCompletedAt}
          activityIndex={activityIndex}
          activityCellClass={activityCellClass}
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
