import { useState, useEffect, useRef } from "react";
import { isValidAccentHex } from "../lib/settingsDraft";
import type { AppSettings } from "../types";

interface SettingsMessage {
  ok: boolean;
  text: string;
}

interface SettingsViewProps {
  appSettings: AppSettings | null;
  settingsMsg: SettingsMessage | null;
  settingsDirty: boolean;
  onSetAppearance: (appearance: AppSettings["appearance"]) => void;
  onSetAccentColor: (value: string | null) => void;
  onSave: () => void;
  onReset: () => void;
  accentResetKey: number;
}

export function SettingsView({
  appSettings,
  settingsMsg,
  settingsDirty,
  onSetAppearance,
  onSetAccentColor,
  onSave,
  onReset,
  accentResetKey,
}: SettingsViewProps) {
  const [accentDraft, setAccentDraft] = useState(appSettings?.accent_color ?? "");
  const [accentTouched, setAccentTouched] = useState(false);

  const prevResetKeyRef = useRef(accentResetKey);

  useEffect(() => {
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

          <div className="settings-section settings-section-actions">
            <div className="settings-section-label">ACTIONS</div>
            <div className="settings-section-body">
              <div className="settings-actions">
                <button className="btn btn-primary" onClick={onSave} disabled={!canSave}>save</button>
                <button className="btn" onClick={onReset}>reset defaults</button>
              </div>
              <div className="settings-path-hint">
                Workspace path is on Start. Target profiles and sync toggles are on Codex, OpenCode, Cursor, and Misc.
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
