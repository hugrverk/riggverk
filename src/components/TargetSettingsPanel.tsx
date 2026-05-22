import type { SettingsSaveStatus } from "../lib/settingsDraft";
import type { AgentTargetMeta, AppSettings, TargetProfileMeta } from "../types";
import { filterProfilesForPage, filterTargetsForPage, type TargetPage } from "../lib/targetGroups";

interface TargetSettingsPanelProps {
  page: TargetPage;
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  settingsSaveStatus: SettingsSaveStatus;
  onToggleTarget: (id: string) => void;
  onApplyProfile: (profileId: string) => void;
}

export function TargetSettingsPanel({
  page,
  appSettings,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsSaveStatus,
  onToggleTarget,
  onApplyProfile,
}: TargetSettingsPanelProps) {
  if (!appSettings) return null;

  const pageTargets = filterTargetsForPage(agentTargets, page);
  const pageProfiles = filterProfilesForPage(targetProfiles, page);
  const ruleTargets = pageTargets.filter(t => t.kind === "rules");
  const agentTargetsOnPage = pageTargets.filter(t => t.kind === "agents");
  const configTargets = pageTargets.filter(t => t.kind === "config");

  const profileMatchesPage = activeProfileId !== null && pageProfiles.some(p => p.id === activeProfileId);
  const showCustomSelection = activeProfileId === null
    || (activeProfileId !== null && !profileMatchesPage && !pageProfiles.some(p => p.id === activeProfileId));

  const activeProfile = pageProfiles.find(p => p.id === activeProfileId);

  const autosaveNotice =
    settingsSaveStatus === "saving" || settingsSaveStatus === "pending"
      ? "Autosaving target changes…"
      : settingsSaveStatus === "error"
        ? "Could not save target changes — open Settings to retry."
        : null;

  return (
    <div className="target-panel target-settings-panel" role="region" aria-label={`${page} target settings`}>
      {autosaveNotice && (
        <div className="target-settings-dirty" role="status">
          {autosaveNotice}
        </div>
      )}

      <div className="target-panel-header">
        <h2 className="target-panel-title">Targets</h2>
      </div>

      <div className="target-panel-body">
        {pageProfiles.length > 0 && (
          <div className="target-panel-row target-panel-row-profiles">
            <span className="target-panel-row-label">profiles</span>
            <div className="target-profile-chips">
              {pageProfiles.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`btn btn-sm target-profile-chip ${activeProfileId === p.id ? "target-profile-chip-active" : ""}`}
                  aria-pressed={activeProfileId === p.id}
                  title={p.description}
                  onClick={() => onApplyProfile(p.id)}
                >
                  {p.label}
                </button>
              ))}
              {showCustomSelection && (
                <span className="target-profile-chip target-profile-chip-custom" aria-current="true">
                  custom
                </span>
              )}
            </div>
            {activeProfile && (
              <p className="target-profile-desc">{activeProfile.description}</p>
            )}
            {showCustomSelection && !activeProfile && (
              <p className="target-profile-desc">Manual target selection</p>
            )}
          </div>
        )}

        {ruleTargets.length > 0 && (
          <div className="target-panel-group">
            <div className="target-panel-group-label">rules</div>
            <div className="settings-target-list">
              {ruleTargets.map(t => {
                const enabled = appSettings.enabled_target_ids.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`settings-target-row ${enabled ? "settings-target-on" : ""}`}
                    onClick={() => onToggleTarget(t.id)}
                    aria-pressed={enabled}
                    title={`${t.target_rel} ← ${t.source_rel}`}
                  >
                    <span className={`settings-target-dot ${enabled ? "settings-target-dot-on" : ""}`} />
                    <span className="cell-value">{t.label}</span>
                    <span className="settings-target-path">{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {agentTargetsOnPage.length > 0 && (
          <div className="target-panel-group">
            <div className="target-panel-group-label">agents</div>
            <div className="settings-target-list">
              {agentTargetsOnPage.map(t => {
                const enabled = appSettings.enabled_target_ids.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`settings-target-row ${enabled ? "settings-target-on" : ""}`}
                    onClick={() => onToggleTarget(t.id)}
                    aria-pressed={enabled}
                    title={`${t.target_rel} ← ${t.source_rel}`}
                  >
                    <span className={`settings-target-dot ${enabled ? "settings-target-dot-on" : ""}`} />
                    <span className="cell-value">{t.label}</span>
                    <span className="settings-target-path">{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {configTargets.length > 0 && (
          <div className="target-panel-group">
            <div className="target-panel-group-label">config</div>
            <div className="settings-target-list">
              {configTargets.map(t => {
                const enabled = appSettings.enabled_target_ids.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`settings-target-row ${enabled ? "settings-target-on" : ""}`}
                    onClick={() => onToggleTarget(t.id)}
                    aria-pressed={enabled}
                    title={`${t.target_rel} ← ${t.source_rel}`}
                  >
                    <span className={`settings-target-dot ${enabled ? "settings-target-dot-on" : ""}`} />
                    <span className="cell-value">{t.label}</span>
                    <span className="settings-target-path">{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
