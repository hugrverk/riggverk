import { useState, useEffect, useRef } from "react";
import { TargetPageHeader } from "../components/TargetPageHeader";
import { HarnessActionCard } from "../components/HarnessActionCard";
import {
  contrastRatio,
  hasPoorContrast,
  isValidThemeHex,
  themeColorDefaults,
  type SettingsSaveStatus,
} from "../lib/settingsDraft";
import type { AppSettings } from "../types";

interface SettingsMessage {
  ok: boolean;
  text: string;
}

interface SettingsViewProps {
  appSettings: AppSettings | null;
  settingsMsg: SettingsMessage | null;
  settingsSaveStatus: SettingsSaveStatus;
  onSetAppearance: (appearance: AppSettings["appearance"]) => void;
  onSetAppFontSize: (fontSize: AppSettings["app_font_size"]) => void;
  onSetAccentColor: (value: string | null) => void;
  onSetBackgroundColor: (value: string | null) => void;
  onSetForegroundColor: (value: string | null) => void;
  onRetrySave?: () => void;
  onReset: () => void;
  colorResetKey: number;
}

function ColorControl({
  id,
  label,
  draft,
  saved,
  defaultPicker,
  touched,
  onDraftChange,
  onReset,
  onValidChange,
}: {
  id: string;
  label: string;
  draft: string;
  saved: string | null | undefined;
  defaultPicker: string;
  touched: boolean;
  onDraftChange: (value: string) => void;
  onReset: () => void;
  onValidChange: (valid: boolean) => void;
}) {
  const valid = draft === "" || isValidThemeHex(draft);

  useEffect(() => {
    onValidChange(valid);
  }, [valid, onValidChange]);

  const pickerHex = (draft && isValidThemeHex(draft))
    ? draft.toLowerCase()
    : (saved && isValidThemeHex(saved))
      ? saved.toLowerCase()
      : defaultPicker;

  const handleChange = (value: string) => {
    if (value === "") {
      onDraftChange("");
    } else if (isValidThemeHex(value)) {
      onDraftChange(value.toLowerCase());
    } else {
      onDraftChange(value);
    }
  };

  const swatchStyle = isValidThemeHex(pickerHex)
    ? { backgroundColor: pickerHex }
    : undefined;

  return (
    <div className="settings-color-row">
      <label className="settings-color-label" htmlFor={`${id}-input`}>
        {label}
      </label>
      <div className="settings-color-input-group">
        <span
          className="settings-color-swatch"
          style={swatchStyle}
          aria-hidden="true"
        />
        <input
          type="color"
          value={pickerHex}
          onChange={e => handleChange(e.target.value)}
          className="settings-accent-picker"
          aria-label={`Pick ${label.toLowerCase()} color`}
        />
        <input
          id={`${id}-input`}
          className="settings-input settings-accent-input"
          type="text"
          placeholder={defaultPicker}
          value={draft}
          onChange={e => handleChange(e.target.value)}
          aria-label={`${label} hex code`}
          aria-invalid={touched && !valid}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={onReset}
          aria-label={`Use default ${label.toLowerCase()} color`}
        >
          default
        </button>
      </div>
      {touched && !valid && (
        <div className="settings-accent-hint settings-accent-hint-invalid">
          Enter a valid hex color (e.g. {defaultPicker})
        </div>
      )}
    </div>
  );
}

function headerFactsForStatus(status: SettingsSaveStatus): { label: string; tone: "ok" | "warn" | "fail" }[] {
  switch (status) {
    case "error":
      return [{ label: "error", tone: "fail" }];
    case "saving":
      return [{ label: "saving", tone: "warn" }];
    case "pending":
      return [{ label: "saving", tone: "warn" }];
    default:
      return [{ label: "saved", tone: "ok" }];
  }
}

export function SettingsView({
  appSettings,
  settingsMsg,
  settingsSaveStatus,
  onSetAppearance,
  onSetAppFontSize,
  onSetAccentColor,
  onSetBackgroundColor,
  onSetForegroundColor,
  onRetrySave,
  onReset,
  colorResetKey,
}: SettingsViewProps) {
  const [accentDraft, setAccentDraft] = useState(appSettings?.accent_color ?? "");
  const [backgroundDraft, setBackgroundDraft] = useState(appSettings?.background_color ?? "");
  const [foregroundDraft, setForegroundDraft] = useState(appSettings?.foreground_color ?? "");
  const [accentTouched, setAccentTouched] = useState(false);
  const [backgroundTouched, setBackgroundTouched] = useState(false);
  const [foregroundTouched, setForegroundTouched] = useState(false);
  const [accentValid, setAccentValid] = useState(true);
  const [backgroundValid, setBackgroundValid] = useState(true);
  const [foregroundValid, setForegroundValid] = useState(true);

  const prevResetKeyRef = useRef(colorResetKey);

  useEffect(() => {
    if (colorResetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = colorResetKey;
      setAccentTouched(false);
      setBackgroundTouched(false);
      setForegroundTouched(false);
      setAccentDraft(appSettings?.accent_color ?? "");
      setBackgroundDraft(appSettings?.background_color ?? "");
      setForegroundDraft(appSettings?.foreground_color ?? "");
      return;
    }

    if (!accentTouched) setAccentDraft(appSettings?.accent_color ?? "");
    if (!backgroundTouched) setBackgroundDraft(appSettings?.background_color ?? "");
    if (!foregroundTouched) setForegroundDraft(appSettings?.foreground_color ?? "");
  }, [
    colorResetKey,
    appSettings?.accent_color,
    appSettings?.background_color,
    appSettings?.foreground_color,
    accentTouched,
    backgroundTouched,
    foregroundTouched,
  ]);

  const colorsValid = accentValid && backgroundValid && foregroundValid;
  const showRetry = settingsSaveStatus === "error" && !!onRetrySave;

  const handleSetAppearance = (mode: AppSettings["appearance"]) => {
    setBackgroundTouched(false);
    setForegroundTouched(false);
    setBackgroundDraft("");
    setForegroundDraft("");
    onSetAppearance(mode);
  };

  const appearanceDefaults = appSettings
    ? themeColorDefaults(appSettings.appearance)
    : themeColorDefaults("dark");

  const contrastWarning = hasPoorContrast(
    appSettings?.foreground_color ?? (isValidThemeHex(foregroundDraft) ? foregroundDraft : null),
    appSettings?.background_color ?? (isValidThemeHex(backgroundDraft) ? backgroundDraft : null),
  );

  const contrastDetail = contrastWarning && isValidThemeHex(foregroundDraft) && isValidThemeHex(backgroundDraft)
    ? `Contrast ratio ${contrastRatio(foregroundDraft, backgroundDraft).toFixed(1)}:1 is below 4.5:1.`
    : contrastWarning
      ? "Custom foreground and background may be hard to read."
      : null;

  const applyAccent = (value: string) => {
    setAccentTouched(true);
    setAccentDraft(value);
    if (value === "" || isValidThemeHex(value)) {
      onSetAccentColor(value === "" ? null : value);
    }
  };

  const applyBackground = (value: string) => {
    setBackgroundTouched(true);
    setBackgroundDraft(value);
    if (value === "" || isValidThemeHex(value)) {
      onSetBackgroundColor(value === "" ? null : value);
    }
  };

  const applyForeground = (value: string) => {
    setForegroundTouched(true);
    setForegroundDraft(value);
    if (value === "" || isValidThemeHex(value)) {
      onSetForegroundColor(value === "" ? null : value);
    }
  };

  const actionsDescription = showRetry
    ? "Autosave failed. Retry or reset defaults."
    : "Changes save automatically. Reset restores defaults.";

  return (
    <section className="settings-layout" aria-label="Settings">
      <div className="settings-body">
        <TargetPageHeader
          title="Settings"
          summary="Appearance and theme colors. Workspace install and target toggles live on Start and harness pages."
          facts={headerFactsForStatus(settingsSaveStatus)}
        />

        {appSettings && (
          <div className="settings-cards">
              <HarnessActionCard
                title="Appearance"
                ariaLabel="Appearance mode"
                description="Light, dark, or follow system."
              >
                <div className="settings-options">
                  {(["dark", "light", "system"] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      className={`btn btn-sm ${appSettings.appearance === m ? "btn-active" : ""}`}
                      aria-pressed={appSettings.appearance === m}
                      onClick={() => handleSetAppearance(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </HarnessActionCard>

              <HarnessActionCard
                title="Text size"
                ariaLabel="Global app text size"
                description="Applies across the app and saves automatically."
              >
                <div className="settings-options" role="group" aria-label="Global app text size">
                  {(["small", "medium", "large"] as const).map(size => (
                    <button
                      key={size}
                      type="button"
                      className={`btn btn-sm ${appSettings.app_font_size === size ? "btn-active" : ""}`}
                      aria-pressed={appSettings.app_font_size === size}
                      onClick={() => onSetAppFontSize(size)}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </HarnessActionCard>

              <HarnessActionCard
                title="Colors"
                ariaLabel="Theme colors"
                description="Optional accent, background, and foreground overrides."
                warning={contrastDetail ?? undefined}
              >
                <ColorControl
                  id="accent"
                  label="Accent"
                  draft={accentDraft}
                  saved={appSettings.accent_color}
                  defaultPicker="#6ea8fe"
                  touched={accentTouched}
                  onDraftChange={applyAccent}
                  onReset={() => { setAccentTouched(false); applyAccent(""); }}
                  onValidChange={setAccentValid}
                />
                <ColorControl
                  id="background"
                  label="Background"
                  draft={backgroundDraft}
                  saved={appSettings.background_color}
                  defaultPicker={appearanceDefaults.background}
                  touched={backgroundTouched}
                  onDraftChange={applyBackground}
                  onReset={() => { setBackgroundTouched(false); applyBackground(""); }}
                  onValidChange={setBackgroundValid}
                />
                <ColorControl
                  id="foreground"
                  label="Foreground"
                  draft={foregroundDraft}
                  saved={appSettings.foreground_color}
                  defaultPicker={appearanceDefaults.foreground}
                  touched={foregroundTouched}
                  onDraftChange={applyForeground}
                  onReset={() => { setForegroundTouched(false); applyForeground(""); }}
                  onValidChange={setForegroundValid}
                />
              </HarnessActionCard>

              <HarnessActionCard
                title="Actions"
                ariaLabel="Settings actions"
                description={actionsDescription}
                statusChip={settingsSaveStatus === "error"
                  ? { label: "error", tone: "fail" }
                  : settingsSaveStatus === "saving" || settingsSaveStatus === "pending"
                    ? { label: "saving", tone: "warn" }
                    : { label: "saved", tone: "ok" }}
                secondaryActions={[
                  { label: "reset defaults", onClick: onReset },
                ]}
                primaryAction={showRetry
                  ? {
                      label: "retry save",
                      onClick: onRetrySave!,
                      disabled: !colorsValid,
                      title: !colorsValid ? "Fix invalid colors first" : undefined,
                    }
                  : undefined}
              >
                {settingsMsg && !settingsMsg.ok && (
                  <div className={`settings-msg ${settingsMsg.ok ? "log-ok" : "log-fail"}`} role="status">
                    <span className="log-prompt">$</span> {settingsMsg.text}
                  </div>
                )}
                <p className="settings-path-hint">
                  Workspace install is on Start. Target profiles and sync toggles are on Codex, OpenCode, Cursor, Claude, and Augment.
                </p>
              </HarnessActionCard>
          </div>
        )}
      </div>
    </section>
  );
}
