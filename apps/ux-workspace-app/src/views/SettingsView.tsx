import { useState, useEffect, useRef } from "react";
import { isValidAccentHex } from "../lib/settingsDraft";
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
  onSetAccentColor: (value: string | null) => void;
  onToggleTarget: (id: string) => void;
  onApplyProfile: (profileId: string) => void;
  onSave: () => void;
  onReset: () => void;
  accentResetKey: number;
}

export function SettingsView({
  appSettings,
  settingsMsg,
  agentTargets,
  targetProfiles,
  activeProfileId,
  settingsDirty,
  onSetAppearance,
  onSetAccentColor,
  onToggleTarget,
  onApplyProfile,
  onSave,
  onReset,
  accentResetKey,
}: SettingsViewProps) {
  const [accentDraft, setAccentDraft] = useState(appSettings?.accent_color ?? "");
  const [accentTouched, setAccentTouched] = useState(false);

  // Sync from appSettings when not actively editing an invalid value.
  // An explicit accentResetKey increment (save/reset) always resets.
  const prevResetKeyRef = useRef(accentResetKey);

  useEffect(() => {
    // Force-reset after save or reset defaults
    if (accentResetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = accentResetKey;
      setAccentTouched(false);
      setAccentDraft(appSettings?.accent_color ?? "");
      return;
    }

    if (!accentTouched) {
      setAccentDraft(appSettings?.accent_color ?? "");
    }
  }, [accentResetKey, appSettings?.accent_color, accentTouched]);

  const accentValid = accentDraft === "" || isValidAccentHex(accentDraft);
  const canSave = settingsDirty && accentValid;

  // Color picker hex: always resolve to a valid color so the native picker shows something.
  const pickerHex = (accentDraft && isValidAccentHex(accentDraft))
    ? accentDraft.toLowerCase()
    : (appSettings?.accent_color && isValidAccentHex(appSettings.accent_color))
      ? appSettings.accent_color.toLowerCase()
      : "#6ea8fe";

  const handleAccentChange = (value: string) => {
    setAccentTouched(true);
    if (value === "") {
      setAccentDraft("");
      onSetAccentColor(null);
    } else if (isValidAccentHex(value)) {
      const normalized = value.toLowerCase();
      setAccentDraft(normalized);
      onSetAccentColor(normalized);
    } else {
      setAccentDraft(value);
    }
  };

  return (
    <section className="settings-layout">
      <div className="lib-topline">
        <span className="terminal-title">SETTINGS</span>
        <span className="terminal-host">
          {settingsDirty ? "modified \u2014 save to persist" : "preferences"}
        </span>
      </div>

      {appSettings && (
        <div className="settings-body">
          {/* Appearance */}
          <div className="settings-section">
            <div className="settings-section-label">APPEARANCE</div>
            <div className="settings-section-body">
              <div className="settings-options">
                {(["dark", "light", "system"] as const).map(m => (
                  <button
                    key={m}
                    className={`btn btn-sm ${appSettings.appearance === m ? "btn-active" : ""}`}
                    aria-pressed={appSettings.appearance === m}
                    onClick={() => onSetAppearance(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>

              {/* Accent color */}
              <div className="settings-accent-row">
                <label className="settings-accent-label" htmlFor="accent-color-input">
                  Accent
                </label>
                <div className="settings-accent-input-group">
                  <input
                    type="color"
                    value={pickerHex}
                    onChange={e => handleAccentChange(e.target.value)}
                    className="settings-accent-picker"
                    aria-label="Pick accent color"
                  />
                  <input
                    id="accent-color-input"
                    className="settings-input settings-accent-input"
                    type="text"
                    placeholder="#6ea8fe"
                    value={accentDraft}
                    onChange={e => handleAccentChange(e.target.value)}
                    aria-label="Accent color hex code"
                    aria-invalid={!accentValid}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => { setAccentDraft(""); setAccentTouched(false); onSetAccentColor(null); }}
                    aria-label="Use default accent color"
                  >
                    default
                  </button>
                </div>
                {!accentValid && (
                  <div className="settings-accent-hint settings-accent-hint-invalid">
                    Enter a valid hex color (e.g. #6ea8fe)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Target Profiles */}
          {targetProfiles.length > 0 && (
            <div className="settings-section">
              <div className="settings-section-label">TARGET PROFILES</div>
              <div className="settings-section-body">
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
            </div>
          )}

          {/* Rule Targets */}
          <div className="settings-section">
            <div className="settings-section-label">RULE TARGETS</div>
            <div className="settings-section-body">
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
          </div>

          {/* Config Targets */}
          <div className="settings-section">
            <div className="settings-section-label">CONFIG TARGETS</div>
            <div className="settings-section-body">
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
          </div>

          {/* Actions */}
          <div className="settings-section settings-section-actions">
            <div className="settings-section-label">ACTIONS</div>
            <div className="settings-section-body">
              <div className="settings-actions">
                <button className="btn btn-primary" onClick={onSave} disabled={!canSave}>save</button>
                <button className="btn" onClick={onReset}>reset defaults</button>
              </div>
              <div className="settings-path-hint">
                Workspace path is managed in the Workspace tab.
              </div>
              {settingsMsg && (
                <div className={`settings-msg ${settingsMsg.ok ? "log-ok" : "log-fail"}`}>
                  <span className="log-prompt">$</span> {settingsMsg.text}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
