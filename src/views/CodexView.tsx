import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
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
  const busy = wsRunning !== null;

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Codex controls">
          <TargetPageHeader
            icon="codex"
            title="Codex"
            summary="Sync Codex rules and config, then install skills to Codex paths."
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
            <HarnessActionCard
              title="Rules"
              ariaLabel="Codex rules sync"
              description="Sync enabled rule targets (global agent rules) to Codex paths."
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

          {workspaceValid && (
            <HarnessActionCard
              title="Config"
              ariaLabel="Codex config sync"
              description="Sync enabled config targets (templates/codex/config.toml when Codex config is on)."
              statusChip={{ label: codexConfigEnabled ? "codex on" : "codex off", tone: codexConfigEnabled ? "ok" : "muted" }}
              warning={!codexConfigEnabled && configEnabled
                ? "Enable codex config in Targets to sync Codex config.toml."
                : undefined}
              secondaryActions={[
                {
                  label: "diff config",
                  onClick: onDiffConfigs,
                  disabled: busy || !configEnabled,
                },
              ]}
              primaryAction={{
                label: "sync config",
                onClick: onSyncConfigs,
                disabled: busy || !codexConfigEnabled || !configEnabled,
                title: !codexConfigEnabled ? "Enable codex config target to sync" : undefined,
              }}
            />
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
