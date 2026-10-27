import { useEffect, useRef, type RefObject } from "react";
import { useConfirm } from "../../components/ConfirmDialog";
import { useCommands } from "../../keyboard/commands/useCommands";
import type { CommandSpec } from "../../keyboard/commands/parser";
import { focusPaneById } from "../../keyboard/focus";
import type { Binding } from "../../keyboard/registry";
import { useKeymap } from "../../keyboard/useKeymap";
import { LEAVE_DIRTY_MESSAGE } from "../../lib/editorGuards";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import { useShellState } from "../../shell/ShellState";
import type { LibrarySourceType } from "../LibraryView";
import type { LibraryEntry } from "./entry";

interface LibraryKeysOptions {
  /** Library bindings are live while focus is inside this element. */
  rootRef: RefObject<HTMLElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  entry: LibraryEntry | null;
  sourceType: LibrarySourceType;
  /** Source ids in tab order (configs left out while it is hidden). */
  sourceIds: readonly LibrarySourceType[];
  dataFolderOk: boolean;
  onSetSourceType: (type: LibrarySourceType) => void | Promise<void>;
  showCreateDoc: boolean;
  onSetShowCreateDoc: (show: boolean) => void;
  /** Switches the document pane to the source textarea and puts the cursor in it. */
  startEdit: () => void;
  /** Switches the document pane back to the rendered view (focus follows in the caller). */
  stopEdit: () => void;
}

/** Panes whose focus offers `o` as a status-bar hint (the key itself works anywhere in the library). */
const OPEN_PANES = ["items", "editor"] as const;

/**
 * Library key layer: `[`/`]` source, `/` filter (hint only: the list owns the key), `i`/Enter edit the open
 * item (rendered view -> textarea), Mod+s and `:w` save, Escape back to the rendered view, `:q` close (asks
 * first when there are unsaved edits), `:reset`, `o` open externally, `n` new doc. Edit, save and open are
 * offered only where the item is the user's own text; on a bundled item their hints say why not.
 * Selection itself lives in the item lists; every guard (dirty confirm, stale loads) stays in the controller.
 */
export function useLibraryKeys({
  rootRef,
  textareaRef,
  entry,
  sourceType,
  sourceIds,
  dataFolderOk,
  onSetSourceType,
  showCreateDoc,
  onSetShowCreateDoc,
  startEdit,
  stopEdit,
}: LibraryKeysOptions): { close: () => Promise<void> } {
  const confirm = useConfirm();
  const { notify, beginConfirm } = useShellState();
  const latest = useRef(entry);
  latest.current = entry;

  const focusItems = () => focusPaneById("items", rootRef.current ?? document);
  /** After the command line closes, which hands focus back to whatever opened it. */
  const focusItemsSoon = () => {
    window.setTimeout(focusItems, 0);
  };

  const stepSource = (delta: number) => {
    if (sourceIds.length === 0) return;
    const index = Math.max(0, sourceIds.indexOf(sourceType));
    const next = sourceIds[(index + delta + sourceIds.length) % sourceIds.length]!;
    void onSetSourceType(next);
  };

  const save = () => {
    const current = latest.current;
    if (!current) {
      notify("nothing is open", { tone: "warn" });
      return;
    }
    if (current.readOnly) {
      notify(current.readOnlyReason ?? "read-only item", { tone: "warn" });
      return;
    }
    if (!current.dirty) {
      notify("no changes to save", { tone: "warn" });
      return;
    }
    if (current.saving) return;
    current.onSave();
  };

  const close = async () => {
    const current = latest.current;
    if (current?.dirty) {
      const release = beginConfirm();
      let ok = false;
      try {
        ok = await confirm(LEAVE_DIRTY_MESSAGE);
      } finally {
        release();
      }
      if (!ok) return;
      latest.current?.onReset();
    }
    stopEdit();
    focusItemsSoon();
  };

  // A save that finishes successfully is reported in the status bar too, for when focus is elsewhere.
  const saving = entry?.saving ?? false;
  const wasSaving = useRef(false);
  useEffect(() => {
    const result = latest.current?.saveResult;
    if (wasSaving.current && !saving && result?.success) notify(redactTerminalOutput(result.stdout) || "saved", { tone: "ok" });
    wasSaving.current = saving;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  const bindings: Binding[] = [
    {
      id: "library.source.prev",
      keys: ["[", "<"],
      title: "Previous source",
      hint: "prev source",
      group: "Library",
      scope: "pane",
      paneId: "items",
      run: () => stepSource(-1),
    },
    {
      id: "library.source.next",
      keys: ["]", ">"],
      title: "Next source",
      hint: "next source",
      group: "Library",
      scope: "pane",
      paneId: "items",
      run: () => stepSource(1),
    },
    {
      id: "library.edit",
      keys: ["Enter", "i"],
      title: "Edit the open item",
      hint: "edit",
      group: "Library",
      scope: "pane",
      paneId: "editor",
      when: () => {
        const current = latest.current;
        if (!current) return false;
        return current.readOnly ? current.readOnlyReason ?? "read-only" : true;
      },
      run: startEdit,
    },
    {
      id: "library.save",
      keys: "Mod+s",
      title: "Save",
      hint: "save",
      group: "Library",
      scope: "editor",
      paneId: "editor",
      inEditable: true,
      when: () => {
        const current = latest.current;
        if (!current) return false;
        return current.readOnly ? current.readOnlyReason ?? "read-only" : true;
      },
      run: save,
    },
    {
      id: "library.leave",
      keys: "Escape",
      title: "Leave the editor",
      group: "Library",
      scope: "editor",
      inEditable: true,
      run: event => {
        if (event.target !== textareaRef.current) return false;
        stopEdit();
      },
    },
    ...OPEN_PANES.map((paneId): Binding => ({
      id: `library.open.${paneId}`,
      keys: "o",
      title: "Open in the external editor",
      hint: "open",
      group: "Library",
      scope: "pane",
      paneId,
      when: () => {
        const current = latest.current;
        if (!current) return false;
        return current.onOpen ? true : current.readOnlyReason ?? "nothing to open";
      },
      run: () => latest.current?.onOpen?.(),
    })),
    {
      id: "library.new-doc",
      keys: "n",
      title: "New doc",
      hint: "new doc",
      group: "Library",
      scope: "pane",
      paneId: "items",
      when: () => sourceType === "docs" && dataFolderOk,
      run: () => onSetShowCreateDoc(!showCreateDoc),
    },
  ];
  useKeymap(bindings, { ref: rootRef });

  const hasItem = () => (latest.current ? true : "nothing is open");
  const commands: CommandSpec[] = [
    {
      name: "w",
      aliases: ["write"],
      summary: "save the open item",
      group: "Library",
      enabled: () => (latest.current?.readOnly ? latest.current.readOnlyReason ?? "read-only item" : hasItem()),
      run: save,
    },
    {
      name: "q",
      aliases: ["close"],
      summary: "close the open item (asks before discarding edits)",
      group: "Library",
      enabled: hasItem,
      run: close,
    },
    {
      name: "reset",
      summary: "discard unsaved edits of the open item",
      group: "Library",
      enabled: () => (latest.current?.dirty ? true : "no unsaved changes"),
      run: () => latest.current?.onReset(),
    },
  ];
  useCommands(commands);

  return { close };
}
