import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { HarnessActionCard } from "../components/HarnessActionCard";
import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { runtimeChipLabel } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, ClaudeRuntimeHealth, SkillSummary, StatusData } from "../types";

interface ClaudeViewProps {
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
  agentsTargetsEnabled: boolean;
  agentsStatusLabel?: string;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffAgents: () => void;
  onSyncAgents: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  skillSearch: string;
  onPreviewSyncSkills: () => void;
  onSyncAllSkills: () => void;
  onHarnessSetupUpdate: (surfaces: string[], label: string) => void;
  onSetSkillSearch: (value: string) => void;
  claudeRuntimeHealth: ClaudeRuntimeHealth | null;
  onRefreshClaudeHealth: () => void;
  onOpenInstallScript: () => void;
}

export function ClaudeView(props: ClaudeViewProps) {
  const {
    appSettings, agentTargets, settingsSaveStatus, onToggleTarget,
    wsLog, wsLogCompletedAt, wsRunning, activityIndex, activityCellClass,
    status, workspaceValid, gitAvailable, ruleTargetsEnabled,
    agentsTargetsEnabled, agentsStatusLabel, canRunReleaseCheck,
    onDiffRules, onSyncRules, onDiffAgents, onSyncAgents,
    skills, skillsLoaded, skillSearch, onPreviewSyncSkills, onSyncAllSkills, onHarnessSetupUpdate,
    onSetSkillSearch,
    claudeRuntimeHealth, onRefreshClaudeHealth, onOpenInstallScript,
  } = props;
  const busy = wsRunning !== null;
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Claude controls">
          <TargetPageHeader
            icon="claude"
            title="Claude"
            summary="Sync Claude rules, native subagents, and the canonical global skill catalog."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Claude actions." : undefined}
          />

          <TargetSettingsPanel
            page="claude"
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
          />

          <HarnessInstallationCard
            harness="claude"
            title="Managed installation"
            description="One update reconciles Claude rules, agents, and skills with the workspace bundle."
            workspaceValid={workspaceValid}
            busy={wsRunning !== null}
            onUpdate={onHarnessSetupUpdate}
          />

          {workspaceValid && claudeRuntimeHealth && (
            <HarnessActionCard
              title="Health Overview"
              ariaLabel="Claude runtime health"
              description={claudeRuntimeHealth.summary}
              details={[
                { label: "Agent count", value: `${claudeRuntimeHealth.installed_agent_count}/${claudeRuntimeHealth.expected_agent_count}`, tone: claudeRuntimeHealth.agents_synced ? "ok" : "warn" },
                { label: "Rules", value: claudeRuntimeHealth.rules_synced ? "synced" : "diverged", tone: claudeRuntimeHealth.rules_synced ? "ok" : "warn" },
                { label: "Skills", value: claudeRuntimeHealth.skills_synced ? "synced" : "pending", tone: claudeRuntimeHealth.skills_synced ? "ok" : "warn" },
                { label: "CLI", value: claudeRuntimeHealth.claude_cli_available ? "found" : "not found", tone: claudeRuntimeHealth.claude_cli_available ? "ok" : "muted" },
              ]}
              primaryAction={{ label: "refresh health", onClick: onRefreshClaudeHealth, disabled: busy }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="Rules"
              ariaLabel="Claude rules sync"
              description="Sync composed global rules to ~/.claude/CLAUDE.md."
              statusChip={{ label: runtimeChipLabel(claudeRuntimeHealth?.rules_synced ? "synced" : ruleTargetsEnabled ? "ready" : "off"), tone: claudeRuntimeHealth?.rules_synced ? "ok" : ruleTargetsEnabled ? "warn" : "muted" }}
              secondaryActions={[{ label: "diff rules", onClick: onDiffRules, disabled: busy || !ruleTargetsEnabled }]}
              primaryAction={{ label: "sync rules", onClick: onSyncRules, disabled: busy || !ruleTargetsEnabled }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="Agents"
              ariaLabel="Claude native agents sync"
              description="Sync five Claude-native subagents from templates/claude/agents to ~/.claude/agents."
              statusChip={{
                label: agentsTargetsEnabled ? (agentsStatusLabel ?? "ready") : "off",
                tone: agentsTargetsEnabled ? "ok" : "muted",
              }}
              details={[
                { label: "Expected", value: `${claudeRuntimeHealth?.expected_agent_count ?? "?"} native agents`, tone: agentsTargetsEnabled ? "ok" : "muted" },
                { label: "Source", value: "templates/claude/agents", tone: "muted" },
              ]}
              secondaryActions={[{ label: "diff agents", onClick: onDiffAgents, disabled: busy || !agentsTargetsEnabled }]}
              primaryAction={{ label: "sync agents", onClick: onSyncAgents, disabled: busy || !agentsTargetsEnabled }}
            />
          )}

          {workspaceValid && (
            <HarnessActionCard
              title="Settings and MCP"
              ariaLabel="Claude settings and MCP boundary"
              description="Claude settings and user-scoped MCP configuration remain manual. Agent Workspace manages only rules, agents, and skills."
              statusChip={{ label: "manual", tone: "muted" }}
              nextAction="Use Claude Code for settings and MCP changes."
              nextActionTone="ok"
            />
          )}

          <TargetSkillsPanel
            targetName="Claude"
            installAgents={["claude"]}
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
