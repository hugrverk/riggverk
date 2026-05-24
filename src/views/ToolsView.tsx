import { useState } from "react";
import { PromptLoopsTool } from "../tools/promptLoops/PromptLoopsTool";
import { RepoDashboardTool } from "../tools/repoDashboard/RepoDashboardTool";
import { ToolsSwitcher } from "./ToolsSwitcher";

export type ToolsTab = "prompt-loops" | "repo-dashboard";

export function ToolsView() {
  const [tab, setTab] = useState<ToolsTab>("prompt-loops");
  const switcher = <ToolsSwitcher tab={tab} onTabChange={setTab} />;

  return (
    <section className="tools-view" aria-label="Tools">
      <div className="tools-body">
        {tab === "prompt-loops" && <PromptLoopsTool toolsSwitcher={switcher} />}
        {tab === "repo-dashboard" && <RepoDashboardTool toolsSwitcher={switcher} />}
      </div>
    </section>
  );
}
