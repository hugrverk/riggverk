import { useRef, type ReactNode } from "react";
import { focusDefaultPane } from "../keyboard/focus";
import { DEFAULT_ENABLED_HARNESS_IDS } from "../lib/harnessInstallation";
import type { InstallAgent } from "../types";
import { Glyph } from "../ui/Glyph";
import { CommandLine } from "./CommandLine";
import { HelpOverlay } from "./HelpOverlay";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";
import { TopBar } from "./TopBar";
import { useShellBindings } from "./useShellBindings";
import { useViewFocus } from "./useViewFocus";
import { WhatsNewOverlay } from "./WhatsNewOverlay";
import { viewDef, visibleViews, type AppView } from "./views";

export interface AppFrameProps {
  view: AppView;
  /** Navigates through the app's single switchView path. May resolve after a confirm dialog. */
  onSwitchView: (view: AppView) => void | Promise<void>;
  libraryDirty: boolean;
  settingsErrored: boolean;
  enabledHarnessIds?: readonly InstallAgent[];
  /** Global error message; rendered as a role=alert line under the top bar. */
  error: string | null;
  onDismissError: () => void;
  /** Top bar Check: re-checks every agent. */
  onCheck?: () => void;
  /** Top bar Update all: opens the install review of everything enabled. */
  onUpdateAll?: () => void;
  /** Why Update all cannot run right now (tooltip and description), or false. */
  updateAllDisabled?: string | false;
  /** A check is running. */
  checking?: boolean;
  /** Items waiting for a decision per agent; the sidebar badges. */
  decideCounts?: Partial<Record<InstallAgent, number>>;
  /** App version for the sidebar's brand row. */
  version?: string;
  /** Backups on disk, for the sidebar foot; null or omitted while unknown. */
  backupCount?: number | null;
  /** When the installation status was last fetched, for the sidebar foot. */
  checkedAt?: Date | null;
  /** The active view. */
  children: ReactNode;
}

/**
 * Layout of the shell: sidebar on the left; top bar, error line and view area on the right; the toast, the
 * command-line, help and what's new overlays, and the global key layer. Must render inside `ShellProviders`.
 */
export function AppFrame({
  view,
  onSwitchView,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = DEFAULT_ENABLED_HARNESS_IDS,
  error,
  onDismissError,
  onCheck = () => {},
  onUpdateAll = () => {},
  updateAllDisabled = false,
  checking = false,
  decideCounts,
  version,
  backupCount,
  checkedAt,
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
      <Sidebar
        view={view}
        libraryDirty={libraryDirty}
        settingsErrored={settingsErrored}
        enabledHarnessIds={enabledHarnessIds}
        decideCounts={decideCounts}
        version={version}
        backupCount={backupCount}
        checkedAt={checkedAt}
        onSwitchView={goTo}
      />
      <div className="main">
        <TopBar
          viewLabel={viewDef(view).label}
          onCheck={onCheck}
          onUpdateAll={onUpdateAll}
          updateAllDisabled={updateAllDisabled}
          checking={checking}
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
      </div>
      <Toast />
      <CommandLine />
      <HelpOverlay />
      <WhatsNewOverlay />
    </div>
  );
}
