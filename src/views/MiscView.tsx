import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, StatusData, TargetProfileMeta } from "../types";

interface MiscViewProps {
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
}

export function MiscView({
  appSettings,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsDirty,
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
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
}: MiscViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Misc target controls">
          <div className="ws-page-label">MISC</div>

          <p className="target-page-lead">
            Passive rule sync targets for Auggie and Claude. They share the workspace global rules template.
            Sync behavior follows whichever rule targets are enabled.
          </p>

          <TargetSettingsPanel
            page="misc"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Passive rules sync">
              <div className="ws-section-header">
                <span className="ws-section-title">RULES</span>
              </div>
              <p className="target-page-hint">
                Diff and sync operate on all enabled rule targets.
              </p>
              <div className="ws-section-actions">
                <button
                  className="btn btn-sm"
                  disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null}
                  onClick={onDiffRules}
                >
                  diff enabled rules
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!workspaceValid || !ruleTargetsEnabled || wsRunning !== null}
                  onClick={onSyncRules}
                >
                  sync enabled rules
                </button>
              </div>
            </div>
          )}

          {!workspaceValid && (
            <div className="ws-card-warn">Select a valid workspace on Start before syncing passive targets.</div>
          )}
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
