import { useRef, type ReactNode } from "react";
import { focusDefaultPane } from "../keyboard/focus";
import type { InstallationState, InstallAgent } from "../types";
import { INSTALL_AGENTS } from "../types";
import { ActionKey } from "../ui/ActionKey";
import { Glyph } from "../ui/Glyph";
import { CommandLine } from "./CommandLine";
import { HelpOverlay } from "./HelpOverlay";
import { StatusBar } from "./StatusBar";
import { TopLine } from "./TopLine";
import { useShellBindings } from "./useShellBindings";
import { useViewFocus } from "./useViewFocus";
import { viewDef, visibleViews, type AppView } from "./views";

export interface AppFrameProps {
  view: AppView;
  /** Navigates through the app's single switchView path. May resolve after a confirm dialog. */
  onSwitchView: (view: AppView) => void | Promise<void>;
  libraryDirty: boolean;
  settingsErrored: boolean;
  enabledHarnessIds?: readonly InstallAgent[];
  harnessStates?: Partial<Record<InstallAgent, InstallationState | null>>;
  /** Global error message; rendered as a role=alert line under the top line. */
  error: string | null;
  onDismissError: () => void;
  /** Top-line right text. */
  topRight?: ReactNode;
  /** Status-bar right text. */
  statusRight?: ReactNode;
  /** The active view. */
  children: ReactNode;
}

/**
 * Layout of the shell: top line, error line, view area, status bar, plus the command-line and help
 * overlays and the global key layer. Must render inside `ShellProviders`.
 */
export function AppFrame({
  view,
  onSwitchView,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = INSTALL_AGENTS,
  harnessStates,
  error,
  onDismissError,
  topRight,
  statusRight,
  children,
}: AppFrameProps) {
  const viewAreaRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="app-shell">
      <TopLine
        view={view}
        libraryDirty={libraryDirty}
        settingsErrored={settingsErrored}
        enabledHarnessIds={enabledHarnessIds}
        harnessStates={harnessStates}
        onSwitchView={goTo}
        right={topRight}
      />
      {error && (
        <div className="error-line" role="alert">
          <Glyph name="fail" tone="fail" /> <span>{error}</span>{" "}
          <ActionKey keys={["esc"]} onClick={onDismissError}>
            dismiss
          </ActionKey>
        </div>
      )}
      <div className="view-area" ref={viewAreaRef}>
        {children}
      </div>
      <StatusBar viewLabel={viewDef(view).tab} right={statusRight} />
      <CommandLine />
      <HelpOverlay />
    </div>
  );
}
