import { useMemo } from "react";
import type { DocumentContent, RulesFileSummary, RulesSurfaceId } from "../../types";
import { LibraryList } from "./LibraryList";

/** The bundled base row. */
export const RULES_LIST_KEY = "rules:template";
const FILE_PREFIX = "rules:file:";

/** List key of the row that opens the rules file of `surface`. */
export function rulesFileKey(surface: RulesSurfaceId): string {
  return `${FILE_PREFIX}${surface}`;
}

/** Short state of a rules file for its row: what it holds, or why its refinements are not editable here. */
export function rulesFileTag(file: RulesFileSummary): string {
  if (file.editable) return file.conflict === "base_block_edited" ? "base edited" : "refinements";
  if (file.reason?.includes("link")) return "link";
  if (file.conflict === "masked_by_override") return "masked";
  if (file.conflict === "peer_context_file") return "other file read";
  switch (file.layout) {
    case "absent": return "no file";
    case "legacy": return "no base block";
    default: return "malformed";
  }
}

interface RulesRow {
  key: string;
  name: string;
  meta: string;
  group: string;
  surface: RulesSurfaceId | null;
}

interface RulesItemListProps {
  agentTemplate: DocumentContent | null;
  rulesFiles: RulesFileSummary[];
  activeKey: string | null;
  followCursor: boolean;
  onSelect: (surface: RulesSurfaceId | null) => void | Promise<void>;
  onActivate: (key: string) => void;
  /** Enter hint: "edit" while the open item is an editable rules file, "read" otherwise. */
  activateHint: string;
}

/** Two groups: the bundled base (read-only) and the rules file of every enabled harness. */
export function RulesItemList({
  agentTemplate,
  rulesFiles,
  activeKey,
  followCursor,
  onSelect,
  onActivate,
  activateHint,
}: RulesItemListProps) {
  const rows = useMemo<RulesRow[]>(
    () => [
      { key: RULES_LIST_KEY, name: "Global Rules", meta: agentTemplate ? "bundled" : "loading", group: "bundled base", surface: null },
      ...rulesFiles.map((file): RulesRow => ({
        key: rulesFileKey(file.surface),
        name: file.label,
        meta: rulesFileTag(file),
        group: "your rules files",
        surface: file.surface,
      })),
    ],
    [agentTemplate, rulesFiles],
  );
  const surfaceOf = (key: string) => rows.find(row => row.key === key)?.surface ?? null;
  return (
    <LibraryList<RulesRow>
      label="Rules"
      items={rows}
      getKey={row => row.key}
      getGroup={row => row.group}
      renderItem={row => (
        <>
          <span className="nm">{row.name}</span>
          <span className={row.meta === "refinements" ? "meta c-acc" : "meta"}>{row.meta}</span>
        </>
      )}
      activeKey={activeKey}
      followCursor={followCursor}
      onSelect={key => onSelect(surfaceOf(key))}
      onActivate={onActivate}
      activateHint={activateHint}
    />
  );
}
