import { TargetPageHeader } from "../components/TargetPageHeader";
import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { TargetSkillsPanel } from "../components/TargetSkillsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { runtimeChipLabel, runtimeChipTone, SectionChip } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, OpenCodeRuntimeHealth, SkillSummary, StatusData, TargetProfileMeta } from "../types";

interface OpenCodeViewProps {
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
  configEnabled: boolean;
  canRunReleaseCheck: boolean;
  opencodeRuntimeHealth: OpenCodeRuntimeHealth | null;
  onRefreshOpenCodeRuntimeHealth: () => void;
  onGenerateOpenCodeConfig: () => void;
  onPlanWorkspaceRepair: () => void;
  onApplyWorkspaceRepair: () => void;
  onDiffConfigs: () => void;
  onSyncConfigs: () => void;
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

export function OpenCodeView({
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
  configEnabled,
  canRunReleaseCheck,
  opencodeRuntimeHealth,
  onRefreshOpenCodeRuntimeHealth,
  onGenerateOpenCodeConfig,
  onPlanWorkspaceRepair,
  onApplyWorkspaceRepair,
  onDiffConfigs,
  onSyncConfigs,
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  onDryRunSkills,
  onInstallSkills,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
  onOpenInstallScript,
}: OpenCodeViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="OpenCode controls">
          <TargetPageHeader
            icon="opencode"
            title="OpenCode"
            summary="Runtime config, bundled agents, generated snapshot, and OpenCode skills."
            facts={workspaceValid ? [{ label: statusText, tone: "ok" }] : [{ label: statusText, tone: "warn" }]}
            warning={!workspaceValid ? "Select a valid workspace on Start before running OpenCode actions." : undefined}
          />

          <TargetSettingsPanel
            page="opencode"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="OpenCode Runtime health">
              <div className="ws-section-header">
                <span className="ws-section-title">Runtime</span>
                {opencodeRuntimeHealth ? (
                  <SectionChip label={runtimeChipLabel(opencodeRuntimeHealth.status)} tone={runtimeChipTone(opencodeRuntimeHealth.status)} />
                ) : (
                  <span className="ws-section-chip ws-section-chip-muted">loading</span>
                )}
              </div>

              {opencodeRuntimeHealth && (
                <>
                  <div className="ws-runtime-summary" aria-live="polite">
                    {opencodeRuntimeHealth.summary}
                  </div>

                  <div className="ws-runtime-rows">
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Config</span>
                      <span className={`ws-dot ${opencodeRuntimeHealth.checks.find(c => c.id === "configs_match")?.status === "pass" ? "ws-color-ok" : opencodeRuntimeHealth.checks.find(c => c.id === "configs_match")?.status === "warn" ? "ws-color-warn" : "ws-color-dim"}`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {runtimeChipLabel(opencodeRuntimeHealth.status).toLowerCase()}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">TUI</span>
                      <span className={`ws-dot ${opencodeRuntimeHealth.tui_status === "synced" ? "ws-color-ok" : opencodeRuntimeHealth.tui_status === "diverged" ? "ws-color-warn" : opencodeRuntimeHealth.tui_status === "missing" ? "ws-color-fail" : "ws-color-dim"}`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {runtimeChipLabel(opencodeRuntimeHealth.tui_status).toLowerCase()}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Agents</span>
                      <span className={`ws-dot ${opencodeRuntimeHealth.agent_mismatches.length === 0 ? "ws-color-ok" : "ws-color-warn"}`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {opencodeRuntimeHealth.installed_bundled_agent_count}/{opencodeRuntimeHealth.bundled_agent_count} bundled
                        {opencodeRuntimeHealth.agent_mismatches.length > 0
                          ? ` (${opencodeRuntimeHealth.agent_mismatches.length} diverged)`
                          : ""}
                        {opencodeRuntimeHealth.extra_installed_agent_count > 0
                          ? ` (+${opencodeRuntimeHealth.extra_installed_agent_count} extra)`
                          : ""}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Generated</span>
                      <span className={`ws-dot ${
                        opencodeRuntimeHealth.generated_snapshot_status === "current" ? "ws-color-ok"
                        : opencodeRuntimeHealth.generated_snapshot_status === "valid" ? "ws-color-ok"
                        : opencodeRuntimeHealth.generated_snapshot_status === "stale" ? "ws-color-fail"
                        : opencodeRuntimeHealth.generated_snapshot_status === "missing" ? "ws-color-fail"
                        : "ws-color-dim"
                      }`}>
                        {"\u25CF"}
                      </span>
                      <span className="ws-runtime-row-value">
                        {opencodeRuntimeHealth.generated_snapshot_status}
                        {opencodeRuntimeHealth.generated_snapshot_status === "stale" && (
                          <span className="ws-runtime-row-detail"> — Regenerate before sync</span>
                        )}
                      </span>
                    </div>
                  </div>

                  {opencodeRuntimeHealth.generated_snapshot_status === "stale" && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-fail">
                      {opencodeRuntimeHealth.generated_snapshot_detail || "Regenerate opencode.json before sync"}
                    </div>
                  )}

                  {opencodeRuntimeHealth.agent_mismatches.length > 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {opencodeRuntimeHealth.agent_mismatches.length} agent(s) diverged or missing.
                    </div>
                  )}

                  {opencodeRuntimeHealth.warnings.length > 0 && opencodeRuntimeHealth.agent_mismatches.length === 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {opencodeRuntimeHealth.warnings[0]}
                      {opencodeRuntimeHealth.warnings.length > 1 && (
                        <> (+{opencodeRuntimeHealth.warnings.length - 1} more)</>
                      )}
                    </div>
                  )}

                  <div className={`ws-runtime-next-action ws-runtime-next-action-${opencodeRuntimeHealth.status === "synced" ? "ok" : opencodeRuntimeHealth.status === "diverged" ? "warn" : opencodeRuntimeHealth.status === "missing" ? "fail" : "ok"}`}>
                    {opencodeRuntimeHealth.next_action}
                  </div>

                  <div className="ws-section-actions">
                    <button className="btn btn-sm" onClick={onRefreshOpenCodeRuntimeHealth} aria-label="Refresh OpenCode runtime health">
                      refresh
                    </button>
                    <button className="btn btn-sm" disabled={!workspaceValid || !configEnabled || wsRunning !== null} onClick={onDiffConfigs}>
                      diff enabled configs
                    </button>
                    <button
                      className={`btn btn-sm ${opencodeRuntimeHealth.generated_snapshot_status === "stale" ? "btn-warn" : ""}`}
                      disabled={!workspaceValid || wsRunning !== null}
                      onClick={onGenerateOpenCodeConfig}
                      title="Generate opencode.json from Base and Policy."
                    >
                      generate opencode config
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!workspaceValid || !configEnabled || wsRunning !== null || opencodeRuntimeHealth.generated_snapshot_status === "stale"}
                      onClick={onSyncConfigs}
                      title={opencodeRuntimeHealth.generated_snapshot_status === "stale" ? "Regenerate opencode.json snapshot before sync" : undefined}
                    >
                      sync enabled configs
                    </button>
                  </div>

                  {(opencodeRuntimeHealth.generated_snapshot_status === "valid" || opencodeRuntimeHealth.generated_snapshot_status === "missing" || opencodeRuntimeHealth.warnings.some(w => w.includes("Repair"))) && (
                    <div className="ws-repair-box">
                      <div className="ws-repair-title">Workspace Repair</div>
                      <div className="ws-repair-hint">
                        Missing bundled scripts or templates can be repaired.
                      </div>
                      <div className="ws-repair-actions">
                        <button className="btn btn-sm" disabled={wsRunning !== null} onClick={onPlanWorkspaceRepair}>
                          check
                        </button>
                        <button className="btn btn-sm btn-primary" disabled={wsRunning !== null} onClick={onApplyWorkspaceRepair}>
                          repair
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <TargetSkillsPanel
            targetName="OpenCode"
            installAgents={["opencode"]}
            skills={skills}
            skillsLoaded={skillsLoaded}
            selectedSkills={selectedSkills}
            skillSearch={skillSearch}
            wsRunning={wsRunning}
            workspaceValid={workspaceValid}
            onDryRun={onDryRunSkills}
            onInstall={onInstallSkills}
            onToggleSkill={onToggleSkill}
            onSelectAllSkills={onSelectAllSkills}
            onClearSelectionSkills={onClearSelectionSkills}
            onSetSkillSearch={onSetSkillSearch}
            onOpenInstallScript={onOpenInstallScript}
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
