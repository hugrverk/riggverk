import { useState } from "react";
import { PromptLoopsTool } from "../tools/promptLoops/PromptLoopsTool";
import { RepoDashboardTool } from "../tools/repoDashboard/RepoDashboardTool";

export type ToolsTab = "prompt-loops" | "repo-dashboard";

const TABS: { id: ToolsTab; label: string }[] = [
  { id: "prompt-loops", label: "Prompt Loops" },
  { id: "repo-dashboard", label: "Repo Dashboard" },
];

export function ToolsView() {
  const [tab, setTab] = useState<ToolsTab>("prompt-loops");

  return (
    <section className="tools-view" aria-label="Tools">
      <header className="tools-header">
        <h1 className="tools-header-title">Tools</h1>
        <nav className="tools-tabs" aria-label="Tool">
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
        {tab === "repo-dashboard" && <RepoDashboardTool />}
      </div>
    </section>
  );
}
