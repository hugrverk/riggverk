import { useRef, type ReactNode } from "react";
import { focusDefaultPane } from "../keyboard/focus";
import { DEFAULT_ENABLED_HARNESS_IDS } from "../lib/harnessInstallation";
import type { InstallAgent } from "../types";
import { Glyph } from "../ui/Glyph";
import { Boot, type BootInfo } from "./Boot";
import { CommandLine } from "./CommandLine";
import { HelpOverlay } from "./HelpOverlay";
import { useShellState } from "./ShellState";
import { StatusBar } from "./StatusBar";
import { TopLine } from "./TopLine";
import { useShellBindings } from "./useShellBindings";
import { useViewFocus } from "./useViewFocus";
import { WhatsNewOverlay } from "./WhatsNewOverlay";
import { numberedTabCount, viewDef, visibleViews, type AppView } from "./views";

export interface AppFrameProps {
  view: AppView;
  /** Navigates through the app's single switchView path. May resolve after a confirm dialog. */
  onSwitchView: (view: AppView) => void | Promise<void>;
  libraryDirty: boolean;
  settingsErrored: boolean;
  enabledHarnessIds?: readonly InstallAgent[];
  /** Global error message; rendered as a role=alert line under the top line. */
  error: string | null;
  onDismissError: () => void;
  /** Top-line right text. */
  topRight?: ReactNode;
  /** Status-bar right text. */
  statusRight?: ReactNode;
  /**
   * What the launch sequence reports. Pass it once the settings are loaded, when the motion level is final;
   * without it there is no boot.
   */
  boot?: BootInfo;
  /** The active view. */
  children: ReactNode;
}

/**
 * Layout of the shell: top line, error line, view area, status bar, plus the command-line, help and
 * what's new overlays and the global key layer. Must render inside `ShellProviders`.
 */
export function AppFrame({
  view,
  onSwitchView,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = DEFAULT_ENABLED_HARNESS_IDS,
  error,
  onDismissError,
  topRight,
  statusRight,
  boot,
  children,
}: AppFrameProps) {
  const viewAreaRef = useRef<HTMLDivElement>(null);
  const { bootRun } = useShellState();
  const tabs = visibleViews(enabledHarnessIds);

  /** Switching to the view you are already on re-focuses its default pane (the view effect only fires on change). */
  const goTo = (next: AppView) => {
    const same = next === view;
    void Promise.resolve(onSwitchView(next)).then(() => {
      if (same) focusDefaultPane(viewAreaRef.current ?? document);
    });
  };

  useShellBindings({ tabs, goTo, hasError: error !== null, onDismissError });
  useViewFocus(view, viewAreaRef);

  /** The overlay never takes focus; if nothing holds it once it is gone, the view's default pane does. */
  const afterBoot = () => {
    const active = document.activeElement;
    if (!active || active === document.body) focusDefaultPane(viewAreaRef.current ?? document);
  };

  return (
    <div className="app-shell">
      <TopLine
        view={view}
        libraryDirty={libraryDirty}
        settingsErrored={settingsErrored}
        enabledHarnessIds={enabledHarnessIds}
        onSwitchView={goTo}
        right={topRight}
      />
      {error && (
        <div className="error-line" role="alert">
          <Glyph name="fail" tone="fail" />
          <span className="error-line-text">{error}</span>
          <button
            type="button"
            className="error-line-dismiss"
            aria-label="Dismiss error"
            title="Dismiss (esc)"
            onClick={onDismissError}
          >
            ×
          </button>
        </div>
      )}
      <div className="view-area" ref={viewAreaRef}>
        {children}
      </div>
      <StatusBar viewLabel={viewDef(view).tab} tabCount={numberedTabCount(tabs)} right={statusRight} />
      <CommandLine />
      <HelpOverlay />
      <WhatsNewOverlay />
      {boot && <Boot info={{ harnesses: enabledHarnessIds, ...boot }} run={bootRun} onDone={afterBoot} />}
    </div>
  );
}
