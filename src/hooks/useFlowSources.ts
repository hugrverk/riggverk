import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FlowSourceData } from "../lib/flowModel";
import type { AgentMetadataListResponse, PackLibrary, RulesFileSummary, SkillSummary } from "../types";

const NONE: FlowSourceData = { bundledSkills: null, bundledAgents: null, rulesFiles: null, packs: null };

function isPackLibrary(value: unknown): value is PackLibrary {
  const library = value as PackLibrary | null;
  return !!library && typeof library === "object" && Array.isArray(library.packs) && Array.isArray(library.skills);
}

function isRulesFiles(value: unknown): value is RulesFileSummary[] {
  return Array.isArray(value) && value.every(file => !!file && typeof file === "object" && typeof file.refinement_lines === "number");
}

function hasAgents(value: unknown): value is AgentMetadataListResponse {
  return !!value && typeof value === "object" && Array.isArray((value as AgentMetadataListResponse).agents);
}

async function settled<T>(read: () => Promise<unknown>, accept: (value: unknown) => value is T): Promise<T | null> {
  try {
    const value = await read();
    return accept(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What the Overview's flow map counts, from the read commands the Library already uses: the bundled skills and agents
 * (`list_skills`, `list_agent_metadata`), the rules files with their refinement lines (`list_rules_files`) and the skill
 * packs (`list_pack_skills`). Each part fails on its own into null, and the map leaves out a count it does not have.
 * Read when `enabled` turns on and whenever `refreshKey` changes (the same key the last update uses) or the enabled
 * agents and targets change (`scopeKey`); the last answer stays while the next one loads.
 */
export function useFlowSources({ enabled, refreshKey, scopeKey }: { enabled: boolean; refreshKey: string | number; scopeKey: string }): FlowSourceData {
  const [data, setData] = useState<FlowSourceData>(NONE);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!enabled) {
      setData(NONE);
      return;
    }
    void Promise.all([
      settled(() => invoke<SkillSummary[]>("list_skills"), (value): value is SkillSummary[] => Array.isArray(value)),
      settled(() => invoke<AgentMetadataListResponse>("list_agent_metadata"), hasAgents),
      settled(() => invoke<RulesFileSummary[]>("list_rules_files"), isRulesFiles),
      settled(() => invoke<PackLibrary>("list_pack_skills"), isPackLibrary),
    ]).then(([skills, agents, rulesFiles, packs]) => {
      if (generation !== generationRef.current) return;
      setData({
        bundledSkills: skills ? skills.length : null,
        bundledAgents: agents ? agents.agents.filter(agent => agent.exists).length : null,
        rulesFiles,
        packs,
      });
    });
  }, [enabled, refreshKey, scopeKey]);

  return data;
}
