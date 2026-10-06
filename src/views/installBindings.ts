import type { Binding } from "../keyboard/registry";
import type { UpdateAction } from "../lib/installationView";

interface InstallBindingOptions {
  /** Prefix of the binding ids ("start", "codex"); each pane gets its own suffix. */
  idPrefix: string;
  /** The panes whose footers offer the actions. */
  paneIds: readonly string[];
  update: UpdateAction;
  /** Why a preview is off, or false. */
  previewDisabled: string | false;
  onUpdate: () => void;
  onPreview: () => void;
  onRefresh?: () => void;
}

/** `u` update, `p` preview and `r` refresh, anchored to each of `paneIds` so every pane footer offers them. */
export function installBindings({
  idPrefix,
  paneIds,
  update,
  previewDisabled,
  onUpdate,
  onPreview,
  onRefresh,
}: InstallBindingOptions): Binding[] {
  return paneIds.flatMap((paneId): Binding[] => [
    {
      id: `${idPrefix}.${paneId}.update`,
      keys: "u",
      title: "Review and apply the update",
      hint: update.label,
      group: "Install",
      scope: "pane",
      paneId,
      when: () => update.disabled || true,
      run: () => onUpdate(),
    },
    {
      id: `${idPrefix}.${paneId}.preview`,
      keys: "p",
      title: "Preview the update without applying",
      hint: "preview",
      group: "Install",
      scope: "pane",
      paneId,
      when: () => previewDisabled || true,
      run: () => onPreview(),
    },
    ...(onRefresh
      ? [
          {
            id: `${idPrefix}.${paneId}.refresh`,
            keys: "r",
            title: "Refresh installation status",
            hint: "refresh",
            group: "Install",
            scope: "pane" as const,
            paneId,
            run: () => onRefresh(),
          },
        ]
      : []),
  ]);
}
