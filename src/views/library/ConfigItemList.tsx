import { useMemo } from "react";
import type { AgentTargetMeta, ConfigEditorSourceMeta } from "../../types";
import { LibraryList } from "./LibraryList";

const TARGET_PREFIX = "target:";
const SOURCE_PREFIX = "source:";

/**
 * List key of the row that opens the active config: a source row when the target has editor sources
 * (opencode_config), the target row otherwise.
 */
export function configListKey(targetId: string, sourceType: string, hasSources: boolean): string {
  return hasSources ? `${SOURCE_PREFIX}${sourceType}` : `${TARGET_PREFIX}${targetId}`;
}

interface ConfigRow {
  key: string;
  name: string;
  meta: string;
  group: string;
}

interface ConfigItemListProps {
  configTargets: AgentTargetMeta[];
  activeTargetId: string;
  configEditorSources: ConfigEditorSourceMeta[];
  activeSourceType: string;
  followCursor: boolean;
  onSelectTarget: (targetId: string) => void;
  onSelectSource: (sourceType: string) => void;
  onActivate: (key: string) => void;
}

/**
 * Config targets, followed by the editor sources of the active target when it has any (opencode_config:
 * base, policy, snapshot, ...).
 */
export function ConfigItemList({
  configTargets,
  activeTargetId,
  configEditorSources,
  activeSourceType,
  followCursor,
  onSelectTarget,
  onSelectSource,
  onActivate,
}: ConfigItemListProps) {
  const hasSources = activeTargetId === "opencode_config" && configEditorSources.length > 0;
  const items = useMemo<ConfigRow[]>(
    () => [
      ...configTargets.map((target): ConfigRow => ({
        key: `${TARGET_PREFIX}${target.id}`,
        name: target.label,
        meta: target.source_rel,
        group: "targets",
      })),
      ...(hasSources
        ? configEditorSources.map((source): ConfigRow => ({
            key: `${SOURCE_PREFIX}${source.id}`,
            name: source.label,
            meta: "",
            group: "sources",
          }))
        : []),
    ],
    [configTargets, configEditorSources, hasSources],
  );

  const select = (key: string) => {
    if (key.startsWith(SOURCE_PREFIX)) {
      onSelectSource(key.slice(SOURCE_PREFIX.length));
      return;
    }
    const targetId = key.slice(TARGET_PREFIX.length);
    // The active target already shows its sources; re-selecting it would reset the chosen source to base.
    if (targetId !== activeTargetId) onSelectTarget(targetId);
  };

  return (
    <LibraryList<ConfigRow>
      label="Configs"
      items={items}
      getKey={row => row.key}
      getGroup={row => row.group}
      renderItem={row => (
        <>
          <span className="nm">{row.name}</span>
          {row.meta && <span className="meta">{row.meta}</span>}
        </>
      )}
      activeKey={activeTargetId ? configListKey(activeTargetId, activeSourceType, hasSources) : null}
      followCursor={followCursor}
      onSelect={select}
      onActivate={onActivate}
      activateHint="read"
    />
  );
}
