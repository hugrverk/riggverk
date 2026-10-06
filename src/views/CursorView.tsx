import { TargetPageHeader, type TargetPageFact } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { HarnessInstallationCard } from "../components/HarnessInstallationCard";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import { runtimeStatusFact } from "../lib/runtimeUi";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, CursorProfileHealth, StatusData } from "../types";

interface CursorViewProps {
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
  runtimeHealth: CursorProfileHealth | null;
}

export function CursorView({
  appSettings,
  agentTargets,
  settingsSaveStatus,
  onToggleTarget,
  wsLog,
  wsLogCompletedAt,
  wsRunning,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onHarnessSetupUpdate,
  runtimeHealth,
}: CursorViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";
  const busy = wsRunning !== null;
  const facts: TargetPageFact[] = [{ label: statusText, tone: workspaceValid ? "ok" : "warn" }];
  if (workspaceValid && runtimeHealth) facts.push(runtimeStatusFact(runtimeHealth.status));

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Cursor controls">
          <TargetPageHeader
            icon="cursor"
            title="Cursor"
            summary="Sync Cursor agents, canonical bundled skills, and Playwright MCP. Auto Review, sandbox behavior, and general permissions remain IDE-managed in Cursor Settings."
            facts={facts}
            warning={!workspaceValid ? "Select a valid workspace on Start before running Cursor actions." : undefined}
          />

          <TargetSettingsPanel
            page="cursor"
            appSettings={appSettings}
            agentTargets={agentTargets}
            settingsSaveStatus={settingsSaveStatus}
            onToggleTarget={onToggleTarget}
          />

          <HarnessInstallationCard
            harness="cursor"
            title="Managed installation"
            description="One update reconciles Cursor agents, skills, and Playwright MCP with the workspace bundle."
            workspaceValid={workspaceValid}
            busy={busy}
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
