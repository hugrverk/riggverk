import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { isSettingsConflictError } from "../lib/appSettingsMutation";
import {
  APP_FONT_SIZE_LABELS,
  APP_FONT_SIZE_VALUES,
  DEFAULT_WORKSPACE_PATH,
  contrastRatio,
  hasPoorContrast,
  isValidThemeHex,
  themeAccentDefault,
  themeColorDefaults,
  type SettingsSaveStatus,
} from "../lib/settingsDraft";
import { useConfirmMode } from "../shell/ShellState";
import type { AppSettings } from "../types";
import { INSTALL_AGENTS, type InstallAgent } from "../types";
import { Glyph, type GlyphName } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import { toneClass, type Tone } from "../ui/tone";

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
  onSetReduceMotion: (value: boolean) => void;
  onSetLandingView: (value: string) => void;
  onToggleHarness: (id: InstallAgent) => void;
  onRetrySave?: () => void;
  /** Asks for confirmation itself; the returned promise settles once the confirm (and the save) are done. */
  onReset: () => void | Promise<void>;
  colorResetKey: number;
}

const APPEARANCE_OPTIONS = [
  { value: "dark", label: "dark" },
  { value: "light", label: "light" },
  { value: "system", label: "system" },
] as const satisfies ReadonlyArray<{ value: AppSettings["appearance"]; label: string }>;

const MOTION_OPTIONS = [
  { value: "full", label: "full" },
  { value: "reduced", label: "reduced" },
] as const;

const LANDING_OPTIONS = [
  { value: "start", label: "workspace" },
  { value: "repo-dashboard", label: "repo dashboard" },
  { value: "prompts", label: "prompt loops" },
  { value: "library", label: "library" },
] as const;

const SAVE_STATE: Record<SettingsSaveStatus, { glyph: GlyphName; tone: Tone; label: string }> = {
  saved: { glyph: "ok", tone: "ok", label: "saved" },
  pending: { glyph: "partial", tone: "warn", label: "pending" },
  saving: { glyph: "partial", tone: "warn", label: "saving" },
  error: { glyph: "fail", tone: "fail", label: "error" },
};

/**
 * `j`/`k` rows: an element marked `data-setting-row` is one setting and its `data-setting-stop` descendant is the
 * control that takes focus (the roving tab stop of a radio group, the hex field of a colour row).
 * Moves focus to the next/previous row inside the pane that holds focus.
 */
function focusSettingRow(from: Element | null, step: 1 | -1): boolean {
  const pane = from?.closest<HTMLElement>("[data-pane-id]");
  if (!pane) return false;
  const rows = Array.from(pane.querySelectorAll<HTMLElement>("[data-setting-row]"));
  const current = from?.closest<HTMLElement>("[data-setting-row]") ?? null;
  const index = current ? rows.indexOf(current) : -1;
  const next = rows[index === -1 ? (step === 1 ? 0 : rows.length - 1) : index + step];
  const stop = next?.querySelector<HTMLElement>("[data-setting-stop]");
  if (!stop) return false;
  stop.focus();
  return true;
}

interface RadioOption<T extends string> {
  value: T;
  label: string;
}

/**
 * `role=radiogroup` of `role=radio` buttons with a roving tab stop: Tab enters on the checked option (or the
 * first one), arrow keys move and select (wrapping), Space/Enter select through the native button click.
 */
function RadioGroup<T extends string>({
  options,
  value,
  onSelect,
  label,
  labelledBy,
  primary = false,
}: {
  options: readonly RadioOption<T>[];
  value: string;
  onSelect: (value: T) => void;
  label?: string;
  labelledBy?: string;
  /** Mark the tab stop as the pane's focus target (`data-pane-primary`). */
  primary?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex(option => option.value === value);
  const stopIndex = checkedIndex === -1 ? 0 : checkedIndex;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    let step: 1 | -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") step = 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") step = -1;
    else return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onSelect(options[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div className="setting" role="radiogroup" aria-label={label} aria-labelledby={labelledBy} data-setting-row="">
      {options.map((option, index) => {
        const checked = index === checkedIndex;
        const stop = index === stopIndex;
        return (
          <button
            key={option.value}
            ref={element => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={stop ? 0 : -1}
            className="setting-option"
            data-setting-stop={stop ? "" : undefined}
            data-pane-primary={stop && primary ? "" : undefined}
            onClick={() => onSelect(option.value)}
            onKeyDown={event => onKeyDown(event, index)}
          >
            <span className="mark" aria-hidden="true">
              {checked ? "(•)" : "( )"}
            </span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Hex override: picker (mouse), hex text field (keyboard, INSERT) and a reset-to-default button. */
function ColorField({
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
  const invalid = touched && !valid;
  const hintId = `${id}-hint`;

  useEffect(() => {
    onValidChange(valid);
  }, [valid, onValidChange]);

  const pickerHex = (draft && isValidThemeHex(draft))
    ? draft.toLowerCase()
    : (saved && isValidThemeHex(saved))
      ? saved.toLowerCase()
      : defaultPicker;

  const handleChange = (value: string) => {
    onDraftChange(value !== "" && isValidThemeHex(value) ? value.toLowerCase() : value);
  };

  return (
    <>
      <div className="setting setting-color" data-setting-row="">
        <input
          type="color"
          value={pickerHex}
          onChange={event => handleChange(event.target.value)}
          className="setting-picker"
          aria-label={`Pick ${label.toLowerCase()} color`}
          tabIndex={-1}
        />
        <input
          id={`${id}-input`}
          className="settings-input setting-hex"
          type="text"
          placeholder={defaultPicker}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={event => handleChange(event.target.value)}
          aria-label={`${label} hex code`}
          aria-invalid={invalid}
          aria-describedby={invalid ? hintId : undefined}
          data-setting-stop=""
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
      {invalid && (
        <div id={hintId} className="setting-hint c-fail">
          <Glyph name="conflict" tone="fail" /> enter a valid hex color (e.g. {defaultPicker})
        </div>
      )}
    </>
  );
}

const NAV_HINTS: ReactNode = (
  <>
    <span>
      <kbd>j</kbd> <kbd>k</kbd> setting
    </span>
    <span>
      <kbd>←</kbd> <kbd>→</kbd> option
    </span>
  </>
);

export function SettingsView({
  appSettings,
  settingsMsg,
  settingsSaveStatus,
  onSetAppearance,
  onSetAppFontSize,
  onSetAccentColor,
  onSetBackgroundColor,
  onSetForegroundColor,
  onSetReduceMotion,
  onSetLandingView,
  onToggleHarness,
  onRetrySave,
  onReset,
  colorResetKey,
}: SettingsViewProps) {
  const ids = useId();
  const screenRef = useRef<HTMLElement>(null);
  const labelId = (key: string) => `${ids}-${key}`;
  const [accentDraft, setAccentDraft] = useState(appSettings?.accent_color ?? "");
  const [backgroundDraft, setBackgroundDraft] = useState(appSettings?.background_color ?? "");
  const [foregroundDraft, setForegroundDraft] = useState(appSettings?.foreground_color ?? "");
  const [accentTouched, setAccentTouched] = useState(false);
  const [backgroundTouched, setBackgroundTouched] = useState(false);
  const [foregroundTouched, setForegroundTouched] = useState(false);
  const [accentValid, setAccentValid] = useState(true);
  const [backgroundValid, setBackgroundValid] = useState(true);
  const [foregroundValid, setForegroundValid] = useState(true);
  const [resetting, setResetting] = useState(false);

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

  // The reset asks through the confirm dialog; the status bar shows CONFIRM while that is open.
  useConfirmMode(resetting);
  const runReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await onReset();
    } finally {
      setResetting(false);
    }
  }, [onReset, resetting]);

  const bindings: Binding[] = [
    {
      id: "settings.reset",
      keys: "r",
      title: "Reset appearance to defaults",
      hint: "reset appearance",
      scope: "pane",
      paneId: "settings-appearance",
      when: () => !!appSettings,
      run: () => void runReset(),
    },
    {
      id: "settings.retry",
      keys: "s",
      title: "Retry saving settings",
      hint: "retry save",
      scope: "pane",
      paneId: "settings-app",
      when: () => (showRetry ? (colorsValid ? true : "fix the invalid colors first") : false),
      run: () => {
        if (!showRetry || !colorsValid) return false;
        onRetrySave?.();
      },
    },
  ];
  // Row movement is active anywhere inside the settings screen, in both panes.
  const rowBindings: Binding[] = (["next", "prev"] as const).map(direction => ({
    id: `settings.row.${direction}`,
    keys: direction === "next" ? "j" : "k",
    title: direction === "next" ? "Next setting" : "Previous setting",
    scope: "pane",
    repeat: true,
    run: event => {
      const from = event.target instanceof Element ? event.target : document.activeElement;
      return focusSettingRow(from, direction === "next" ? 1 : -1) ? undefined : false;
    },
  }));
  useKeymap(bindings);
  useKeymap(rowBindings, { ref: screenRef });

  if (!appSettings) {
    return (
      <section ref={screenRef} className="screen settings-screen" aria-label="Settings">
        <Pane id="settings-appearance" index={1} title="settings" label="Loading settings" scrollable>
          <p className="c-dim setting-note">loading…</p>
        </Pane>
      </section>
    );
  }

  const handleSetAppearance = (mode: AppSettings["appearance"]) => {
    setBackgroundTouched(false);
    setForegroundTouched(false);
    setBackgroundDraft("");
    setForegroundDraft("");
    onSetAppearance(mode);
  };

  const appearanceDefaults = themeColorDefaults(appSettings.appearance);

  const contrastWarning = hasPoorContrast(
    appSettings.foreground_color ?? (isValidThemeHex(foregroundDraft) ? foregroundDraft : null),
    appSettings.background_color ?? (isValidThemeHex(backgroundDraft) ? backgroundDraft : null),
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

  const save = SAVE_STATE[settingsSaveStatus];
  const conflict = settingsSaveStatus === "error" && !!settingsMsg && isSettingsConflictError(settingsMsg.text);
  const saveLabel = conflict ? "conflict" : save.label;

  const label = (key: string, text: string) => ({ id: key, label: <span id={labelId(key)}>{text}</span> });

  const appearanceItems: KvItem[] = [
    {
      ...label("theme", "theme"),
      value: (
        <RadioGroup
          options={APPEARANCE_OPTIONS}
          value={appSettings.appearance}
          onSelect={handleSetAppearance}
          label="Theme"
          primary
        />
      ),
    },
    {
      ...label("size", "text size"),
      value: (
        <RadioGroup
          options={APP_FONT_SIZE_VALUES.map(size => ({ value: size, label: APP_FONT_SIZE_LABELS[size] }))}
          value={appSettings.app_font_size}
          onSelect={onSetAppFontSize}
          label="Global app text size"
        />
      ),
    },
    {
      ...label("motion", "motion"),
      value: (
        <RadioGroup
          options={MOTION_OPTIONS}
          value={appSettings.reduce_motion ? "reduced" : "full"}
          onSelect={mode => onSetReduceMotion(mode === "reduced")}
          label="Reduce motion"
        />
      ),
    },
    {
      ...label("accent", "accent"),
      value: (
        <ColorField
          id="accent"
          label="Accent"
          draft={accentDraft}
          saved={appSettings.accent_color}
          defaultPicker={themeAccentDefault(appSettings.appearance)}
          touched={accentTouched}
          onDraftChange={applyAccent}
          onReset={() => {
            setAccentTouched(false);
            applyAccent("");
          }}
          onValidChange={setAccentValid}
        />
      ),
    },
    {
      ...label("background", "background"),
      value: (
        <ColorField
          id="background"
          label="Background"
          draft={backgroundDraft}
          saved={appSettings.background_color}
          defaultPicker={appearanceDefaults.background}
          touched={backgroundTouched}
          onDraftChange={applyBackground}
          onReset={() => {
            setBackgroundTouched(false);
            applyBackground("");
          }}
          onValidChange={setBackgroundValid}
        />
      ),
    },
    {
      ...label("foreground", "foreground"),
      value: (
        <ColorField
          id="foreground"
          label="Foreground"
          draft={foregroundDraft}
          saved={appSettings.foreground_color}
          defaultPicker={appearanceDefaults.foreground}
          touched={foregroundTouched}
          onDraftChange={applyForeground}
          onReset={() => {
            setForegroundTouched(false);
            applyForeground("");
          }}
          onValidChange={setForegroundValid}
        />
      ),
    },
  ];

  const harnessItems: KvItem[] = INSTALL_AGENTS.map(harness => {
    const enabled = appSettings.enabled_harness_ids.includes(harness);
    return {
      ...label(`harness-${harness}`, harness),
      value: (
        <div className="setting" data-setting-row="">
          <button
            type="button"
            role="checkbox"
            aria-checked={enabled}
            aria-labelledby={labelId(`harness-${harness}`)}
            className="setting-option"
            onClick={() => onToggleHarness(harness)}
            data-setting-stop=""
          >
            <span className="mark" aria-hidden="true">
              {enabled ? "[x]" : "[ ]"}
            </span>
            <span>{enabled ? "enabled" : "disabled"}</span>
          </button>
        </div>
      ),
    };
  });

  const appItems: KvItem[] = [
    {
      ...label("workspace", "workspace"),
      wrap: true,
      value: <span className="setting-path">{appSettings.workspace_path ?? DEFAULT_WORKSPACE_PATH}</span>,
    },
    {
      ...label("autosave", "autosave"),
      wrap: true,
      value: (
        <div role="status" aria-labelledby={labelId("autosave")}>
          <span className={toneClass(save.tone)}>
            <Glyph name={save.glyph} tone={save.tone} /> {saveLabel}
          </span>
          {settingsMsg && (
            <div className={settingsMsg.ok ? "c-dim" : "c-fail"}>{settingsMsg.text}</div>
          )}
        </div>
      ),
    },
  ];

  return (
    <section ref={screenRef} className="screen settings-screen" aria-label="Settings">
      <Pane
        id="settings-appearance"
        index={1}
        title="appearance"
        label="Appearance"
        meta={
          <span className={toneClass(save.tone)}>
            · <Glyph name={save.glyph} tone={save.tone} /> {saveLabel}
          </span>
        }
        defaultFocus
        footer={NAV_HINTS}
      >
        <Kv className="settings-kv" items={appearanceItems} aria-label="Appearance settings" />
        {contrastDetail && (
          <p className="setting-note c-warn" role="status">
            <Glyph name="conflict" tone="warn" /> {contrastDetail}
          </p>
        )}
        <p className="setting-note c-dim">Optional hex overrides; empty uses the theme default. Changes save automatically.</p>
      </Pane>
      <Pane id="settings-app" index={2} title="app" label="App" footer={NAV_HINTS}>
        <Kv
          className="settings-kv"
          items={[
            {
              ...label("landing", "landing page"),
              value: (
                <RadioGroup
                  options={LANDING_OPTIONS}
                  value={appSettings.landing_view}
                  onSelect={onSetLandingView}
                  label="Landing page"
                  primary
                />
              ),
            },
          ]}
          aria-label="Startup settings"
        />
        <h3 className="group setting-group">harnesses</h3>
        <Kv className="settings-kv" items={harnessItems} aria-label="Enabled harnesses" />
        <p className="setting-note c-dim">
          Disabling a harness hides its page and blocks new managed writes. Existing files stay on disk.
        </p>
        <Kv className="settings-kv setting-status" items={appItems} aria-label="Workspace and autosave" />
        <p className="setting-note c-dim">Workspace install is on the workspace page; target profiles and sync are on the harness pages.</p>
      </Pane>
    </section>
  );
}
