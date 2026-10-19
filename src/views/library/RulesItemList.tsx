import type { DocumentContent } from "../../types";
import { LibraryList } from "./LibraryList";

export const RULES_LIST_KEY = "rules:template";

interface RulesItemListProps {
  agentTemplate: DocumentContent | null;
  activeKey: string | null;
  followCursor: boolean;
  onActivate: (key: string) => void;
}

const ROWS = [{ key: RULES_LIST_KEY, name: "Global Rules" }];

export function RulesItemList({ agentTemplate, activeKey, followCursor, onActivate }: RulesItemListProps) {
  return (
    <LibraryList<(typeof ROWS)[number]>
      label="Rules"
      items={ROWS}
      getKey={row => row.key}
      getGroup={() => "source"}
      renderItem={row => (
        <>
          <span className="nm">{row.name}</span>
          <span className="meta">{agentTemplate ? "bundled" : "loading"}</span>
        </>
      )}
      activeKey={activeKey}
      followCursor={followCursor}
      onSelect={() => {}}
      onActivate={onActivate}
      activateHint="read"
    />
  );
}
