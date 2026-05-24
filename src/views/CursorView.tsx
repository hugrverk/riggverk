import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
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

function shellTone(status: string): Tone {
  if (status.startsWith("restricted")) return "ok";
  if (status.includes("unsafe")) return "fail";
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
  onCursorDiffGlobalProfile,
  onCursorApplyGlobalProfile,
  onCursorValidateGlobalProfile,
  onCursorOpenSettings,
  onCursorCopyUserRules,
  onCursorShowPlaywrightMcp,
  onCursorCopyPlaywrightMcp,
  onCursorCopySandboxSafe,
  onCursorCopySandboxPlaywrightSafe,
  onCursorCopySandboxPlaywrightFull,
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

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Cursor controls">
          <TargetPageHeader
            icon="cursor"
            title="Cursor"
            summary="Apply one global Playwright profile to ~/.cursor (agents, skills, MCP, permissions). No project files are written. Playwright MCP can run autonomously; shell stays restricted."
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
              title="Global Cursor profile"
              ariaLabel="Cursor global Playwright profile"
              description="Syncs ~/.cursor/agents, ~/.cursor/skills, ~/.cursor/mcp.json (playwright server merge), and ~/.cursor/permissions.json (playwright:* MCP allowlist). Backups are created before overwriting existing files."
              statusChip={health
                ? { label: runtimeChipLabel(health.status), tone: runtimeChipTone(health.status) }
                : { label: "loading", tone: "muted" }}
              details={health ? [
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
                  label: "Shell",
                  value: health.shell_posture_status,
                  tone: shellTone(health.shell_posture_status),
                },
              ] : undefined}
              warning={health && health.warnings.length > 0 ? health.warnings[0] : undefined}
              nextAction={health?.next_action}
              nextActionTone={health?.status === "synced" ? "ok" : health?.status === "unsafe" ? "fail" : "warn"}
              secondaryActions={[
                { label: "refresh", onClick: onRefreshCursorProfile, disabled: busy },
                { label: "diff global", onClick: onCursorDiffGlobalProfile, disabled: busy },
                { label: "validate", onClick: onCursorValidateGlobalProfile, disabled: busy },
                { label: "open settings", onClick: onCursorOpenSettings, disabled: busy },
              ]}
              primaryAction={{
                label: "apply global",
                onClick: onCursorApplyGlobalProfile,
                disabled: busy,
              }}
            />
          )}

          {workspaceValid && (
            <details className="harness-advanced-panel">
              <summary>Advanced / debug</summary>
              <div className="harness-advanced-body">
                <p className="harness-advanced-note">
                  User Rules are still manual in Cursor Settings. Legacy sandbox JSON templates are copy-only.
                </p>
                <div className="harness-advanced-actions">
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopyUserRules}>
                    copy user rules
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorShowPlaywrightMcp}>
                    show mcp template
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopyPlaywrightMcp}>
                    copy mcp template
                  </button>
                </div>
                <div className="harness-sandbox-actions">
                  <div className="harness-sandbox-row">
                    <span className="harness-sandbox-label">legacy safe</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopySandboxSafe}>copy</button>
                  </div>
                  <div className="harness-sandbox-row">
                    <span className="harness-sandbox-label">legacy playwright-safe</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopySandboxPlaywrightSafe}>copy</button>
                  </div>
                  <div className="harness-sandbox-row">
                    <span className="harness-sandbox-label">legacy playwright-full</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopySandboxPlaywrightFull}>copy</button>
                  </div>
                </div>
              </div>
            </details>
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
