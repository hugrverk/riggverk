import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface CodexViewProps {
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  settingsSaveStatus: SettingsSaveStatus;
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
  codexConfigEnabled: boolean;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffConfigs: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  skillSearch: string;
  onPreviewSyncSkills: () => void;
  onSyncAllSkills: () => void;
  onPreviewRemoveDeprecated?: () => void;
  onRemoveDeprecated?: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function CodexView({
  appSettings,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsSaveStatus,
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
  codexConfigEnabled,
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  onDiffConfigs,
  skills,
  skillsLoaded,
  skillSearch,
  onPreviewSyncSkills,
  onSyncAllSkills,
  onPreviewRemoveDeprecated,
  onRemoveDeprecated,
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
            summary="Sync Codex rules, review config diffs manually, and install skills to Codex paths."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Codex actions." : undefined}
          />

          <TargetSettingsPanel
            page="codex"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <HarnessActionCard
              title="Rules"
              ariaLabel="Codex rules sync"
              description="Diff or sync the global agent rules template to ~/.codex/AGENTS.md."
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
              description="Manual-review template for ~/.codex/config.toml. Diff is available; app apply is disabled to avoid clobbering Codex-managed settings."
              statusChip={{ label: codexConfigEnabled ? "manual review" : "off", tone: codexConfigEnabled ? "warn" : "muted" }}
              warning={codexConfigEnabled
                ? "Review the diff and update Codex config manually. The app will not overwrite ~/.codex/config.toml."
                : "Codex config is off by default. Enable only when you need a manual diff against the bundled template."
              }
              secondaryActions={[
                {
                  label: "diff config",
                  onClick: onDiffConfigs,
                  disabled: busy || !codexConfigEnabled,
                  title: !codexConfigEnabled ? "Enable codex config target for manual diff" : undefined,
                },
              ]}
            />
          )}

          <TargetSkillsPanel
            targetName="Codex"
            installAgents={["codex"]}
            skills={skills}
            skillsLoaded={skillsLoaded}
            skillSearch={skillSearch}
            wsRunning={wsRunning}
            workspaceValid={workspaceValid}
            onPreviewSync={onPreviewSyncSkills}
            onSyncAll={onSyncAllSkills}
            onPreviewRemoveDeprecated={onPreviewRemoveDeprecated}
            onRemoveDeprecated={onRemoveDeprecated}
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
