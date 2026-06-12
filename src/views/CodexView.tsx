import { TargetPageHeader, type TargetPageFact } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import { runtimeStatusFact } from "../lib/runtimeUi";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, CodexRuntimeHealth, StatusData } from "../types";

interface CodexViewProps {
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
  runtimeHealth: CodexRuntimeHealth | null;
}

export function CodexView({
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
}: CodexViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const facts: TargetPageFact[] = [{ label: statusText, tone: workspaceValid ? "ok" : "warn" }];
  if (workspaceValid && runtimeHealth) facts.push(runtimeStatusFact(runtimeHealth.status));

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Codex controls">
          <TargetPageHeader
            icon="codex"
            title="Codex"
            summary="Sync Codex rules, native TOML agents, managed config sections, and global skills."
            facts={facts}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Codex actions." : undefined}
          />

          <TargetSettingsPanel
            page="codex"
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
          />

          <HarnessInstallationCard
            harness="codex"
            title="Managed installation"
            description="One update reconciles Codex config, agents, rules, and skills with the workspace bundle."
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
