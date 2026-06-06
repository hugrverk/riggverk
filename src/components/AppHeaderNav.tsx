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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="1.5" />
      <circle cx="6" cy="12" r="1.5" />
      <circle cx="6" cy="18" r="1.5" />
      <line x1="6" y1="3" x2="6" y2="3" />
      <circle cx="18" cy="5" r="1.5" />
      <circle cx="18" cy="11" r="1.5" />
      <circle cx="18" cy="17" r="1.5" />
      <path d="M7.5 6 16 5" />
      <path d="M7.5 12 16 11" />
      <path d="M7.5 18 16 17" />
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
