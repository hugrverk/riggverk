import { useEffect, useRef, useState, type ReactNode } from "react";
import { PaneList, type PaneListFilter, type PaneListItemState } from "../../ui/PaneList";

/** j/k must not fire a read per key press: the list opens the row the cursor rests on. */
export const SELECT_DELAY_MS = 120;
/** After the list asked for an item, a change of the open item is its own answer, not an outside change. */
const OWN_OPEN_WINDOW_MS = 1000;

export interface LibraryListProps<T> {
  /** Accessible name of the listbox. */
  label: string;
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, state: PaneListItemState) => ReactNode;
  getGroup?: (item: T) => string | null | undefined;
  /** Key of the row whose content is open; it is the row exposed as aria-selected. */
  activeKey: string | null;
  /**
   * False while the open item has unsaved edits: the cursor then only moves, and a row opens on Enter
   * (through the controller's discard confirmation), so browsing never raises that dialog by itself.
   */
  followCursor: boolean;
  /** Opens a row (the controller's guarded select). */
  onSelect: (key: string) => void | Promise<void>;
  /** Enter, double-click or `i` on a row: open it and move into the editor. */
  onActivate: (key: string) => void;
  /** Label of the Enter hint in the status bar while the list has focus. */
  activateHint?: string;
  filter?: PaneListFilter;
  empty?: ReactNode;
}

/**
 * PaneList whose cursor previews: moving it opens the row under it after a short pause, so the editor and
 * preview panes follow the list. The list keeps its own cursor and re-syncs it when the open item changes
 * from outside (first load, a newly created doc).
 */
export function LibraryList<T>({
  label,
  items,
  getKey,
  renderItem,
  getGroup,
  activeKey,
  followCursor,
  onSelect,
  onActivate,
  activateHint = "edit",
  filter,
  empty,
}: LibraryListProps<T>) {
  const [cursor, setCursor] = useState<string | null>(activeKey);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOpenAt = useRef(0);
  const live = useRef({ activeKey, followCursor, onSelect });
  live.current = { activeKey, followCursor, onSelect };

  const cancelPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelPending, []);

  const open = (key: string) => {
    cancelPending();
    if (key === live.current.activeKey) return;
    lastOpenAt.current = Date.now();
    void Promise.resolve(live.current.onSelect(key)).catch(() => {});
  };

  const onCursorChange = (key: string) => {
    setCursor(key);
    cancelPending();
    if (key === live.current.activeKey) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      // Decided now, not when the cursor moved: an edit started during the pause must not raise the discard dialog.
      if (!live.current.followCursor) return;
      open(key);
    }, SELECT_DELAY_MS);
  };

  const activeListed = activeKey !== null && items.some(item => getKey(item) === activeKey);
  useEffect(() => {
    if (activeKey === null || !activeListed || activeKey === cursor) return;
    if (timer.current !== null || Date.now() - lastOpenAt.current < OWN_OPEN_WINDOW_MS) return;
    setCursor(activeKey);
    // Only the open item (or its row appearing in the list, e.g. a new doc) re-syncs the cursor; moving the
    // cursor must not bounce it back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeListed]);

  const activate = (item: T) => {
    const key = getKey(item);
    setCursor(key);
    open(key);
    onActivate(key);
  };

  return (
    <PaneList<T>
      label={label}
      items={items}
      getKey={getKey}
      renderItem={renderItem}
      getGroup={getGroup}
      cursorKey={cursor}
      onCursorChange={onCursorChange}
      selectedKeys={activeKey === null ? [] : [activeKey]}
      onActivate={activate}
      activateHint={activateHint}
      filter={filter}
      empty={empty}
    />
  );
}
