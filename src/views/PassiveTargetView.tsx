import { TargetPageHeader } from "../components/TargetPageHeader";
import type { ToolIconName } from "../components/ToolIcon";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, InstallAgent, SkillSummary, StatusData, TargetProfileMeta } from "../types";
import type { TargetPage } from "../lib/targetGroups";

interface PassiveTargetViewProps {
  page: TargetPage;
  icon: ToolIconName;
  title: string;
  summary: string;
  controlsAriaLabel: string;
  targetName: string;
  installAgents: InstallAgent[];
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
  onDryRunSkills: () => void;
  onInstallSkills: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function PassiveTargetView({
  page,
  icon,
  title,
  summary,
  controlsAriaLabel,
  targetName,
  installAgents,
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
  onDryRunSkills,
  onInstallSkills,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
  onOpenInstallScript,
}: PassiveTargetViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label={controlsAriaLabel}>
          <TargetPageHeader
            icon={icon}
            title={title}
            summary={summary}
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? `Select a valid workspace on Start before syncing ${title} targets.` : undefined}
          />

          <TargetSettingsPanel
            page={page}
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <HarnessActionCard
              title="Rules"
              ariaLabel={`${title} rules sync`}
              description={`Sync enabled rule targets to ${title} paths.`}
              statusChip={{ label: ruleTargetsEnabled ? "ready" : "off", tone: ruleTargetsEnabled ? "ok" : "muted" }}
              secondaryActions={[
                {
                  label: "diff rules",
                  onClick: onDiffRules,
                  disabled: busy || !ruleTargetsEnabled,
                  title: !ruleTargetsEnabled ? "Enable rule targets in Targets" : undefined,
                },
              ]}
              primaryAction={{
                label: "sync rules",
                onClick: onSyncRules,
                disabled: busy || !ruleTargetsEnabled,
              }}
            />
          )}

          <TargetSkillsPanel
            targetName={targetName}
            installAgents={installAgents}
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
