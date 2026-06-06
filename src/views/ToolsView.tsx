import { useCallback, useMemo, useState } from "react";
import {
  savedRepoEntriesFromSettings,
  type MutateAppSettings,
} from "../lib/useSavedRepoEntriesController";
import type { AppSettings } from "../types";
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

export interface ToolsViewProps {
  appSettings: AppSettings | null;
  mutateAppSettings: MutateAppSettings;
}

export function ToolsView({ appSettings, mutateAppSettings }: ToolsViewProps) {
  const [tab, setTab] = useState<ToolsTab>("prompt-loops");
  const [contextSeed, setContextSeed] = useState<PromptLoopContextSeed | null>(null);
  const savedRepoView = useMemo(
    () => savedRepoEntriesFromSettings(appSettings),
    [appSettings],
  );
  const { entries: savedRepos, activeEntryId, loading: savedReposLoading } = savedRepoView;
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
            savedReposLoading={savedReposLoading}
          />
        )}
        {tab === "repo-dashboard" && (
          <RepoDashboardTool
            toolsSwitcher={switcher}
            onUsePromptContext={handleUsePromptContext}
            savedEntries={savedRepos}
            activeEntryId={activeEntryId}
            mutateSavedEntries={mutateAppSettings}
          />
        )}
      </div>
    </section>
  );
}
