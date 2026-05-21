import { TerminalState, type ActionResult } from "./TerminalOutput";
import type { StatusData } from "../types";

interface WorkspaceTerminalProps {
  wsRunning: string | null;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  statusText: string;
}

export function WorkspaceTerminal({
  wsRunning,
  wsLog,
  wsLogCompletedAt,
  activityIndex,
  activityCellClass,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  statusText,
}: WorkspaceTerminalProps) {
  const terminalStatusText = wsRunning
    ? "running"
    : wsLog
      ? "completed"
      : "ready";

  return (
    <div className="ws-right" role="region" aria-label="Terminal output">
      <div className="ws-terminal-panel">
        <div className="ws-terminal-header">
          <span className="ws-terminal-title">Terminal</span>
          <span className="ws-terminal-status">
            {wsRunning ? (
              <>{terminalStatusText}: {wsRunning}</>
            ) : wsLog ? (
              <>{terminalStatusText} &middot; {wsLog.action}: {wsLog.success ? "OK" : "FAILED"}</>
            ) : (
              <>{terminalStatusText} &middot; {statusText}</>
            )}
          </span>
        </div>
        <div className="ws-terminal-body">
          <TerminalState
            runningLabel={wsRunning}
            result={wsLog}
            completedAt={wsLogCompletedAt ?? undefined}
            readyLabel="operations ready"
            activityIndex={activityIndex}
            activityCellClass={activityCellClass}
            idleContent={
              <div className="log-empty">
                <div><span className="log-prompt">$</span> operations ready</div>
                {status ? (
                  <div className="ws-idle-context">
                    <span>workspace: {workspaceValid ? "valid" : "invalid"}</span>
                    {gitAvailable && <span>branch: {status.branch}</span>}
                    <span>targets: {status.enabled_rule_target_ids.length} rules, {status.enabled_config_target_ids.length} configs</span>
                    <span className="ws-idle-hint">
                      {canRunReleaseCheck
                        ? "try: pull, diff rules, sync configs, release-check"
                        : "try: pull, diff rules, sync configs"}
                    </span>
                  </div>
                ) : (
                  <div className="ws-idle-context">
                    <span>waiting for workspace status...</span>
                  </div>
                )}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
