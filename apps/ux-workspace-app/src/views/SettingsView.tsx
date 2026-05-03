import type { AgentTargetMeta, AppSettings, TargetProfileMeta } from "../types";

interface SettingsMessage {
  ok: boolean;
  text: string;
}

interface SettingsViewProps {
  appSettings: AppSettings | null;
  settingsMsg: SettingsMessage | null;
  agentTargets: AgentTargetMeta[];
  targetProfiles: TargetProfileMeta[];
  activeProfileId: string | null;
  settingsDirty: boolean;
  onSetAppearance: (appearance: AppSettings["appearance"]) => void;
  onToggleTarget: (id: string) => void;
  onApplyProfile: (profileId: string) => void;
  onSave: () => void;
  onReset: () => void;
}

export function SettingsView({
  appSettings,
  settingsMsg,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsDirty,
  onSetAppearance,
  onToggleTarget,
  onApplyProfile,
  onSave,
  onReset,
}: SettingsViewProps) {
  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">SETTINGS</span>
        {settingsDirty && <span className="editor-dirty">modified — save to persist</span>}
      </div>
      {appSettings && (
        <div className="settings-form">
          <div className="settings-group">
            <span className="cell-label">APPEARANCE</span>
            <div className="settings-options">
              {(["dark", "light", "system"] as const).map(m => (
                <button key={m} className={`btn btn-sm ${appSettings.appearance === m ? "btn-active" : ""}`}
                  aria-pressed={appSettings.appearance === m}
                  onClick={() => onSetAppearance(m)}>{m}</button>
              ))}
            </div>
          </div>

          <div className="settings-path-hint">
            Workspace path is managed in the Workspace tab.
          </div>

          {targetProfiles.length > 0 && (
            <div className="settings-group settings-group-top">
              <span className="cell-label">TARGET PROFILES</span>
              <div className="settings-profile-list">
                {targetProfiles.map(p => (
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
                {activeProfileId === null && (
                  <div className="settings-profile-custom">
                    <span className="settings-profile-description">custom selection</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="settings-group settings-group-top">
            <span className="cell-label">RULE TARGETS</span>
            <div className="settings-target-list">
              {agentTargets.filter(t => t.kind === "rules").map(t => {
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
                    <span className="settings-target-path">{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-group settings-group-top">
            <span className="cell-label">CONFIG TARGETS</span>
            <div className="settings-target-list">
              {agentTargets.filter(t => t.kind === "config").map(t => {
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
                    <span className="settings-target-path">{t.target_rel}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={onSave}>save</button>
            <button className="btn" onClick={onReset}>reset defaults</button>
          </div>
          {settingsMsg && (
            <div className={`settings-msg ${settingsMsg.ok ? "log-ok" : "log-fail"}`}>
              <span className="log-prompt">$</span> {settingsMsg.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
