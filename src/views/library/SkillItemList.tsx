import { useMemo } from "react";
import { PACK_STATE_LABEL } from "../../lib/packSkills";
import type { SkillSummary } from "../../types";
import { riskTone } from "./entry";
import { LibraryList } from "./LibraryList";

export function filterSkills(skills: SkillSummary[], search: string): SkillSummary[] {
  const q = search.toLowerCase().trim();
  if (!q) return skills;
  return skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.targets.some((t) => t.toLowerCase().includes(q)) ||
      s.related.some((r) => r.toLowerCase().includes(q)),
  );
}

interface SkillItemListProps {
  skills: SkillSummary[];
  activeKey: string | null;
  followCursor: boolean;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

export function SkillItemList({
  skills,
  activeKey,
  followCursor,
  onSelect,
  onActivate,
  search,
  onSearchChange,
}: SkillItemListProps) {
  const items = useMemo(() => filterSkills(skills, search), [skills, search]);
  return (
    <LibraryList<SkillSummary>
      label="Skills"
      items={items}
      getKey={skill => skill.id}
      getGroup={skill => skill.group}
      renderItem={skill => {
        const tone = riskTone(skill.risk);
        return (
          <>
            <span className="nm">{skill.name}</span>
            {skill.risk && <span className={tone ? `meta c-${tone}` : "meta"}>{skill.risk}</span>}
            {skill.packState && skill.packState !== "active" && (
              <span className="meta c-warn">{PACK_STATE_LABEL[skill.packState]}</span>
            )}
          </>
        );
      }}
      activeKey={activeKey}
      followCursor={followCursor}
      onSelect={onSelect}
      onActivate={onActivate}
      activateHint="read"
      filter={{ value: search, onChange: onSearchChange, label: "Search skills", placeholder: "search skills" }}
      empty="No skills match"
    />
  );
}
