import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { runtimeChipLabel, runtimeChipTone } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, CursorProfileHealth, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface CursorViewProps {
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
  canRunReleaseCheck: boolean;
  cursorProfileHealth: CursorProfileHealth | null;
  onRefreshCursorProfile: () => void;
  onCursorDiffGlobal: () => void;
  onCursorSyncGlobal: () => void;
  onCursorCopyUserRules: () => void;
  onCursorOpenSettings: () => void;
  onCursorShowPlaywrightMcp: () => void;
  onCursorCopyPlaywrightMcp: () => void;
  onCursorCopySandboxSafe: () => void;
  onCursorCopySandboxPlaywrightSafe: () => void;
  onCursorCopySandboxPlaywrightFull: () => void;
  onCursorValidateProfile: () => void;
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

function mcpTone(status: string): "ok" | "warn" | "fail" | "muted" {
  if (status.includes("unsafe") || status.includes("invalid")) return "fail";
  if (status === "templates-only") return "ok";
  if (status.includes("present")) return "warn";
  return "muted";
}

function sandboxTone(status: string): "ok" | "warn" | "fail" | "muted" {
  if (status.includes("unsafe") || status.includes("invalid")) return "fail";
  if (status === "templates") return "ok";
  return "warn";
}

function globalAgentsTone(status: string): "ok" | "warn" | "fail" | "muted" {
  if (status === "synced") return "ok";
  if (status === "missing") return "fail";
  return "warn";
}

export function CursorView({
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
  canRunReleaseCheck,
  cursorProfileHealth,
  onRefreshCursorProfile,
  onCursorDiffGlobal,
  onCursorSyncGlobal,
  onCursorCopyUserRules,
  onCursorOpenSettings,
  onCursorShowPlaywrightMcp,
  onCursorCopyPlaywrightMcp,
  onCursorCopySandboxSafe,
  onCursorCopySandboxPlaywrightSafe,
  onCursorCopySandboxPlaywrightFull,
  onCursorValidateProfile,
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
            summary="Sync Cursor adapter agents from templates/cursor/agents. User Rules, MCP, and sandbox profiles are copy/manual."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Cursor actions." : undefined}
          />

          <TargetSettingsPanel
            page="cursor"
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
              title="Global agents"
              ariaLabel="Cursor global agents sync"
              description="Sync workspace agent templates to ~/.cursor/agents. Extra agents already in that folder are preserved."
              statusChip={health
                ? { label: runtimeChipLabel(health.status), tone: runtimeChipTone(health.status) }
                : { label: "loading", tone: "muted" }}
              details={health ? [{
                label: "Agents",
                value: `${health.global_agents_count}/${health.expected_global_agents_count} ${health.global_agents_status}`,
                tone: globalAgentsTone(health.global_agents_status),
              }] : undefined}
              warning={health && health.warnings.length > 0 ? health.warnings[0] : undefined}
              nextAction={health?.next_action}
              nextActionTone={health?.status === "synced" ? "ok" : health?.status === "missing" ? "fail" : "warn"}
              secondaryActions={[
                { label: "refresh", onClick: onRefreshCursorProfile, disabled: busy },
                { label: "diff global", onClick: onCursorDiffGlobal, disabled: busy },
                { label: "validate", onClick: onCursorValidateProfile, disabled: busy },
              ]}
              primaryAction={{
                label: "sync global",
                onClick: onCursorSyncGlobal,
                disabled: busy,
              }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="User Rules"
              ariaLabel="Cursor user rules manual copy"
              description="Copy-only. The app does not write Cursor User Rules — paste into Cursor Settings → Rules → User Rules."
              statusChip={{ label: "manual", tone: "muted" }}
              details={health ? [{
                label: "Status",
                value: health.user_rules_status,
                tone: health.user_rules_status === "synced" ? "ok" : "muted",
              }] : undefined}
              secondaryActions={[
                { label: "open settings", onClick: onCursorOpenSettings, disabled: busy },
              ]}
              primaryAction={{
                label: "copy user rules",
                onClick: onCursorCopyUserRules,
                disabled: busy,
              }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="MCP"
              ariaLabel="Cursor Playwright MCP manual merge"
              description="Template/manual merge. Copy the Playwright MCP JSON, then merge keys into .cursor/mcp.json or Cursor Settings → MCP. Do not replace the whole file."
              statusChip={{ label: "manual", tone: "muted" }}
              details={health ? [{
                label: "MCP",
                value: health.mcp_status === "templates-only" ? "templates only" : health.mcp_status,
                tone: mcpTone(health.mcp_status),
              }] : undefined}
              secondaryActions={[
                { label: "show in terminal", onClick: onCursorShowPlaywrightMcp, disabled: busy },
              ]}
              primaryAction={{
                label: "copy playwright mcp",
                onClick: onCursorCopyPlaywrightMcp,
                disabled: busy,
              }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="Sandbox profiles"
              ariaLabel="Cursor sandbox profiles manual copy"
              description="Copy-only. Paste one JSON profile at a time into Cursor sandbox / Auto-Run UI where supported."
              statusChip={{ label: "manual", tone: "muted" }}
              details={health ? [{
                label: "Templates",
                value: `${health.sandbox_profiles_count} · ${health.sandbox_status}`,
                tone: sandboxTone(health.sandbox_status),
              }] : undefined}
            >
              <div className="harness-sandbox-actions">
                <div className="harness-sandbox-row">
                  <span className="harness-sandbox-label">safe</span>
                  <span className="harness-manual-badge">minimal</span>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopySandboxSafe}>copy</button>
                </div>
                <div className="harness-sandbox-row">
                  <span className="harness-sandbox-label">playwright-safe</span>
                  <span className="harness-manual-badge">tighter</span>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopySandboxPlaywrightSafe}>copy</button>
                </div>
                <div className="harness-sandbox-row">
                  <span className="harness-sandbox-label">playwright-full</span>
                  <span className="harness-manual-badge">review</span>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={onCursorCopySandboxPlaywrightFull}>copy</button>
                </div>
              </div>
            </HarnessActionCard>
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
