import { useCallback, useState } from "react";
import { useSavedRepoEntriesController } from "../lib/useSavedRepoEntriesController";
import {
  createPromptLoopContextSeed,
  isPromptContextEligibleWorkItem,
  type PromptLoopContextSeed,
} from "../tools/promptLoops/contextHandoff";
import { PromptLoopsTool } from "../tools/promptLoops/PromptLoopsTool";
import { RepoDashboardTool } from "../tools/repoDashboard/RepoDashboardTool";
import type { RepoDashboardWorkItem } from "../types";
import { ToolsSwitcher } from "./ToolsSwitcher";

export type ToolsTab = "prompt-loops" | "repo-dashboard";

export function ToolsView() {
  const [tab, setTab] = useState<ToolsTab>("prompt-loops");
  const [contextSeed, setContextSeed] = useState<PromptLoopContextSeed | null>(null);
  const savedRepoController = useSavedRepoEntriesController();
  const { entries: savedRepos, activeEntryId, mutateEntries } = savedRepoController;
  const switcher = <ToolsSwitcher tab={tab} onTabChange={setTab} />;

  const handleUsePromptContext = useCallback(
    (payload: { item: RepoDashboardWorkItem; repoPath: string }) => {
      if (!isPromptContextEligibleWorkItem(payload.item)) return;
      setContextSeed(
        createPromptLoopContextSeed(payload.item, {
          repoPath: payload.repoPath,
          savedEntries: savedRepos,
        }),
      );
      setTab("prompt-loops");
    },
    [savedRepos],
  );

  return (
    <section className="tools-view" aria-label="Tools">
      <div className="tools-body">
        {tab === "prompt-loops" && (
          <PromptLoopsTool
            toolsSwitcher={switcher}
            contextSeed={contextSeed}
            savedRepos={savedRepos}
            savedReposLoading={savedRepoController.loading}
          />
        )}
        {tab === "repo-dashboard" && (
          <RepoDashboardTool
            toolsSwitcher={switcher}
            onUsePromptContext={handleUsePromptContext}
            savedEntries={savedRepos}
            activeEntryId={activeEntryId}
            mutateSavedEntries={mutateEntries}
          />
        )}
      </div>
    </section>
  );
}
