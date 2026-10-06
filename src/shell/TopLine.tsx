import type { ReactNode } from "react";
import { dirtyTabAriaLabel } from "../lib/editorGuards";
import { installationChipLabel, installationChipTone } from "../lib/harnessInstallation";
import { INSTALL_AGENTS, type InstallAgent, type InstallationState } from "../types";
import { visibleViews, type AppView } from "./views";

export interface TopLineProps {
  view: AppView;
  libraryDirty: boolean;
  settingsErrored: boolean;
  /** Harness pages shown as tabs. Defaults to all four. */
  enabledHarnessIds?: readonly InstallAgent[];
  /** Installation state per harness, for the status dots. Unknown or unavailable shows no dot. */
  harnessStates?: Partial<Record<InstallAgent, InstallationState | null>>;
  onSwitchView: (view: AppView) => void | Promise<void>;
  /** Right-aligned status text (branch, workspace path). */
  right?: ReactNode;
}

const DOT_CLASS = { ok: "st-ok", warn: "st-warn", fail: "st-fail", muted: null } as const;

/**
 * 28px top line: numbered tabs and status. The leading 80px is reserved for the macOS traffic
 * lights (styled by `.topline`), and the bar is a window drag region. Tab numbers are positional over
 * the visible destinations, so hiding a harness renumbers the tabs after it; `:codex` etc. stay stable.
 */
export function TopLine({
  view,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = INSTALL_AGENTS,
  harnessStates,
  onSwitchView,
  right,
}: TopLineProps) {
  const tabs = visibleViews(enabledHarnessIds);
  return (
    <header className="topline" data-tauri-drag-region>
      <nav className="tabs" aria-label="Main navigation" data-tauri-drag-region>
        {tabs.map((def, index) => {
          const number = index + 1;
          const harnessState = def.harness ? harnessStates?.[def.harness] ?? null : null;
          const dotTone = harnessState ? installationChipTone(harnessState) : null;
          const dirty = (def.id === "library" && libraryDirty) || (def.id === "settings" && settingsErrored);
          const dotClass = dirty ? "st-warn" : dotTone ? DOT_CLASS[dotTone] : null;
          const stateLabel = harnessState && harnessState !== "unavailable" ? installationChipLabel(harnessState) : null;
          const label = stateLabel ? `${def.label}, ${stateLabel}` : dirtyTabAriaLabel(dirty, def.label);
          return (
            <button
              key={def.id}
              type="button"
              className="tab"
              aria-current={view === def.id ? "page" : undefined}
              aria-label={label}
              aria-keyshortcuts={number <= 9 ? String(number) : undefined}
              title={def.label}
              onClick={() => void onSwitchView(def.id)}
            >
              <b aria-hidden="true">{number}</b>
              <span className="full" aria-hidden="true">{def.tab}</span>
              <span className="short" aria-hidden="true">{def.short}</span>
              {dotClass && <span className={`st ${dotClass}`} aria-hidden="true" />}
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
