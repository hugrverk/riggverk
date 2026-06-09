import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import {
  configCheckStatusLabel,
  configCheckTone,
  opencodeAgentsNextAction,
  opencodeAgentsStatus,
  opencodeAgentsTone,
  opencodeConfigNextAction,
  opencodeConfigStatus,
  opencodeConfigTone,
} from "../lib/opencodeRuntimeUi";
import { runtimeChipLabel } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, OpenCodeRuntimeHealth, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface OpenCodeViewProps {
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
  opencodeAgentsEnabled: boolean;
  opencodeConfigEnabled: boolean;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  opencodeRuntimeHealth: OpenCodeRuntimeHealth | null;
  onRefreshOpenCodeRuntimeHealth: () => void;
  onGenerateOpenCodeConfig: () => void;
  onPlanWorkspaceRepair: () => void;
  onApplyWorkspaceRepair: () => void;
  onDiffOpenCodeAgents: () => void;
  onSyncOpenCodeAgents: () => void;
  onDiffOpenCodeConfig: () => void;
  onSyncOpenCodeConfig: () => void;
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

function snapshotTone(status: string): "ok" | "warn" | "fail" | "muted" {
  if (status === "current" || status === "valid") return "ok";
  if (status === "stale") return "warn";
  if (status === "missing") return "fail";
  return "muted";
}

function tuiTone(status: string): "ok" | "warn" | "fail" | "muted" {
  if (status === "synced") return "ok";
  if (status === "diverged") return "warn";
  if (status === "missing") return "fail";
  return "muted";
}

export function OpenCodeView({
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
  opencodeAgentsEnabled,
  opencodeConfigEnabled,
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  opencodeRuntimeHealth,
  onRefreshOpenCodeRuntimeHealth,
  onGenerateOpenCodeConfig,
  onPlanWorkspaceRepair,
  onApplyWorkspaceRepair,
  onDiffOpenCodeAgents,
  onSyncOpenCodeAgents,
  onDiffOpenCodeConfig,
  onSyncOpenCodeConfig,
  skills,
  skillsLoaded,
  skillSearch,
  onPreviewSyncSkills,
  onSyncAllSkills,
  onPreviewRemoveDeprecated,
  onRemoveDeprecated,
  onSetSkillSearch,
  onOpenInstallScript,
}: OpenCodeViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const health = opencodeRuntimeHealth;
  const staleSnapshot = health?.generated_snapshot_status === "stale";
  const showRepair = health && (
    health.generated_snapshot_status === "valid"
    || health.generated_snapshot_status === "missing"
    || health.warnings.some(w => w.includes("Repair"))
  );

  const agentMismatchCount = health?.agent_mismatches.length ?? 0;
  const agentExtra = health?.extra_installed_agent_count ?? 0;
  const agentsStatus = health ? opencodeAgentsStatus(health) : null;
  const configStatus = health ? opencodeConfigStatus(health) : null;

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="OpenCode controls">
          <TargetPageHeader
            icon="opencode"
            title="OpenCode"
            summary="Sync bundled runtime agents, OpenCode config/TUI, and install skills separately."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running OpenCode actions." : undefined}
          />

          <TargetSettingsPanel
            page="opencode"
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
              ariaLabel="OpenCode rules sync"
              description="Sync global agent rules to ~/.config/opencode/AGENTS.md."
              statusChip={{ label: ruleTargetsEnabled ? "ready" : "off", tone: ruleTargetsEnabled ? "ok" : "muted" }}
              secondaryActions={[
                { label: "diff rules", onClick: onDiffRules, disabled: busy || !ruleTargetsEnabled },
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
              title="Agents"
              ariaLabel="OpenCode bundled agents sync"
              description="Bundled runtime agents installed to ~/.config/opencode/agents. Does not change opencode.json or TUI."
              statusChip={health && agentsStatus
                ? { label: runtimeChipLabel(agentsStatus), tone: opencodeAgentsTone(health) }
                : { label: "loading", tone: "muted" }}
              details={health ? [
                {
                  label: "Bundled",
                  value: `${health.installed_bundled_agent_count}/${health.bundled_agent_count}`,
                  tone: health.installed_bundled_agent_count === health.bundled_agent_count ? "ok" : "warn",
                },
                ...(agentMismatchCount > 0 ? [{
                  label: "Diverged",
                  value: String(agentMismatchCount),
                  tone: "warn" as const,
                }] : []),
                ...(agentExtra > 0 ? [{
                  label: "Extra installed",
                  value: String(agentExtra),
                  tone: "muted" as const,
                }] : []),
              ] : undefined}
              nextAction={health ? opencodeAgentsNextAction(health) : undefined}
              nextActionTone={agentsStatus === "diverged" || agentsStatus === "missing" ? "warn" : "ok"}
              secondaryActions={[
                { label: "refresh", onClick: onRefreshOpenCodeRuntimeHealth, disabled: busy },
                { label: "diff agents", onClick: onDiffOpenCodeAgents, disabled: busy || !opencodeAgentsEnabled },
              ]}
              primaryAction={{
                label: "sync agents",
                onClick: onSyncOpenCodeAgents,
                disabled: busy || !opencodeAgentsEnabled,
                title: !opencodeAgentsEnabled ? "Enable opencode agents target in Targets" : undefined,
              }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="Config"
              ariaLabel="OpenCode config sync"
              description="Merge bundled managed keys into ~/.config/opencode/opencode.json (model, permissions, Playwright MCP, compaction). Preserves provider and other MCP servers. TUI is full-file sync."
              statusChip={health && configStatus
                ? { label: runtimeChipLabel(configStatus), tone: opencodeConfigTone(health) }
                : { label: "loading", tone: "muted" }}
              details={health ? [
                {
                  label: "Managed keys",
                  value: runtimeChipLabel(configCheckStatusLabel(health, "configs_match")).toLowerCase(),
                  tone: configCheckTone(health, "configs_match"),
                },
                {
                  label: "Model",
                  value: health.model ?? "(not set)",
                  tone: "muted",
                },
                {
                  label: "Default agent",
                  value: health.default_agent ?? "(not set)",
                  tone: "muted",
                },
                {
                  label: "Autoupdate",
                  value: health.autoupdate ?? "(not set)",
                  tone: "muted",
                },
                {
                  label: "Session snapshot",
                  value: health.snapshot == null ? "(not set)" : health.snapshot ? "enabled" : "disabled",
                  tone: "muted",
                },
                {
                  label: "TUI",
                  value: health.tui_status,
                  tone: tuiTone(health.tui_status),
                },
                {
                  label: "Template snapshot",
                  value: health.generated_snapshot_status,
                  tone: snapshotTone(health.generated_snapshot_status),
                  detail: health.generated_snapshot_status === "stale"
                    ? (health.generated_snapshot_detail || "Regenerate before sync")
                    : undefined,
                },
              ] : undefined}
              nextAction={health ? opencodeConfigNextAction(health) : undefined}
              nextActionTone={configStatus === "stale" || configStatus === "diverged" ? "warn" : configStatus === "missing" || configStatus === "invalid" ? "fail" : "ok"}
              warning={staleSnapshot
                ? (health?.generated_snapshot_detail || "Generated opencode.json is stale — regenerate before sync.")
                : undefined}
              secondaryActions={[
                { label: "diff config", onClick: onDiffOpenCodeConfig, disabled: busy || !opencodeConfigEnabled },
                {
                  label: "generate config",
                  onClick: onGenerateOpenCodeConfig,
                  disabled: busy,
                  variant: staleSnapshot ? "warn" : "default",
                  title: "Generate opencode.json from Base and Policy",
                },
              ]}
              primaryAction={{
                label: "sync config",
                onClick: onSyncOpenCodeConfig,
                disabled: busy || !opencodeConfigEnabled || staleSnapshot,
                title: staleSnapshot
                  ? "Regenerate opencode.json snapshot before sync"
                  : (!opencodeConfigEnabled ? "Enable opencode config target in Targets" : "Sync config, TUI, and Playwright MCP only"),
              }}
            />
          )}

          <TargetSkillsPanel
            targetName="OpenCode"
            installAgents={["opencode"]}
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

          {workspaceValid && showRepair && (
            <HarnessActionCard
              title="Repair"
              variant="advanced"
              ariaLabel="OpenCode workspace repair"
              description="Restore missing bundled scripts or templates when diagnostics recommend repair."
              secondaryActions={[
                { label: "check", onClick: onPlanWorkspaceRepair, disabled: busy },
              ]}
              primaryAction={{
                label: "repair",
                onClick: onApplyWorkspaceRepair,
                disabled: busy,
              }}
            />
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
