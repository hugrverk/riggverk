import { useState } from "react";
import { PromptLoopsTool } from "../tools/promptLoops/PromptLoopsTool";

export type ToolsTab = "prompt-loops" | "repo-dashboard";

const TABS: { id: ToolsTab; label: string }[] = [
  { id: "prompt-loops", label: "Prompt Loops" },
  { id: "repo-dashboard", label: "Repo Dashboard" },
];

export function ToolsView() {
  const [tab, setTab] = useState<ToolsTab>("prompt-loops");

  return (
    <div className="tools-view">
      <header className="tools-header">
        <div className="tools-title">
          <span className="tools-title-dot" aria-hidden="true" />
          <span className="font-mono">tools</span>
        </div>
        <nav className="tools-tabs" aria-label="Tools">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`tools-tab${tab === id ? " tools-tab-active" : ""}`}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="tools-body">
        {tab === "prompt-loops" && <PromptLoopsTool />}
        {tab === "repo-dashboard" && (
          <div className="tools-placeholder panel">
            <p className="font-mono text-muted">Repo Dashboard — loading…</p>
          </div>
        )}
      </div>
    </div>
  );
}
