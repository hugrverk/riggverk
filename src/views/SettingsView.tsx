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
import { displayPath } from "../lib/displayPath";
import { HARNESS_LABELS } from "../lib/harnessInstallation";
import { useSystemReducedMotion } from "../lib/motion";
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
import type { AppSettings } from "../types";
import { INSTALL_AGENTS, type InstallAgent } from "../types";
import { Pane } from "../ui/Pane";
import { TButton } from "../ui/TButton";
import { cx } from "../ui/tone";

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
  onSetMotion: (value: AppSettings["motion"]) => void;
  onSetLandingView: (value: string) => void;
  onToggleHarness: (id: InstallAgent) => void;
  onRetrySave?: () => void;
  /** Asks for confirmation itself; the returned promise settles once the confirm (and the save) are done. */
  onReset: () => void | Promise<void>;
  colorResetKey: number;
  /** Absolute path of the active workspace, when known; the row falls back to the saved path or the default. */
  workspacePath?: string | null;
  /** A workspace reset is already running (confirm open, or reloading). */
  workspaceBusy?: boolean;
  /**
   * Back to the default workspace folder (the confirm and the reload are the caller's). Resolves with what to
   * show in the row, or null when nothing happened. The app no longer picks a folder: this only drops a
   * custom one saved by an earlier version.
   */
  onResetWorkspace?: () => Promise<SettingsMessage | null>;
}

const APPEARANCE_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
] as const satisfies ReadonlyArray<{ value: AppSettings["appearance"]; label: string }>;

const MOTION_OPTIONS = [
  { value: "full", label: "Full" },
  { value: "subtle", label: "Subtle" },
  { value: "off", label: "Off" },
] as const satisfies ReadonlyArray<{ value: AppSettings["motion"]; label: string }>;

/** `start` is the id of the Overview page; the saved landing value ids stay as they are. */
const LANDING_OPTIONS = [
  { value: "start", label: "Overview" },
  { value: "library", label: "Library" },
] as const;

/** Autosave states: a hollow ring in the state's own hue and always the word, so colour is never alone. */
type StateTone = "ok" | "busy" | "fail";

const SAVE_STATE: Record<SettingsSaveStatus, { tone: StateTone; label: string }> = {
  saved: { tone: "ok", label: "saved" },
  pending: { tone: "busy", label: "pending" },
  saving: { tone: "busy", label: "saving" },
  error: { tone: "fail", label: "error" },
};

/** A hollow ring and a word: the autosave state, a rejected hex value, the outcome of a workspace reset. */
function StateText({ tone, children }: { tone: StateTone; children: ReactNode }) {
  return (
    <span className={cx("sv", `sv-${tone}`)}>
      <span className="sv-mark" aria-hidden="true" /> {children}
    </span>
  );
}

/** `dl.srows` of label/control rows. Each row is a `div.srow > dt + dd`, so the pairs stay one description list. */
function SettingRows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl className="srows" aria-label={label}>
      {children}
    </dl>
  );
}

/** One setting: its label (which also names a control that has no name of its own) and the control. */
function SettingRow({
  labelId,
  label,
  stacked = false,
  children,
}: {
  labelId: string;
  label: string;
  /** Control under the label instead of beside it (a path, a status). */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("srow", stacked && "srow-stack")}>
      <dt className="sl">
        <span id={labelId}>{label}</span>
      </dt>
      <dd className="sc">{children}</dd>
    </div>
  );
}

/**
 * `j`/`k` rows: an element marked `data-setting-row` is one setting and its `data-setting-stop` descendant is the
 * control that takes focus (the roving tab stop of a segmented control, the hex field of a colour row); a row of
 * plain buttons (the workspace reset) lands on its first button.
 * Moves focus to the next/previous row inside the pane that holds focus.
 */
function focusSettingRow(from: Element | null, step: 1 | -1): boolean {
  const pane = from?.closest<HTMLElement>("[data-pane-id]");
  if (!pane) return false;
  const rows = Array.from(pane.querySelectorAll<HTMLElement>("[data-setting-row]"));
  const current = from?.closest<HTMLElement>("[data-setting-row]") ?? null;
  const index = current ? rows.indexOf(current) : -1;
  const next = rows[index === -1 ? (step === 1 ? 0 : rows.length - 1) : index + step];
  const stop = next?.querySelector<HTMLElement>("[data-setting-stop]") ?? next?.querySelector<HTMLElement>("button");
  if (!stop) return false;
  stop.focus();
  return true;
}

interface RadioOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Segmented control: a `role=radiogroup` of `role=radio` buttons with a roving tab stop. Tab enters on the checked
 * option (or the first one), arrow keys move and select (wrapping), Space/Enter select through the native button
 * click. The checked segment is filled, bold and ringed, so it does not rest on colour alone.
 */
function Segmented<T extends string>({
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
    <div className="seg" role="radiogroup" aria-label={label} aria-labelledby={labelledBy} data-setting-row="">
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
            className="seg-opt"
            data-setting-stop={stop ? "" : undefined}
            data-pane-primary={stop && primary ? "" : undefined}
            onClick={() => onSelect(option.value)}
            onKeyDown={event => onKeyDown(event, index)}
          >
            {option.label}
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
      <div className="setting-color" data-setting-row="">
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
          className="tbtn setting-default"
          onClick={onReset}
          aria-label={`Use default ${label.toLowerCase()} color`}
        >
          Default
        </button>
      </div>
      {invalid && (
        <div id={hintId} className="setting-hint">
          <StateText tone="fail">enter a valid hex color (e.g. {defaultPicker})</StateText>
        </div>
      )}
    </>
  );
}

const SETTINGS_PANES = ["settings-appearance", "settings-app"] as const;

export function SettingsView({
  appSettings,
  settingsMsg,
  settingsSaveStatus,
  onSetAppearance,
  onSetAppFontSize,
  onSetAccentColor,
  onSetBackgroundColor,
  onSetForegroundColor,
  onSetMotion,
  onSetLandingView,
  onToggleHarness,
  onRetrySave,
  onReset,
  colorResetKey,
  workspacePath,
  workspaceBusy = false,
  onResetWorkspace,
}: SettingsViewProps) {
  const ids = useId();
  // The OS preference beats the setting (lib/motion), so the row says when it is the one in charge.
  const systemReducesMotion = useSystemReducedMotion();
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

  // The reset asks through the confirm dialog, which puts the shell in CONFIRM mode itself.
  const runReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await onReset();
    } finally {
      setResetting(false);
    }
  }, [onReset, resetting]);

  // Workspace row: the caller owns the confirm and the reload; the row shows what came back.
  const [workspaceMsg, setWorkspaceMsg] = useState<SettingsMessage | null>(null);
  const workspaceIsDefault = !appSettings || appSettings.workspace_path == null;
  const workspaceResetState = (): true | string => {
    if (!appSettings) return "settings are still loading";
    if (workspaceBusy) return "a workspace change is running";
    if (workspaceIsDefault) return "already the default workspace";
    return true;
  };
  const runWorkspaceReset = () => {
    if (!onResetWorkspace || workspaceResetState() !== true) return;
    setWorkspaceMsg(null);
    void onResetWorkspace().then(result => {
      if (result) setWorkspaceMsg(result);
    });
  };

  // `R` works from both panes (the workspace row is in the app pane, but the appearance pane has the initial
  // focus) and is offered from both.
  const workspaceBindings: Binding[] = SETTINGS_PANES.map(paneId => ({
    id: `settings.workspace.reset.${paneId}`,
    keys: "R",
    title: "Reset the workspace to the default folder",
    hint: "reset folder",
    scope: "pane" as const,
    paneId,
    when: () => (onResetWorkspace ? workspaceResetState() : false),
    run: runWorkspaceReset,
  }));

  const bindings: Binding[] = [
    ...workspaceBindings,
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
  // Row movement is active anywhere inside the settings screen, in both panes; the rows are not a listbox, so
  // a list's generic `j k move` hint does not apply and each pane hints the keys itself.
  const rowBindings: Binding[] = SETTINGS_PANES.flatMap(paneId =>
    (["next", "prev"] as const).map((direction): Binding => ({
      id: `settings.row.${direction}.${paneId}`,
      keys: direction === "next" ? "j" : "k",
      title: direction === "next" ? "Next setting" : "Previous setting",
      hint: direction === "next" ? "next setting" : "prev setting",
      scope: "pane",
      paneId,
      repeat: true,
      when: () => !!appSettings,
      run: event => {
        const from = event.target instanceof Element ? event.target : document.activeElement;
        return focusSettingRow(from, direction === "next" ? 1 : -1) ? undefined : false;
      },
    })),
  );
  useKeymap(bindings);
  useKeymap(rowBindings, { ref: screenRef });

  if (!appSettings) {
    return (
      <section ref={screenRef} className="screen settings-screen" aria-label="Settings">
        <Pane id="settings-appearance" title="Settings" label="Loading settings" scrollable className="pane-flat">
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

  const shownWorkspacePath = displayPath(workspacePath ?? appSettings.workspace_path ?? DEFAULT_WORKSPACE_PATH);
  const resetState = workspaceResetState();

  return (
    <section ref={screenRef} className="screen settings-screen" aria-label="Settings">
      <Pane
        id="settings-appearance"
        title="Appearance"
        label="Appearance"
        className="pane-flat"
        meta={
          <>
            <span aria-hidden="true">·</span> <StateText tone={save.tone}>{saveLabel}</StateText>
          </>
        }
        defaultFocus
      >
        <SettingRows label="Appearance settings">
          <SettingRow labelId={labelId("theme")} label="Theme">
            <Segmented
              options={APPEARANCE_OPTIONS}
              value={appSettings.appearance}
              onSelect={handleSetAppearance}
              label="Theme"
              primary
            />
          </SettingRow>
          <SettingRow labelId={labelId("size")} label="Text size">
            <Segmented
              options={APP_FONT_SIZE_VALUES.map(size => ({
                value: size,
                label: APP_FONT_SIZE_LABELS[size].charAt(0).toUpperCase() + APP_FONT_SIZE_LABELS[size].slice(1),
              }))}
              value={appSettings.app_font_size}
              onSelect={onSetAppFontSize}
              label="Global app text size"
            />
          </SettingRow>
          <SettingRow labelId={labelId("motion")} label="Motion">
            <Segmented options={MOTION_OPTIONS} value={appSettings.motion} onSelect={onSetMotion} label="Motion" />
            {systemReducesMotion && (
              <div className="setting-hint c-dim">the system asks for reduced motion: motion is off until that changes</div>
            )}
          </SettingRow>
        </SettingRows>
        <h3 className="sgroup">Colours</h3>
        <SettingRows label="Colour settings">
          <SettingRow labelId={labelId("accent")} label="Accent">
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
          </SettingRow>
          <SettingRow labelId={labelId("background")} label="Background">
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
          </SettingRow>
          <SettingRow labelId={labelId("foreground")} label="Foreground">
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
          </SettingRow>
        </SettingRows>
        {contrastDetail && (
          <p className="setting-note setting-warn" role="status">
            <StateText tone="fail">{contrastDetail}</StateText>
          </p>
        )}
        <p className="setting-note c-dim">Optional hex overrides; empty uses the theme default. Changes save automatically.</p>
      </Pane>
      <Pane id="settings-app" title="App" label="App" className="pane-flat">
        <h3 className="sgroup">Startup</h3>
        <SettingRows label="Startup settings">
          <SettingRow labelId={labelId("landing")} label="Landing page">
            <Segmented
              options={LANDING_OPTIONS}
              value={appSettings.landing_view}
              onSelect={onSetLandingView}
              label="Landing page"
              primary
            />
          </SettingRow>
        </SettingRows>
        <h3 className="sgroup">Agents</h3>
        <SettingRows label="Enabled agents">
          {INSTALL_AGENTS.map(harness => {
            const enabled = appSettings.enabled_harness_ids.includes(harness);
            return (
              <SettingRow key={harness} labelId={labelId(`harness-${harness}`)} label={HARNESS_LABELS[harness]}>
                <div data-setting-row="">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-labelledby={labelId(`harness-${harness}`)}
                    className="sw"
                    onClick={() => onToggleHarness(harness)}
                    data-setting-stop=""
                  >
                    <span className="sw-track" aria-hidden="true" />
                    <span className="sw-state">{enabled ? "On" : "Off"}</span>
                  </button>
                </div>
              </SettingRow>
            );
          })}
        </SettingRows>
        <p className="setting-note c-dim">Turning an agent off hides its page and stops new writes. Files stay.</p>
        <h3 className="sgroup">Workspace</h3>
        <SettingRows label="Workspace and autosave">
          <SettingRow labelId={labelId("workspace")} label="Workspace" stacked>
            <div role="group" aria-labelledby={labelId("workspace")}>
              <div className="setting-path">{shownWorkspacePath}</div>
              <div className="setting-line" data-setting-row={onResetWorkspace ? "" : undefined}>
                <span className="c-dim">{workspaceIsDefault ? "default" : "custom folder"}</span>
                {onResetWorkspace && (
                  <TButton
                    keys={["R"]}
                    shortcut="R"
                    disabled={resetState === true ? false : resetState}
                    onClick={runWorkspaceReset}
                  >
                    reset to default
                  </TButton>
                )}
              </div>
              <div role="status" aria-label="Workspace change">
                {workspaceBusy && <span className="c-dim">resetting workspace…</span>}
                {workspaceMsg && (
                  <span className={workspaceMsg.ok ? "c-ok" : "c-fail"}>
                    <StateText tone={workspaceMsg.ok ? "ok" : "fail"}>{workspaceMsg.text}</StateText>
                  </span>
                )}
              </div>
            </div>
          </SettingRow>
          <SettingRow labelId={labelId("autosave")} label="Autosave" stacked>
            <div role="status" aria-labelledby={labelId("autosave")}>
              <StateText tone={save.tone}>{saveLabel}</StateText>
              {settingsMsg && (
                <div className={settingsMsg.ok ? "c-dim" : "c-fail"}>{settingsMsg.text}</div>
              )}
            </div>
          </SettingRow>
        </SettingRows>
        <p className="setting-note c-dim">Workspace install is on the Overview page; target profiles and sync are on the agent pages.</p>
      </Pane>
    </section>
  );
}
