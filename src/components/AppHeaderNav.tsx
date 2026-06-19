import { ToolIcon } from "./ToolIcon";
import { dirtyTabAriaLabel, dirtyTabClass } from "../lib/editorGuards";
import { INSTALL_AGENTS, type InstallAgent } from "../types";
import { HARNESS_LABELS, HARNESS_NAV_ORDER } from "../lib/harnessInstallation";

export type AppHeaderView =
  | "start"
  | "codex"
  | "opencode"
  | "cursor"
  | "claude"
  | "library"
  | "prompts"
  | "repo-dashboard"
  | "settings";

interface AppHeaderNavProps {
  view: AppHeaderView;
  libraryDirty: boolean;
  settingsErrored: boolean;
  enabledHarnessIds?: InstallAgent[];
  onSwitchView: (view: AppHeaderView) => void;
}

function PromptLoopsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="9" y1="10" x2="15" y2="10" />
      <line x1="9" y1="14" x2="13" y2="14" />
    </svg>
  );
}

function RepoDashboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function AppHeaderNav({
  view,
  libraryDirty,
  settingsErrored,
  enabledHarnessIds = [...INSTALL_AGENTS],
  onSwitchView,
}: AppHeaderNavProps) {
  return (
    <header className="app-header">
      <div className="app-header-drag-leading" data-tauri-drag-region aria-hidden="true" />
      <nav className="nav-icons" aria-label="Main navigation" data-tauri-drag-region>
        <button
          className={`nav-icon ${view === "start" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("start")}
          aria-label="Workspace"
          title="Start"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V9.5z" />
          </svg>
        </button>
        {HARNESS_NAV_ORDER.filter(harness => enabledHarnessIds.includes(harness)).map(harness => (
          <button
            key={harness}
            className={`nav-icon ${view === harness ? "nav-icon-active" : ""}`}
            onClick={() => onSwitchView(harness)}
            aria-label={HARNESS_LABELS[harness]}
            title={HARNESS_LABELS[harness]}
          >
            <ToolIcon name={harness} />
          </button>
        ))}
        <button
          className={`nav-icon ${view === "repo-dashboard" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("repo-dashboard")}
          aria-label="Repo Dashboard"
          title="Repo Dashboard"
        >
          <RepoDashboardIcon />
        </button>
        <button
          className={`nav-icon ${view === "prompts" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("prompts")}
          aria-label="Prompt Builder"
          title="Prompt Builder"
        >
          <PromptLoopsIcon />
        </button>
        <button
          className={`nav-icon ${view === "library" ? "nav-icon-active" : ""}${dirtyTabClass(libraryDirty)}`}
          onClick={() => onSwitchView("library")}
          aria-label={dirtyTabAriaLabel(libraryDirty, "Library")}
          title="Library"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4,19.5A2.5,2.5 0 0,1 6.5,17H20" />
            <path d="M6.5,2H20v20H6.5A2.5,2.5 0 0,1 4,19.5v-15A2.5,2.5 0 0,1 6.5,2z" />
            <line x1="8" y1="7" x2="16" y2="7" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
        <button
          className={`nav-icon ${view === "settings" ? "nav-icon-active" : ""}${dirtyTabClass(settingsErrored)}`}
          onClick={() => onSwitchView("settings")}
          aria-label={dirtyTabAriaLabel(settingsErrored, "Settings")}
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </nav>
      <div className="app-header-drag-trailing" data-tauri-drag-region aria-hidden="true" />
    </header>
  );
}
