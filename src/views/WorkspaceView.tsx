import { useState, useMemo } from "react";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { TargetPage } from "../lib/targetGroups";
import { runtimeChipLabel, runtimeChipTone, SectionChip } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, CursorProfileHealth, InstallAgent, SkillSummary, StatusData, TargetProfileMeta } from "../types";
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
  // cursor profile
  cursorProfileHealth: CursorProfileHealth | null;
  onRefreshCursorProfile: () => void;
  onCursorDiffGlobal: () => void;
  onCursorSyncGlobal: () => void;
  onCursorShowUserRules: () => void;
  onCursorCopyUserRules: () => void;
  onCursorOpenSettings: () => void;
  onCursorShowPlaywrightMcp: () => void;
  onCursorCopyPlaywrightMcp: () => void;
  onCursorShowSandboxSafe: () => void;
  onCursorCopySandboxSafe: () => void;
  onCursorShowSandboxPlaywrightSafe: () => void;
  onCursorCopySandboxPlaywrightSafe: () => void;
  onCursorShowSandboxPlaywrightFull: () => void;
  onCursorCopySandboxPlaywrightFull: () => void;
  onCursorValidateProfile: () => void;
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
  cursorProfileHealth,
  onRefreshCursorProfile,
  onCursorDiffGlobal,
  onCursorSyncGlobal,
  onCursorShowUserRules,
  onCursorCopyUserRules,
  onCursorOpenSettings,
  onCursorShowPlaywrightMcp,
  onCursorCopyPlaywrightMcp,
  onCursorShowSandboxSafe,
  onCursorCopySandboxSafe,
  onCursorShowSandboxPlaywrightSafe,
  onCursorCopySandboxPlaywrightSafe,
  onCursorShowSandboxPlaywrightFull,
  onCursorCopySandboxPlaywrightFull,
  onCursorValidateProfile,
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

          {/* ---- Cursor Profile section ---- */}
          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Cursor Profile health">
              <div className="ws-section-header">
                <span className="ws-section-title">CURSOR PROFILE</span>
                {cursorProfileHealth ? (
                  <SectionChip label={runtimeChipLabel(cursorProfileHealth.status)} tone={runtimeChipTone(cursorProfileHealth.status)} />
                ) : (
                  <span className="ws-section-chip ws-section-chip-muted">loading</span>
                )}
              </div>

              {cursorProfileHealth && (
                <>
                  <div className="ws-runtime-summary" aria-live="polite">
                    manifest {cursorProfileHealth.manifest_status} | user rules {cursorProfileHealth.user_rules_status}
                  </div>

                  <div className="ws-runtime-rows">
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Global agents</span>
                      <span className={`ws-dot ${cursorProfileHealth.global_agents_status === "synced" ? "ws-color-ok" : cursorProfileHealth.global_agents_status === "missing" ? "ws-color-fail" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.global_agents_count}/{cursorProfileHealth.expected_global_agents_count} {cursorProfileHealth.global_agents_status}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">MCP</span>
                      <span className={`ws-dot ${cursorProfileHealth.mcp_status.includes("unsafe") || cursorProfileHealth.mcp_status.includes("invalid") ? "ws-color-fail" : cursorProfileHealth.mcp_status === "templates-only" ? "ws-color-ok" : cursorProfileHealth.mcp_status.includes("present") ? "ws-color-warn" : "ws-color-dim"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.mcp_status === "templates-only"
                          ? "templates only"
                          : cursorProfileHealth.mcp_status}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Sandbox</span>
                      <span className={`ws-dot ${cursorProfileHealth.sandbox_status.includes("unsafe") || cursorProfileHealth.sandbox_status.includes("invalid") ? "ws-color-fail" : cursorProfileHealth.sandbox_status === "templates" ? "ws-color-ok" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.sandbox_profiles_count} templates | {cursorProfileHealth.sandbox_status}
                      </span>
                    </div>
                  </div>

                  {cursorProfileHealth.warnings.length > 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {cursorProfileHealth.warnings[0]}
                      {cursorProfileHealth.warnings.length > 1 && <> (+{cursorProfileHealth.warnings.length - 1} more)</>}
                    </div>
                  )}

                  <div className={`ws-runtime-next-action ws-runtime-next-action-${cursorProfileHealth.status === "synced" ? "ok" : cursorProfileHealth.status === "missing" ? "fail" : "warn"}`}>
                    {cursorProfileHealth.next_action}
                  </div>

                  <div className="ws-cursor-action-groups">
                    <div className="ws-cursor-action-group">
                      <span className="ws-cursor-action-group-label">Global</span>
                      <button className="btn btn-sm" onClick={onRefreshCursorProfile} disabled={wsRunning !== null}>refresh</button>
                      <button className="btn btn-sm" onClick={onCursorDiffGlobal} disabled={wsRunning !== null}>diff</button>
                      <button className="btn btn-sm btn-primary" onClick={onCursorSyncGlobal} disabled={wsRunning !== null}>sync</button>
                      <button className="btn btn-sm" onClick={onCursorValidateProfile} disabled={wsRunning !== null}>validate</button>
                    </div>
                    <div className="ws-cursor-action-group">
                      <span className="ws-cursor-action-group-label">Rules</span>
                      <button className="btn btn-sm" onClick={onCursorShowUserRules} disabled={wsRunning !== null}>show</button>
                      <button className="btn btn-sm" onClick={onCursorCopyUserRules} disabled={wsRunning !== null}>copy</button>
                      <button className="btn btn-sm" onClick={onCursorOpenSettings} disabled={wsRunning !== null}>settings</button>
                    </div>
                    <div className="ws-cursor-action-group">
                      <span className="ws-cursor-action-group-label">Templates</span>
                      <button className="btn btn-sm" onClick={onCursorShowPlaywrightMcp} disabled={wsRunning !== null}>MCP show</button>
                      <button className="btn btn-sm" onClick={onCursorCopyPlaywrightMcp} disabled={wsRunning !== null}>MCP copy</button>
                      <button className="btn btn-sm" onClick={onCursorShowSandboxSafe} disabled={wsRunning !== null}>safe show</button>
                      <button className="btn btn-sm" onClick={onCursorCopySandboxSafe} disabled={wsRunning !== null}>safe copy</button>
                      <button className="btn btn-sm" onClick={onCursorShowSandboxPlaywrightSafe} disabled={wsRunning !== null}>pw-safe show</button>
                      <button className="btn btn-sm" onClick={onCursorCopySandboxPlaywrightSafe} disabled={wsRunning !== null}>pw-safe copy</button>
                      <button className="btn btn-sm" onClick={onCursorShowSandboxPlaywrightFull} disabled={wsRunning !== null}>pw-full show</button>
                      <button className="btn btn-sm" onClick={onCursorCopySandboxPlaywrightFull} disabled={wsRunning !== null}>pw-full copy</button>
                    </div>
                  </div>
                </>
              )}
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
