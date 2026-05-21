import { TargetMiscSkillsPanel } from "../components/TargetMiscSkillsPanel";
import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface MiscViewProps {
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
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  onDryRunAuggieSkills: () => void;
  onInstallAuggieSkills: () => void;
  onDryRunClaudeSkills: () => void;
  onInstallClaudeSkills: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function MiscView({
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
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  onDryRunAuggieSkills,
  onInstallAuggieSkills,
  onDryRunClaudeSkills,
  onInstallClaudeSkills,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
  onOpenInstallScript,
}: MiscViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Misc target controls">
          <TargetPageHeader
            title="Misc"
            summary="Passive rule and skill targets for Auggie and Claude."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before syncing passive targets." : undefined}
          />

          <TargetSettingsPanel
            page="misc"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Passive rules sync">
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

          <TargetMiscSkillsPanel
            skills={skills}
            skillsLoaded={skillsLoaded}
            selectedSkills={selectedSkills}
            skillSearch={skillSearch}
            wsRunning={wsRunning}
            workspaceValid={workspaceValid}
            onDryRunAuggie={onDryRunAuggieSkills}
            onInstallAuggie={onInstallAuggieSkills}
            onDryRunClaude={onDryRunClaudeSkills}
            onInstallClaude={onInstallClaudeSkills}
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
