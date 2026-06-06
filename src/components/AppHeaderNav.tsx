import { ToolIcon } from "./ToolIcon";
import { dirtyTabAriaLabel, dirtyTabClass } from "../lib/editorGuards";

type AppView =
  | "start"
  | "codex"
  | "opencode"
  | "cursor"
  | "claude"
  | "library"
  | "tools"
  | "settings";

interface AppHeaderNavProps {
  view: AppView;
  libraryDirty: boolean;
  settingsErrored: boolean;
  onSwitchView: (view: AppView) => void;
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
          className={`nav-icon ${view === "tools" ? "nav-icon-active" : ""}`}
          onClick={() => onSwitchView("tools")}
          aria-label="Tools"
          title="Tools"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
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
