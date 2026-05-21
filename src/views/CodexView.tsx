import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface CodexViewProps {
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  settingsDirty: boolean;
  onToggleTarget: (id: string) => void;
  onApplyProfile: (profileId: string) => void;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  ruleTargetsEnabled: boolean;
  configEnabled: boolean;
  codexConfigEnabled: boolean;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffConfigs: () => void;
  onSyncConfigs: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  onDryRunSkills: () => void;
  onInstallSkills: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function CodexView({
  appSettings,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsDirty,
  onToggleTarget,
  onApplyProfile,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  ruleTargetsEnabled,
  configEnabled,
  codexConfigEnabled,
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  onDiffConfigs,
  onSyncConfigs,
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  onDryRunSkills,
  onInstallSkills,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
  onOpenInstallScript,
}: CodexViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Codex controls">
          <TargetPageHeader
            icon="codex"
            title="Codex"
            summary="Rules and config for Codex. Sync global agent rules and templates/codex/config.toml."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Codex actions." : undefined}
          />

          <TargetSettingsPanel
            page="codex"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Codex rules sync">
              <div className="ws-section-header">
                <span className="ws-section-title">Rules</span>
              </div>
              <p className="target-compact-note">All enabled rule targets</p>
              <div className="ws-section-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null}
                  onClick={onDiffRules}
                >
                  diff enabled rules
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null}
                  onClick={onSyncRules}
                >
                  sync enabled rules
                </button>
              </div>
            </div>
          )}

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Codex config sync">
              <div className="ws-section-header">
                <span className="ws-section-title">Config</span>
              </div>
              <p className="target-compact-note">
                Enabled config targets{codexConfigEnabled ? "" : " · codex config off"}
              </p>
              <div className="ws-section-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!workspaceValid || !configEnabled || wsRunning !== null}
                  onClick={onDiffConfigs}
                >
                  diff enabled configs
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!workspaceValid || !codexConfigEnabled || !configEnabled || wsRunning !== null}
                  onClick={onSyncConfigs}
                  title={!codexConfigEnabled ? "Enable codex config target to sync" : undefined}
                >
                  sync enabled configs
                </button>
              </div>
              {!codexConfigEnabled && configEnabled && (
                <p className="target-compact-note target-compact-note-warn" role="status">
                  Enable codex config in Targets to sync.
                </p>
              )}
            </div>
          )}

          <TargetSkillsPanel
            targetName="Codex"
            installAgents={["codex"]}
            skills={skills}
            skillsLoaded={skillsLoaded}
            selectedSkills={selectedSkills}
            skillSearch={skillSearch}
            wsRunning={wsRunning}
            workspaceValid={workspaceValid}
            onDryRun={onDryRunSkills}
            onInstall={onInstallSkills}
            onToggleSkill={onToggleSkill}
            onSelectAllSkills={onSelectAllSkills}
            onClearSelectionSkills={onClearSelectionSkills}
            onSetSkillSearch={onSetSkillSearch}
            onOpenInstallScript={onOpenInstallScript}
          />
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
