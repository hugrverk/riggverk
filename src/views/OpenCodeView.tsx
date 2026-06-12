import { TargetPageHeader, type TargetPageFact } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import { runtimeStatusFact } from "../lib/runtimeUi";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, OpenCodeRuntimeHealth, StatusData } from "../types";

interface OpenCodeViewProps {
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
  canRunReleaseCheck: boolean;
  onHarnessSetupUpdate: (surfaces: string[], label: string) => void;
  runtimeHealth: OpenCodeRuntimeHealth | null;
}

export function OpenCodeView({
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
  canRunReleaseCheck,
  onHarnessSetupUpdate,
  runtimeHealth,
}: OpenCodeViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const facts: TargetPageFact[] = [{ label: statusText, tone: workspaceValid ? "ok" : "warn" }];
  if (workspaceValid && runtimeHealth) facts.push(runtimeStatusFact(runtimeHealth.status));

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="OpenCode controls">
          <TargetPageHeader
            icon="opencode"
            title="OpenCode"
            summary="Install or update OpenCode rules, config, agents, and skills through one managed workflow."
            facts={facts}
            warning={!workspaceValid ? "Select a valid workspace on Start before running OpenCode actions." : undefined}
          />

          <TargetSettingsPanel
            page="opencode"
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
          />

          <HarnessInstallationCard
            harness="opencode"
            title="Managed installation"
            description="One update reconciles OpenCode config, agents, rules, and skills with the workspace bundle."
            workspaceValid={workspaceValid}
            busy={busy}
            onUpdate={onHarnessSetupUpdate}
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
