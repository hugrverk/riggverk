import type { ReactNode } from "react";
import { dirtyTabAriaLabel } from "../lib/editorGuards";
import { INSTALL_AGENTS, type InstallAgent } from "../types";
import { visibleViews, type AppView } from "./views";

export interface TopLineProps {
  view: AppView;
  libraryDirty: boolean;
  settingsErrored: boolean;
  /** Harness pages shown as tabs. Defaults to all four. */
  enabledHarnessIds?: readonly InstallAgent[];
  onSwitchView: (view: AppView) => void | Promise<void>;
  /** Right-aligned status text (branch, workspace path). */
  right?: ReactNode;
}

/**
 * 28px top line: numbered tabs and status. The leading 80px is reserved for the macOS traffic
 * lights (styled by `.topline`), and the bar is a window drag region. Tab numbers are positional over
 * the visible destinations, so hiding a harness renumbers the tabs after it; `:codex` etc. stay stable.
 * The only tab marker is a warning dot on Library (unsaved edits) and Settings (failed autosave); harness
 * installation state is not shown here, the workspace page lists it.
 */
export function TopLine({
  view,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = INSTALL_AGENTS,
  onSwitchView,
  right,
}: TopLineProps) {
  const tabs = visibleViews(enabledHarnessIds);
  return (
    <header className="topline" data-tauri-drag-region>
      <nav className="tabs" aria-label="Main navigation" data-tauri-drag-region>
        {tabs.map((def, index) => {
          const number = index + 1;
          const dirty = (def.id === "library" && libraryDirty) || (def.id === "settings" && settingsErrored);
          return (
            <button
              key={def.id}
              type="button"
              className="tab"
              aria-current={view === def.id ? "page" : undefined}
              aria-label={dirtyTabAriaLabel(dirty, def.label)}
              aria-keyshortcuts={number <= 9 ? String(number) : undefined}
              title={def.label}
              onClick={() => void onSwitchView(def.id)}
            >
              <b aria-hidden="true">{number}</b>
              <span className="full" aria-hidden="true">{def.tab}</span>
              <span className="short" aria-hidden="true">{def.short}</span>
              {dirty && <span className="st st-warn" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>
      <span className="right" data-tauri-drag-region>
        {right}
      </span>
    </header>
  );
}
