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

/** Group identity: spelling, case and the spacing around the separator dot must not split a group. */
export function skillGroupKey(group: string): string {
  return group.trim().toLowerCase().replace(/\s*·\s*/g, " · ").replace(/\s+/g, " ");
}

/**
 * Puts the skills of one group next to each other, so the list shows each group heading once. Groups keep the
 * order in which they first appear, skills keep their order inside a group, and the heading uses the first
 * spelling seen.
 */
export function mergeSkillGroups(skills: readonly SkillSummary[]): { items: SkillSummary[]; groupOf: Map<string, string> } {
  const buckets = new Map<string, SkillSummary[]>();
  const heading = new Map<string, string>();
  for (const skill of skills) {
    const key = skillGroupKey(skill.group);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(skill);
    else {
      buckets.set(key, [skill]);
      heading.set(key, skill.group.trim());
    }
  }
  const items: SkillSummary[] = [];
  const groupOf = new Map<string, string>();
  for (const [key, bucket] of buckets) {
    for (const skill of bucket) {
      items.push(skill);
      groupOf.set(skill.id, heading.get(key) ?? "");
    }
  }
  return { items, groupOf };
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
  const { items, groupOf } = useMemo(() => mergeSkillGroups(filterSkills(skills, search)), [skills, search]);
  return (
    <LibraryList<SkillSummary>
      label="Skills"
      items={items}
      getKey={skill => skill.id}
      getGroup={skill => groupOf.get(skill.id)}
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
