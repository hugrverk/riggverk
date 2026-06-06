import { ToolIcon } from "./ToolIcon";
import { dirtyTabAriaLabel, dirtyTabClass } from "../lib/editorGuards";

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
  onSwitchView: (view: AppHeaderView) => void;
}

function PromptLoopsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="4 7 4 4 7 4" />
      <line x1="4" y1="20" x2="20" y2="20" />
      <polyline points="20 17 20 20 17 20" />
      <line x1="4" y1="4" x2="14" y2="4" />
      <line x1="20" y1="20" x2="20" y2="8" />
      <polyline points="9 9 12 12 9 15" />
      <line x1="12" y1="9" x2="12" y2="15" />
    </svg>
  );
}

function RepoDashboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

export function AppHeaderNav({
  view,
  libraryDirty,
  settingsErrored,
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
        <button
          className={`nav-icon ${view === "codex" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("codex")}
          aria-label="Codex"
          title="Codex"
        >
          <ToolIcon name="codex" />
        </button>
        <button
          className={`nav-icon ${view === "opencode" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("opencode")}
          aria-label="OpenCode"
          title="OpenCode"
        >
          <ToolIcon name="opencode" />
        </button>
        <button
          className={`nav-icon ${view === "cursor" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("cursor")}
          aria-label="Cursor"
          title="Cursor"
        >
          <ToolIcon name="cursor" />
        </button>
        <button
          className={`nav-icon ${view === "claude" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("claude")}
          aria-label="Claude"
          title="Claude"
        >
          <ToolIcon name="claude" />
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
          className={`nav-icon ${view === "prompts" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("prompts")}
          aria-label="Prompt Loops"
          title="Prompt Loops"
        >
          <PromptLoopsIcon />
        </button>
        <button
          className={`nav-icon ${view === "repo-dashboard" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("repo-dashboard")}
          aria-label="Repo Dashboard"
          title="Repo Dashboard"
        >
          <RepoDashboardIcon />
        </button>
        <button
          className={`nav-icon ${view === "settings" ? "nav-icon-active" : ""}${dirtyTabClass(settingsErrored)}`}
          onClick={() => onSwitchView("settings")}
          aria-label={dirtyTabAriaLabel(settingsErrored, "Settings")}
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="21" x2="4" y2="14" />
            <line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" />
            <line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" />
            <line x1="9" y1="8" x2="15" y2="8" />
            <line x1="17" y1="16" x2="23" y2="16" />
          </svg>
        </button>
      </nav>
      <div className="app-header-drag-trailing" data-tauri-drag-region aria-hidden="true" />
    </header>
  );
}
