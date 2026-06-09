import { PassiveTargetView } from "./PassiveTargetView";
import type { ActionResult } from "../components/TerminalOutput";
import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, SkillSummary, StatusData } from "../types";

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
  onPreviewRemoveDeprecated?: () => void;
  onRemoveDeprecated?: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function ClaudeView(props: ClaudeViewProps) {
  return (
    <PassiveTargetView
      page="claude"
      icon="claude"
      title="Claude"
      summary="Claude rules, shared runtime agents, and global skill install."
      controlsAriaLabel="Claude target controls"
      targetName="Claude"
      installAgents={["claude"]}
      {...props}
    />
  );
}
