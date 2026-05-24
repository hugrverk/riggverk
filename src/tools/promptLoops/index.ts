export type { PromptLoopGroup, PromptLoopGroupKey, PromptLoopItem } from "./types";
export { PROMPT_LOOP_GROUPS } from "./data";

import { PROMPT_LOOP_GROUPS } from "./data";
import type { PromptLoopGroupKey } from "./types";

export function getPromptLoopGroup(key: PromptLoopGroupKey) {
  return PROMPT_LOOP_GROUPS.find(g => g.key === key);
}

export function filterPromptLoopItems(query: string, groupKey?: PromptLoopGroupKey) {
  const q = query.trim().toLowerCase();
  const groups = groupKey
    ? PROMPT_LOOP_GROUPS.filter(g => g.key === groupKey)
    : PROMPT_LOOP_GROUPS;

  if (!q) {
    return groups.flatMap(g => g.items.map(item => ({ group: g, item })));
  }

  return groups.flatMap(group =>
    group.items
      .filter(item => {
        const haystack = [group.group, item.title, item.meta, item.prompt].join("\n").toLowerCase();
        return haystack.includes(q);
      })
      .map(item => ({ group, item })),
  );
}
