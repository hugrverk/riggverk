import { useMemo } from "react";
import type { AgentMetadataResponse } from "../../types";
import { riskTone } from "./entry";
import { LibraryList } from "./LibraryList";

export function filterAgents(agents: AgentMetadataResponse[], search: string): AgentMetadataResponse[] {
  const q = search.toLowerCase().trim();
  if (!q) return agents;
  return agents.filter(
    (a) =>
      a.title.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q) ||
      (a.metadata?.role ?? "").toLowerCase().includes(q) ||
      (a.metadata?.targets ?? []).some((t) => t.toLowerCase().includes(q)),
  );
}

interface AgentItemListProps {
  agents: AgentMetadataResponse[];
  activeKey: string | null;
  followCursor: boolean;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

export function AgentItemList({
  agents,
  activeKey,
  followCursor,
  onSelect,
  onActivate,
  search,
  onSearchChange,
}: AgentItemListProps) {
  const items = useMemo(() => filterAgents(agents, search), [agents, search]);
  if (agents.length === 0) {
    return <p className="c-dim" role="status">No agents found</p>;
  }
  return (
    <LibraryList<AgentMetadataResponse>
      label="Runtime agents"
      items={items}
      getKey={agent => agent.id}
      renderItem={agent => {
        const risk = agent.metadata?.risk ?? "";
        const tone = riskTone(risk);
        return (
          <>
            <span className={agent.exists ? "nm" : "nm c-dim"}>{agent.title}</span>
            {!agent.exists ? (
              <span className="meta c-warn">not in ws</span>
            ) : (
              risk && <span className={tone ? `meta c-${tone}` : "meta"}>{risk}</span>
            )}
          </>
        );
      }}
      activeKey={activeKey}
      followCursor={followCursor}
      onSelect={onSelect}
      onActivate={onActivate}
      activateHint="read"
      filter={{ value: search, onChange: onSearchChange, label: "Filter agents", placeholder: "filter agents" }}
      empty="No agents match"
    />
  );
}
