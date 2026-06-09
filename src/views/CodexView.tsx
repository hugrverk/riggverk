import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import {
  codexAgentsNextAction,
  codexAgentsStatus,
  codexConfigNextAction,
  codexConfigStatus,
  codexOverallTone,
  codexRulesStatus,
  codexSkillsStatus,
  codexSurfaceTone,
} from "../lib/codexRuntimeUi";
import { runtimeChipLabel } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type {
  AgentTargetMeta,
  AppSettings,
  CodexRuntimeHealth,
  SkillSummary,
  StatusData,
  TargetProfileMeta,
} from "../types";

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
  codexAgentsEnabled: boolean;
  codexConfigEnabled: boolean;
  canRunReleaseCheck: boolean;
  codexRuntimeHealth: CodexRuntimeHealth | null;
  onRefreshCodexRuntimeHealth: () => void;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffAgents: () => void;
  onSyncAgents: () => void;
  onDiffConfigs: () => void;
  onSyncConfigs: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  skillSearch: string;
  onPreviewSyncSkills: () => void;
  onSyncAllSkills: () => void;
  onPreviewRemoveDeprecated?: () => void;
  onRemoveDeprecated?: () => void;
  onPreviewCodexLegacyMigration?: () => void;
  onMigrateCodexLegacy?: () => void;
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
  codexAgentsEnabled,
  codexConfigEnabled,
  canRunReleaseCheck,
  codexRuntimeHealth,
  onRefreshCodexRuntimeHealth,
  onDiffRules,
  onSyncRules,
  onDiffAgents,
  onSyncAgents,
  onDiffConfigs,
  onSyncConfigs,
  skills,
  skillsLoaded,
  skillSearch,
  onPreviewSyncSkills,
  onSyncAllSkills,
  onPreviewRemoveDeprecated,
  onRemoveDeprecated,
  onPreviewCodexLegacyMigration,
  onMigrateCodexLegacy,
  onSetSkillSearch,
  onOpenInstallScript,
}: CodexViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const health = codexRuntimeHealth;
  const agentsStatus = health ? codexAgentsStatus(health) : null;
  const configStatus = health ? codexConfigStatus(health) : null;
  const rulesStatus = health ? codexRulesStatus(health) : null;
  const skillsStatus = health ? codexSkillsStatus(health) : null;

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Codex controls">
          <TargetPageHeader
            icon="codex"
            title="Codex"
            summary="Sync Codex rules, native TOML agents, managed config sections, and global skills."
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
              description="Sync global agent rules to ~/.codex/AGENTS.md."
              statusChip={health && rulesStatus
                ? { label: runtimeChipLabel(rulesStatus), tone: codexSurfaceTone(rulesStatus) }
                : { label: "loading", tone: "muted" }}
              secondaryActions={[
                { label: "refresh", onClick: onRefreshCodexRuntimeHealth, disabled: busy },
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
              ariaLabel="Codex native agents sync"
              description="Bundled native TOML agents installed to ~/.codex/agents. Does not overwrite unrelated agents."
              statusChip={health && agentsStatus
                ? { label: runtimeChipLabel(agentsStatus), tone: codexSurfaceTone(agentsStatus) }
                : { label: "loading", tone: "muted" }}
              details={health ? [
                {
                  label: "Bundled",
                  value: `${health.installed_bundled_agent_count}/${health.bundled_agent_count}`,
                  tone: health.installed_bundled_agent_count === health.bundled_agent_count ? "ok" : "warn",
                },
                ...(health.agent_mismatches.length > 0 ? [{
                  label: "Diverged",
                  value: String(health.agent_mismatches.length),
                  tone: "warn" as const,
                }] : []),
                ...(health.extra_installed_agent_count > 0 ? [{
                  label: "Extra installed",
                  value: String(health.extra_installed_agent_count),
                  tone: "muted" as const,
                }] : []),
              ] : undefined}
              nextAction={health ? codexAgentsNextAction(health) : undefined}
              nextActionTone={agentsStatus === "diverged" || agentsStatus === "missing" ? "warn" : "ok"}
              secondaryActions={[
                { label: "diff agents", onClick: onDiffAgents, disabled: busy || !codexAgentsEnabled },
              ]}
              primaryAction={{
                label: "sync agents",
                onClick: onSyncAgents,
                disabled: busy || !codexAgentsEnabled,
                title: !codexAgentsEnabled ? "Enable codex agents target in Targets" : undefined,
              }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="Config"
              ariaLabel="Codex config sync"
              description="Merge bundled safe profile defaults into ~/.codex/config.toml. Preserves user model, personality, MCP, and unknown tables."
              statusChip={health && configStatus
                ? { label: runtimeChipLabel(configStatus), tone: codexSurfaceTone(configStatus) }
                : { label: "loading", tone: "muted" }}
              details={health ? [
                {
                  label: "Managed sections",
                  value: runtimeChipLabel(configStatus ?? "unknown").toLowerCase(),
                  tone: codexSurfaceTone(configStatus ?? "unknown"),
                },
                {
                  label: "Profile",
                  value: health.profile ?? "(not set)",
                  tone: "muted",
                },
                {
                  label: "Approval",
                  value: health.approval_policy ?? "(not set)",
                  tone: "muted",
                },
                {
                  label: "Sandbox",
                  value: health.sandbox_mode ?? "(not set)",
                  tone: "muted",
                },
              ] : undefined}
              nextAction={health ? codexConfigNextAction(health) : undefined}
              nextActionTone={configStatus === "diverged" ? "warn" : configStatus === "missing" ? "fail" : "ok"}
              secondaryActions={[
                { label: "diff config", onClick: onDiffConfigs, disabled: busy || !codexConfigEnabled },
              ]}
              primaryAction={{
                label: "sync config",
                onClick: onSyncConfigs,
                disabled: busy || !codexConfigEnabled,
                title: !codexConfigEnabled ? "Enable codex config target in Targets" : undefined,
              }}
            />
          )}

          {workspaceValid && health && (
            <HarnessActionCard
              title="Runtime"
              ariaLabel="Codex runtime health"
              description="Skills install to ~/.agents/skills. Legacy ~/.codex/skills migration is available from the skills panel."
              statusChip={{ label: runtimeChipLabel(health.status), tone: codexOverallTone(health) }}
              details={[
                {
                  label: "Skills",
                  value: `${health.skills_synced_count}/${health.skills_expected_count}`,
                  tone: codexSurfaceTone(skillsStatus ?? "unknown"),
                },
                ...(health.legacy_skills_migratable_count > 0 ? [{
                  label: "Legacy skills",
                  value: String(health.legacy_skills_migratable_count),
                  tone: "warn" as const,
                }] : []),
                ...(health.legacy_skills_conflict_count > 0 ? [{
                  label: "Legacy conflicts",
                  value: String(health.legacy_skills_conflict_count),
                  tone: "fail" as const,
                }] : []),
              ]}
              nextAction={health.status === "synced" ? undefined : health.next_action}
              nextActionTone={health.status === "synced" ? "ok" : "warn"}
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
            onPreviewCodexLegacyMigration={onPreviewCodexLegacyMigration}
            onMigrateCodexLegacy={onMigrateCodexLegacy}
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
