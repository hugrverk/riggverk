import { TargetPageHeader } from "../components/TargetPageHeader";
import type { ToolIconName } from "../components/ToolIcon";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, InstallAgent, SkillSummary, StatusData } from "../types";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
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
  settingsSaveStatus: SettingsSaveStatus;
  onToggleTarget: (id: string) => void;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  ruleTargetsEnabled: boolean;
  agentsTargetsEnabled?: boolean;
  agentsStatusLabel?: string;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffAgents?: () => void;
  onSyncAgents?: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  skillSearch: string;
  onPreviewSyncSkills: () => void;
  onSyncAllSkills: () => void;
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
  settingsSaveStatus,
  onToggleTarget,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  ruleTargetsEnabled,
  agentsTargetsEnabled = false,
  agentsStatusLabel,
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  onDiffAgents,
  onSyncAgents,
  skills,
  skillsLoaded,
  skillSearch,
  onPreviewSyncSkills,
  onSyncAllSkills,
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
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
          />

          {workspaceValid && onDiffAgents && onSyncAgents && (
            <HarnessActionCard
              title="Agents"
              ariaLabel={`${title} shared runtime agents sync`}
              description={`Sync bundled runtime agents from agents/ to ${title} paths.`}
              statusChip={{
                label: agentsTargetsEnabled ? (agentsStatusLabel ?? "ready") : "off",
                tone: agentsTargetsEnabled ? "ok" : "muted",
              }}
              secondaryActions={[
                {
                  label: "diff agents",
                  onClick: onDiffAgents,
                  disabled: busy || !agentsTargetsEnabled,
                  title: !agentsTargetsEnabled ? "Enable agents target in Targets" : undefined,
                },
              ]}
              primaryAction={{
                label: "sync agents",
                onClick: onSyncAgents,
                disabled: busy || !agentsTargetsEnabled,
              }}
            />
          )}

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
            skillSearch={skillSearch}
            wsRunning={wsRunning}
            workspaceValid={workspaceValid}
            onPreviewSync={onPreviewSyncSkills}
            onSyncAll={onSyncAllSkills}
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
