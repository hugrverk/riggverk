import { TargetPageHeader, type TargetPageFact } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import { runtimeStatusFact } from "../lib/runtimeUi";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, ClaudeRuntimeHealth, StatusData } from "../types";

interface ClaudeViewProps {
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  settingsSaveStatus: SettingsSaveStatus;
  onToggleTarget: (id: string) => void;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  wsRunning: string | null;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  onHarnessSetupUpdate: (surfaces: string[], label: string) => void;
  runtimeHealth: ClaudeRuntimeHealth | null;
}

export function ClaudeView(props: ClaudeViewProps) {
  const {
    appSettings, agentTargets, settingsSaveStatus, onToggleTarget,
    wsLog, wsLogCompletedAt, wsRunning,
    status, workspaceValid, gitAvailable, canRunReleaseCheck,
    onHarnessSetupUpdate, runtimeHealth,
  } = props;
  const statusText = workspaceValid ? "valid" : "setup needed";
  const facts: TargetPageFact[] = [{ label: statusText, tone: workspaceValid ? "ok" : "warn" }];
  if (workspaceValid && runtimeHealth) {
    const runtimeStatus = runtimeHealth.rules_synced && runtimeHealth.agents_synced && runtimeHealth.skills_synced
      ? "synced"
      : "diverged";
    facts.push(runtimeStatusFact(runtimeStatus));
  }

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Claude controls">
          <TargetPageHeader
            icon="claude"
            title="Claude"
            summary="Sync Claude rules, native subagents, and the canonical global skill catalog."
            facts={facts}
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

        </div>

        <WorkspaceTerminal
          wsRunning={wsRunning}
          wsLog={wsLog}
          wsLogCompletedAt={wsLogCompletedAt}
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
