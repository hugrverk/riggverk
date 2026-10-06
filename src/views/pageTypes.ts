import type { InstallationOverview } from "../hooks/useInstallationOverview";
import type { InstallScreen } from "../hooks/useInstallScreen";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { ActionResult, AgentTargetMeta, AppSettings, StatusData } from "../types";

/** What the output pane of the Start and harness pages needs. */
export interface PageOutputProps {
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  /** Label of the workspace task in flight, or null. */
  wsRunning: string | null;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  onClearOutput: () => void;
}

/** Installation state, the install review and the rollback path, shared by the Start and harness pages. */
export interface PageInstallProps {
  overview: InstallationOverview;
  install: InstallScreen;
  /** Where backups are written, for the note under the plan. */
  backupRoot: string | null;
  /** Transaction the last install or uninstall left, if it can still be rolled back. */
  rollbackTransactionId: string | null;
  /** Dry run, confirm, then roll back. */
  onRollback: () => void;
  /** Reload workspace status, installation state and backups. */
  onRefresh: () => void;
}

/** Props every harness page (Codex, OpenCode, Cursor, Claude) receives from the app shell. */
export interface HarnessViewProps extends PageOutputProps, PageInstallProps {
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  settingsSaveStatus: SettingsSaveStatus;
  onToggleTarget: (id: string) => void;
}
