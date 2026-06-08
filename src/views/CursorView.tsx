import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import {
  CURSOR_STALE_RESOURCES_MESSAGE,
  isCursorWorkspaceResourcesStale,
  repairWorkspaceBlockedTitle,
} from "../lib/cursorWorkspaceResources";
import { runtimeChipLabel, runtimeChipTone } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, CursorProfileHealth, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface CursorViewProps {
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
  canRunReleaseCheck: boolean;
  cursorProfileHealth: CursorProfileHealth | null;
  onRefreshCursorProfile: () => void;
  onRepairWorkspace: () => void;
  onCursorDiffGlobalProfile: () => void;
  onCursorApplyGlobalProfile: () => void;
  onCursorValidateGlobalProfile: () => void;
  onCursorOpenSettings: () => void;
  onCursorCopyUserRules: () => void;
  onCursorShowPlaywrightMcp: () => void;
  onCursorCopyPlaywrightMcp: () => void;
  onCursorCopySandboxSafe: () => void;
  onCursorCopySandboxPlaywrightSafe: () => void;
  onCursorCopySandboxPlaywrightFull: () => void;
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

type Tone = "ok" | "warn" | "fail" | "muted";

function surfaceTone(status: string): Tone {
  if (status === "synced") return "ok";
  if (status === "missing" || status.includes("unsafe") || status.includes("invalid")) return "fail";
  if (status === "unsupported-platform" || status.includes("template")) return "muted";
  return "warn";
}

export function CursorView({
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
  canRunReleaseCheck,
  cursorProfileHealth,
  onRefreshCursorProfile,
  onRepairWorkspace,
  onCursorDiffGlobalProfile,
  onCursorApplyGlobalProfile,
  onCursorValidateGlobalProfile,
  onCursorOpenSettings,
  onCursorCopyUserRules,
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
}: CursorViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const health = cursorProfileHealth;
  const workspaceResourcesStale = isCursorWorkspaceResourcesStale(health);
  const setupActionsBlocked = workspaceResourcesStale || health?.status === "stale";
  const workspaceRepairActive = wsRunning === "repair workspace";
  const repairBusy = busy;
  const nextAction = health?.status === "synced"
    ? "Cursor setup is synced. Select Auto Review in Cursor Settings > Agents > Run Mode. Agent Workspace cannot verify the active run mode."
    : health?.next_action;

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Cursor controls">
          <TargetPageHeader
            icon="cursor"
            title="Cursor"
            summary="Sync Cursor agents, Playwright MCP, compatibility permissions, and optional skills. Cursor Auto Review and sandbox behavior remain IDE-managed and must be selected in Cursor Settings."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Cursor actions." : undefined}
          />

          <TargetSettingsPanel
            page="cursor"
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
              title="Cursor setup"
              ariaLabel="Cursor setup"
              description="Syncs Cursor agents, pinned starter skills, Playwright MCP, and the current compatibility permissions entry. Backups are created before overwriting existing files. Auto Review remains a Cursor run-mode setting."
              statusChip={health
                ? { label: runtimeChipLabel(health.status), tone: runtimeChipTone(health.status) }
                : { label: "loading", tone: "muted" }}
              details={health ? [
                {
                  label: "Profile root",
                  value: health.profile_root,
                  tone: "ok" as const,
                },
                {
                  label: "Workspace",
                  value: health.workspace_resources_status === "stale"
                    ? "workspace resources stale"
                    : health.workspace_resources_status,
                  tone: health.workspace_resources_status === "current" ? "ok" : "warn",
                },
                {
                  label: "Agents",
                  value: `${health.global_agents_count}/${health.expected_global_agents_count} ${health.global_agents_status}`,
                  tone: surfaceTone(health.global_agents_status),
                },
                {
                  label: "Skills",
                  value: `${health.global_skills_count}/${health.expected_global_skills_count} ${health.global_skills_status}`,
                  tone: surfaceTone(health.global_skills_status),
                },
                {
                  label: "MCP",
                  value: health.mcp_status,
                  tone: surfaceTone(health.mcp_status),
                },
                {
                  label: "Permissions",
                  value: health.permissions_status,
                  tone: surfaceTone(health.permissions_status),
                },
                {
                  label: "Run mode",
                  value: "manual: Auto Review recommended",
                  tone: "muted" as const,
                },
              ] : undefined}
              warning={workspaceResourcesStale
                ? CURSOR_STALE_RESOURCES_MESSAGE
                : health && health.warnings.length > 0
                  ? health.warnings[0]
                  : undefined}
              nextAction={workspaceResourcesStale ? undefined : nextAction}
              nextActionTone={health?.status === "synced" ? "ok" : health?.status === "unsafe" ? "fail" : "warn"}
              secondaryActions={[
                { label: "refresh", onClick: onRefreshCursorProfile, disabled: repairBusy },
                {
                  label: "diff setup",
                  onClick: onCursorDiffGlobalProfile,
                  disabled: repairBusy || setupActionsBlocked,
                  title: setupActionsBlocked
                    ? repairWorkspaceBlockedTitle("Diff setup")
                    : undefined,
                },
                {
                  label: "validate",
                  onClick: onCursorValidateGlobalProfile,
                  disabled: repairBusy || setupActionsBlocked,
                  title: setupActionsBlocked
                    ? repairWorkspaceBlockedTitle("Validate")
                    : undefined,
                },
                { label: "open settings", onClick: onCursorOpenSettings, disabled: repairBusy },
              ]}
              primaryAction={workspaceResourcesStale
                ? {
                    label: workspaceRepairActive ? "updating..." : "repair workspace",
                    onClick: onRepairWorkspace,
                    disabled: repairBusy,
                  }
                : {
                    label: "apply setup",
                    onClick: onCursorApplyGlobalProfile,
                    disabled: repairBusy || setupActionsBlocked,
                    title: setupActionsBlocked
                      ? repairWorkspaceBlockedTitle("Apply setup")
                      : undefined,
                  }}
              footer={(
                <div className="harness-advanced-section">
                  <h4 className="harness-advanced-section-title">Manual Cursor settings</h4>
                  <p className="harness-advanced-note">
                    Select Auto Review under Cursor Settings &gt; Agents &gt; Run Mode. User Rules remain manual. Legacy sandbox templates and MCP clipboard helpers are deprecated and no longer exposed in the normal workflow.
                  </p>
                  <div className="harness-advanced-actions">
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopyUserRules}>
                      copy user rules
                    </button>
                  </div>
                </div>
              )}
            />
          )}

          <TargetSkillsPanel
            targetName="Cursor"
            installAgents={["cursor"]}
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
            onClearSelection={onClearSelectionSkills}
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
