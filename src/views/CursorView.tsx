import { TargetSettingsPanel } from "../components/TargetSettingsPanel";
import { WorkspaceTerminal } from "../components/WorkspaceTerminal";
import { runtimeChipLabel, runtimeChipTone, SectionChip } from "../lib/runtimeUi";
import type { ActionResult } from "../components/TerminalOutput";
import type { AgentTargetMeta, AppSettings, CursorProfileHealth, StatusData, TargetProfileMeta } from "../types";

interface CursorViewProps {
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
  canRunReleaseCheck: boolean;
  cursorProfileHealth: CursorProfileHealth | null;
  onRefreshCursorProfile: () => void;
  onCursorDiffGlobal: () => void;
  onCursorSyncGlobal: () => void;
  onCursorShowUserRules: () => void;
  onCursorCopyUserRules: () => void;
  onCursorOpenSettings: () => void;
  onCursorShowPlaywrightMcp: () => void;
  onCursorCopyPlaywrightMcp: () => void;
  onCursorShowSandboxSafe: () => void;
  onCursorCopySandboxSafe: () => void;
  onCursorShowSandboxPlaywrightSafe: () => void;
  onCursorCopySandboxPlaywrightSafe: () => void;
  onCursorShowSandboxPlaywrightFull: () => void;
  onCursorCopySandboxPlaywrightFull: () => void;
  onCursorValidateProfile: () => void;
}

export function CursorView({
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
  canRunReleaseCheck,
  cursorProfileHealth,
  onRefreshCursorProfile,
  onCursorDiffGlobal,
  onCursorSyncGlobal,
  onCursorShowUserRules,
  onCursorCopyUserRules,
  onCursorOpenSettings,
  onCursorShowPlaywrightMcp,
  onCursorCopyPlaywrightMcp,
  onCursorShowSandboxSafe,
  onCursorCopySandboxSafe,
  onCursorShowSandboxPlaywrightSafe,
  onCursorCopySandboxPlaywrightSafe,
  onCursorShowSandboxPlaywrightFull,
  onCursorCopySandboxPlaywrightFull,
  onCursorValidateProfile,
}: CursorViewProps) {
  const statusText = workspaceValid ? "valid" : "setup needed";

  return (
    <section className="ws-layout target-page-layout">
      <div className="ws-shell">
        <div className="ws-left" role="region" aria-label="Cursor controls">
          <div className="ws-page-label">CURSOR</div>

          <p className="target-page-lead">
            Global agents can be diffed and synced to <code>~/.cursor/agents</code> when enabled.
            User Rules, MCP JSON, and sandbox profiles are copy-only — paste them into Cursor yourself.
          </p>

          <TargetSettingsPanel
            page="cursor"
            appSettings={appSettings}
            agentTargets={agentTargets}
            targetProfiles={targetProfiles}
            activeProfileId={activeProfileId}
            settingsDirty={settingsDirty}
            onToggleTarget={onToggleTarget}
            onApplyProfile={onApplyProfile}
          />

          {workspaceValid && (
            <div className="ws-section" role="region" aria-label="Cursor Profile health">
              <div className="ws-section-header">
                <span className="ws-section-title">CURSOR PROFILE</span>
                {cursorProfileHealth ? (
                  <SectionChip label={runtimeChipLabel(cursorProfileHealth.status)} tone={runtimeChipTone(cursorProfileHealth.status)} />
                ) : (
                  <span className="ws-section-chip ws-section-chip-muted">loading</span>
                )}
              </div>

              {cursorProfileHealth && (
                <>
                  <div className="ws-runtime-summary" aria-live="polite">
                    manifest {cursorProfileHealth.manifest_status} | user rules {cursorProfileHealth.user_rules_status}
                  </div>

                  <div className="ws-runtime-rows">
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Global agents</span>
                      <span className={`ws-dot ${cursorProfileHealth.global_agents_status === "synced" ? "ws-color-ok" : cursorProfileHealth.global_agents_status === "missing" ? "ws-color-fail" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.global_agents_count}/{cursorProfileHealth.expected_global_agents_count} {cursorProfileHealth.global_agents_status}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">MCP</span>
                      <span className={`ws-dot ${cursorProfileHealth.mcp_status.includes("unsafe") || cursorProfileHealth.mcp_status.includes("invalid") ? "ws-color-fail" : cursorProfileHealth.mcp_status === "templates-only" ? "ws-color-ok" : cursorProfileHealth.mcp_status.includes("present") ? "ws-color-warn" : "ws-color-dim"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.mcp_status === "templates-only"
                          ? "templates only"
                          : cursorProfileHealth.mcp_status}
                      </span>
                    </div>
                    <div className="ws-runtime-row">
                      <span className="ws-runtime-row-label">Sandbox</span>
                      <span className={`ws-dot ${cursorProfileHealth.sandbox_status.includes("unsafe") || cursorProfileHealth.sandbox_status.includes("invalid") ? "ws-color-fail" : cursorProfileHealth.sandbox_status === "templates" ? "ws-color-ok" : "ws-color-warn"}`}>{"\u25CF"}</span>
                      <span className="ws-runtime-row-value">
                        {cursorProfileHealth.sandbox_profiles_count} templates | {cursorProfileHealth.sandbox_status}
                      </span>
                    </div>
                  </div>

                  {cursorProfileHealth.warnings.length > 0 && (
                    <div className="ws-runtime-next-action ws-runtime-next-action-warn">
                      {cursorProfileHealth.warnings[0]}
                      {cursorProfileHealth.warnings.length > 1 && <> (+{cursorProfileHealth.warnings.length - 1} more)</>}
                    </div>
                  )}

                  <div className={`ws-runtime-next-action ws-runtime-next-action-${cursorProfileHealth.status === "synced" ? "ok" : cursorProfileHealth.status === "missing" ? "fail" : "warn"}`}>
                    {cursorProfileHealth.next_action}
                  </div>

                  <div className="ws-cursor-action-groups">
                    <div className="ws-cursor-action-group">
                      <span className="ws-cursor-action-group-label">Automatic</span>
                      <button className="btn btn-sm" onClick={onRefreshCursorProfile} disabled={wsRunning !== null}>refresh</button>
                      <button className="btn btn-sm" onClick={onCursorDiffGlobal} disabled={wsRunning !== null}>diff global</button>
                      <button className="btn btn-sm btn-primary" onClick={onCursorSyncGlobal} disabled={wsRunning !== null}>sync global</button>
                      <button className="btn btn-sm" onClick={onCursorValidateProfile} disabled={wsRunning !== null}>validate</button>
                    </div>
                    <div className="ws-cursor-action-group">
                      <span className="ws-cursor-action-group-label">Copy</span>
                      <button className="btn btn-sm" onClick={onCursorCopyUserRules} disabled={wsRunning !== null}>user rules</button>
                      <button className="btn btn-sm" onClick={onCursorCopyPlaywrightMcp} disabled={wsRunning !== null}>playwright mcp</button>
                      <button className="btn btn-sm" onClick={onCursorCopySandboxSafe} disabled={wsRunning !== null}>sandbox safe</button>
                      <button className="btn btn-sm" onClick={onCursorCopySandboxPlaywrightSafe} disabled={wsRunning !== null}>pw-safe</button>
                      <button className="btn btn-sm" onClick={onCursorCopySandboxPlaywrightFull} disabled={wsRunning !== null}>pw-full</button>
                    </div>
                    <div className="ws-cursor-action-group">
                      <span className="ws-cursor-action-group-label">Show</span>
                      <button className="btn btn-sm" onClick={onCursorShowUserRules} disabled={wsRunning !== null}>user rules</button>
                      <button className="btn btn-sm" onClick={onCursorShowPlaywrightMcp} disabled={wsRunning !== null}>playwright mcp</button>
                      <button className="btn btn-sm" onClick={onCursorOpenSettings} disabled={wsRunning !== null}>open settings</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="ws-section cursor-manual-guide" role="region" aria-label="Cursor manual setup guide">
            <div className="ws-section-header">
              <span className="ws-section-title">MANUAL SETUP</span>
            </div>
            <div className="cursor-manual-steps">
              <div className="cursor-manual-step">
                <div className="cursor-manual-step-head">
                  <span className="cursor-manual-step-title">User Rules</span>
                  <span className="cursor-manual-step-badge">manual paste</span>
                </div>
                <p className="cursor-manual-step-body">
                  Copy user rules, then open Cursor Settings and search for <strong>Rules</strong>.
                  Paste into <strong>User Rules</strong> (Cursor Settings → Rules → User Rules).
                  The app does not write this file for you.
                </p>
                <div className="cursor-manual-step-actions">
                  <button className="btn btn-sm" onClick={onCursorCopyUserRules} disabled={wsRunning !== null}>copy user rules</button>
                  <button className="btn btn-sm" onClick={onCursorOpenSettings} disabled={wsRunning !== null}>open cursor settings</button>
                </div>
              </div>

              <div className="cursor-manual-step">
                <div className="cursor-manual-step-head">
                  <span className="cursor-manual-step-title">Global agents</span>
                  <span className="cursor-manual-step-badge cursor-manual-step-badge-auto">app can sync</span>
                </div>
                <p className="cursor-manual-step-body">
                  Workspace templates sync to <code>~/.cursor/agents</code> when you run <strong>sync global</strong> above.
                  Run <strong>diff global</strong> first to preview changes. Existing extra agents in that folder are preserved by the install script.
                </p>
              </div>

              <div className="cursor-manual-step">
                <div className="cursor-manual-step-head">
                  <span className="cursor-manual-step-title">MCP (Playwright)</span>
                  <span className="cursor-manual-step-badge">manual paste</span>
                </div>
                <p className="cursor-manual-step-body">
                  Copy the Playwright MCP JSON template, then merge it into your Cursor MCP configuration
                  (project <code>.cursor/mcp.json</code> or Cursor Settings → MCP).
                  Keep existing MCP servers — merge keys, do not replace the whole file blindly.
                </p>
                <div className="cursor-manual-step-actions">
                  <button className="btn btn-sm" onClick={onCursorCopyPlaywrightMcp} disabled={wsRunning !== null}>copy playwright mcp</button>
                  <button className="btn btn-sm" onClick={onCursorShowPlaywrightMcp} disabled={wsRunning !== null}>show in terminal</button>
                </div>
              </div>

              <div className="cursor-manual-step">
                <div className="cursor-manual-step-head">
                  <span className="cursor-manual-step-title">Sandbox profiles</span>
                  <span className="cursor-manual-step-badge">manual paste</span>
                </div>
                <p className="cursor-manual-step-body">
                  Copy one sandbox JSON profile at a time into Cursor&apos;s sandbox / Auto-Run profile UI where supported.
                  <strong>safe</strong> — minimal allowlist.
                  <strong>playwright-safe</strong> — browser automation with tighter limits.
                  <strong>playwright-full</strong> — broader automation; review before use.
                </p>
                <div className="cursor-manual-step-actions">
                  <button className="btn btn-sm" onClick={onCursorCopySandboxSafe} disabled={wsRunning !== null}>copy safe</button>
                  <button className="btn btn-sm" onClick={onCursorShowSandboxSafe} disabled={wsRunning !== null}>show safe</button>
                  <button className="btn btn-sm" onClick={onCursorCopySandboxPlaywrightSafe} disabled={wsRunning !== null}>copy pw-safe</button>
                  <button className="btn btn-sm" onClick={onCursorShowSandboxPlaywrightSafe} disabled={wsRunning !== null}>show pw-safe</button>
                  <button className="btn btn-sm" onClick={onCursorCopySandboxPlaywrightFull} disabled={wsRunning !== null}>copy pw-full</button>
                  <button className="btn btn-sm" onClick={onCursorShowSandboxPlaywrightFull} disabled={wsRunning !== null}>show pw-full</button>
                </div>
              </div>
            </div>
          </div>

          {!workspaceValid && (
            <div className="ws-card-warn">Select a valid workspace on Start before running Cursor actions.</div>
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
