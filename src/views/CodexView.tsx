import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, StatusData, TargetProfileMeta } from "../types";

interface CodexViewProps {
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
  configEnabled: boolean;
  codexConfigEnabled: boolean;
  canRunReleaseCheck: boolean;
  onDiffRules: () => void;
  onSyncRules: () => void;
  onDiffConfigs: () => void;
  onSyncConfigs: () => void;
}

export function CodexView({
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
  configEnabled,
  codexConfigEnabled,
  canRunReleaseCheck,
  onDiffRules,
  onSyncRules,
  onDiffConfigs,
  onSyncConfigs,
}: CodexViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Codex controls">
          <div className="ws-page-label">CODEX</div>

          <p className="target-page-lead">
            Codex rules sync AGENTS.md-style rules from the selected workspace template.
            Codex config syncs <code>templates/codex/config.toml</code> to your Codex install path.
          </p>

          <TargetSettingsPanel
            page="codex"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Codex rules sync">
              <div className="ws-section-header">
                <span className="ws-section-title">RULES</span>
              </div>
              <p className="target-page-hint">
                Diff and sync operate on all enabled rule targets, not Codex alone.
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

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Codex config sync">
              <div className="ws-section-header">
                <span className="ws-section-title">CONFIG</span>
              </div>
              <p className="target-page-hint">
                Config diff/sync runs for enabled config targets when codex config is enabled.
              </p>
              <div className="ws-section-actions">
                <button
                  className="btn btn-sm"
                  disabled={!workspaceValid || !configEnabled || wsRunning !== null}
                  onClick={onDiffConfigs}
                >
                  diff enabled configs
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!workspaceValid || !codexConfigEnabled || !configEnabled || wsRunning !== null}
                  onClick={onSyncConfigs}
                  title={!codexConfigEnabled ? "Enable codex config target to sync" : undefined}
                >
                  sync enabled configs
                </button>
              </div>
              {!codexConfigEnabled && configEnabled && (
                <div className="ws-card-warn">codex config target is disabled in sync targets above.</div>
              )}
            </div>
          )}

          {!workspaceValid && (
            <div className="ws-card-warn">Select a valid workspace on Start before running Codex actions.</div>
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
