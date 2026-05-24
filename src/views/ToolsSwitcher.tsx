import type { ToolsTab } from "./ToolsView";

const TABS: { id: ToolsTab; label: string }[] = [
  { id: "prompt-loops", label: "Prompt Loops" },
  { id: "repo-dashboard", label: "Repo Dashboard" },
];

interface ToolsSwitcherProps {
  tab: ToolsTab;
  onTabChange: (tab: ToolsTab) => void;
}

export function ToolsSwitcher({ tab, onTabChange }: ToolsSwitcherProps) {
  return (
    <nav className="tools-switcher" aria-label="Tool">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={`tools-switcher-btn${tab === id ? " tools-switcher-btn-active" : ""}`}
          onClick={() => onTabChange(id)}
          aria-current={tab === id ? "page" : undefined}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
