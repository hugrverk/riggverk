import type { AgentTargetMeta, AppSettings, TargetProfileMeta } from "../types";
import { filterProfilesForPage, filterTargetsForPage, type TargetPage } from "../lib/targetGroups";

interface TargetSettingsPanelProps {
  page: TargetPage;
  appSettings: AppSettings | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  settingsDirty: boolean;
  onToggleTarget: (id: string) => void;
  onApplyProfile: (profileId: string) => void;
}

export function TargetSettingsPanel({
  page,
  appSettings,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsDirty,
  onToggleTarget,
  onApplyProfile,
}: TargetSettingsPanelProps) {
  if (!appSettings) return null;

  const pageTargets = filterTargetsForPage(agentTargets, page);
  const pageProfiles = filterProfilesForPage(targetProfiles, page);
  const ruleTargets = pageTargets.filter(t => t.kind === "rules");
  const configTargets = pageTargets.filter(t => t.kind === "config");

  const profileMatchesPage = activeProfileId !== null && pageProfiles.some(p => p.id === activeProfileId);
  const showCustomSelection = activeProfileId === null
    || (activeProfileId !== null && !profileMatchesPage && !pageProfiles.some(p => p.id === activeProfileId));

  return (
    <div className="target-settings-panel" role="region" aria-label={`${page} target settings`}>
      {settingsDirty && (
        <div className="target-settings-dirty" role="status">
          Target changes modified — save in Settings to persist.
        </div>
      )}

      {pageProfiles.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-label">TARGET PROFILES</div>
          <div className="settings-section-body">
            <div className="settings-profile-list">
              {pageProfiles.map(p => (
                <div key={p.id} className="settings-profile-row">
                  <button
                    className={`btn btn-sm settings-profile-button ${activeProfileId === p.id ? "settings-profile-active" : ""}`}
                    aria-pressed={activeProfileId === p.id}
                    onClick={() => onApplyProfile(p.id)}
                  >
                    {p.label}
                  </button>
                  <span className={`settings-profile-description ${activeProfileId === p.id ? "settings-profile-desc-active" : ""}`}>
                    {p.description}
                  </span>
                </div>
              ))}
              {showCustomSelection && (
                <div className="settings-profile-custom">
                  <span className="settings-profile-description">custom selection</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {ruleTargets.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-label">SYNC TARGETS</div>
          <div className="settings-section-body">
            <div className="settings-target-list">
              {ruleTargets.map(t => {
                const enabled = appSettings.enabled_target_ids.includes(t.id);
                return (
                  <button
                    key={t.id}
                    className={`settings-target-row ${enabled ? "settings-target-on" : ""}`}
                    onClick={() => onToggleTarget(t.id)}
                    aria-pressed={enabled}
                  >
                    <span className={`settings-target-dot ${enabled ? "settings-target-dot-on" : ""}`} />
                    <span className="cell-value">{t.label}</span>
                    <span className="settings-target-path" title={`${t.target_rel} ← ${t.source_rel}`}>{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {configTargets.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-label">CONFIG TARGETS</div>
          <div className="settings-section-body">
            <div className="settings-target-list">
              {configTargets.map(t => {
                const enabled = appSettings.enabled_target_ids.includes(t.id);
                return (
                  <button
                    key={t.id}
                    className={`settings-target-row ${enabled ? "settings-target-on" : ""}`}
                    onClick={() => onToggleTarget(t.id)}
                    aria-pressed={enabled}
                  >
                    <span className={`settings-target-dot ${enabled ? "settings-target-dot-on" : ""}`} />
                    <span className="cell-value">{t.label}</span>
                    <span className="settings-target-path" title={`${t.target_rel} ← ${t.source_rel}`}>{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
