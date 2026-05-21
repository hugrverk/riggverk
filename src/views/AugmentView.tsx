import { PassiveTargetView } from "./PassiveTargetView";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface AugmentViewProps {
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  settingsDirty: boolean;
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
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  onDryRunSkills: () => void;
  onInstallSkills: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function AugmentView(props: AugmentViewProps) {
  return (
    <PassiveTargetView
      page="augment"
      icon="augment"
      title="Augment"
      summary="Augment rules at .augment/rules/global.md and global skill install."
      controlsAriaLabel="Augment target controls"
      targetName="Augment"
      installAgents={["auggie"]}
      {...props}
    />
  );
}
