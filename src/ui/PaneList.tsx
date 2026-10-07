import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { usePaneId } from "./Pane";
import { cx } from "./tone";

export interface PaneListItemState {
  /** The row the cursor (and aria-activedescendant) is on. */
  cursor: boolean;
  /** The row exposed as aria-selected. */
  selected: boolean;
}

export interface PaneListFilter {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the filter input. */
  label: string;
  placeholder?: string;
}

export interface PaneListProps<T> {
  /** Accessible name of the listbox. */
  label: string;
  items: readonly T[];
  getKey: (item: T) => string;
  /** Content after the cursor cell: typically `<span className="nm">..</span><span className="meta">..</span>`. */
  renderItem: (item: T, state: PaneListItemState) => ReactNode;
  /** Group heading shown before the first item of each run of equal values. */
  getGroup?: (item: T) => string | null | undefined;
  /** Controlled cursor. Omit for an uncontrolled list that starts on `defaultCursorKey` or the first item. */
  cursorKey?: string | null;
  defaultCursorKey?: string | null;
  /** Fires whenever the cursor moves, and when it is corrected because its item disappeared. */
  onCursorChange?: (key: string, item: T) => void;
  /** Rows exposed as aria-selected. Default: just the cursor row. */
  selectedKeys?: ReadonlySet<string> | readonly string[];
  multiSelectable?: boolean;
  /** Enter on the cursor row, or double-click. */
  onActivate?: (item: T) => void;
  /** Space on the cursor row, or click, when `multiSelectable`. */
  onToggle?: (item: T) => void;
  /** Label of the Enter hint shown in the status bar while the list's pane has focus ("open"). */
  activateHint?: string;
  /** Label of the Space hint, same placement ("toggle target"). Only shown while the list is multi-selectable. */
  toggleHint?: string;
  filter?: PaneListFilter;
  /** Rendered instead of rows when `items` is empty, as a status message right under the filter. */
  empty?: ReactNode;
  /** Rows moved by PageUp/PageDown. */
  pageSize?: number;
  /** Overrides the enclosing Pane's id when building binding ids. */
  paneId?: string;
  className?: string;
}

function toSet(keys: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> | null {
  if (!keys) return null;
  return keys instanceof Set ? keys : new Set(keys);
}

/**
 * Single-tab-stop listbox: `ul[role=listbox][tabindex=0]` with `aria-activedescendant`, so Tab enters and
 * leaves it once. Keys (while it has focus): j/k and arrows move, `g g`/Home first, G/End last, PageUp/PageDown
 * page, Enter activates, Space toggles in multi-select lists, `/` focuses the filter, Escape clears an active
 * filter. Filtering itself is the caller's job: pass the already-filtered `items`.
 */
export function PaneList<T>({
  label,
  items,
  getKey,
  renderItem,
  getGroup,
  cursorKey: controlledCursorKey,
  defaultCursorKey = null,
  onCursorChange,
  selectedKeys,
  multiSelectable = false,
  onActivate,
  onToggle,
  activateHint,
  toggleHint,
  filter,
  empty,
  pageSize = 10,
  paneId: paneIdProp,
  className,
}: PaneListProps<T>) {
  const listId = useId();
  const enclosingPaneId = usePaneId();
  const paneId = paneIdProp ?? enclosingPaneId;
  const idBase = paneId ?? listId;
  const listRef = useRef<HTMLUListElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [internalKey, setInternalKey] = useState<string | null>(defaultCursorKey);
  const requestedKey = controlledCursorKey !== undefined ? controlledCursorKey : internalKey;

  const keys = items.map(getKey);
  const keySignature = keys.join("\u0000");
  const foundIndex = requestedKey === null ? -1 : keys.indexOf(requestedKey);
  const cursorIndex = items.length === 0 ? -1 : Math.max(0, foundIndex);

  const latest = useRef({ items, keys, cursorIndex, onCursorChange, onActivate, onToggle, filter, pageSize, multiSelectable });
  latest.current = { items, keys, cursorIndex, onCursorChange, onActivate, onToggle, filter, pageSize, multiSelectable };

  const moveTo = useCallback((index: number) => {
    const { items: list, keys: listKeys, onCursorChange: notify } = latest.current;
    if (list.length === 0) return;
    const next = Math.min(list.length - 1, Math.max(0, index));
    setInternalKey(listKeys[next]!);
    notify?.(listKeys[next]!, list[next]!);
  }, []);

  // The cursor always resolves to a row: repair it when its item is gone (filter changed, list reloaded).
  useEffect(() => {
    if (items.length > 0 && foundIndex === -1) moveTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature, requestedKey]);

  const optionId = (index: number) => `${listId}-opt-${index}`;
  const activeDescendant = cursorIndex >= 0 ? optionId(cursorIndex) : undefined;

  useEffect(() => {
    if (cursorIndex < 0) return;
    document.getElementById(`${listId}-opt-${cursorIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [cursorIndex, listId]);

  const selected = toSet(selectedKeys);
  const bindingBase = {
    group: "Lists",
    scope: "list" as const,
  };
  const bindings: Binding[] = [
    {
      ...bindingBase,
      id: `list.${idBase}.next`,
      keys: ["j", "ArrowDown"],
      title: "Move down",
      repeat: true,
      run: () => moveTo(latest.current.cursorIndex + 1),
    },
    {
      ...bindingBase,
      id: `list.${idBase}.prev`,
      keys: ["k", "ArrowUp"],
      title: "Move up",
      repeat: true,
      run: () => moveTo(latest.current.cursorIndex - 1),
    },
    {
      ...bindingBase,
      id: `list.${idBase}.first`,
      keys: ["g g", "Home"],
      title: "First item",
      run: () => moveTo(0),
    },
    {
      ...bindingBase,
      id: `list.${idBase}.last`,
      keys: ["G", "End"],
      title: "Last item",
      run: () => moveTo(latest.current.items.length - 1),
    },
    {
      ...bindingBase,
      id: `list.${idBase}.page-down`,
      keys: "PageDown",
      title: "Page down",
      repeat: true,
      run: () => moveTo(latest.current.cursorIndex + latest.current.pageSize),
    },
    {
      ...bindingBase,
      id: `list.${idBase}.page-up`,
      keys: "PageUp",
      title: "Page up",
      repeat: true,
      run: () => moveTo(latest.current.cursorIndex - latest.current.pageSize),
    },
    {
      ...bindingBase,
      id: `list.${idBase}.activate`,
      keys: "Enter",
      title: "Activate item",
      hint: activateHint,
      paneId: activateHint && paneId ? paneId : undefined,
      when: () => latest.current.onActivate !== undefined && latest.current.cursorIndex >= 0,
      run: () => {
        const { items: list, cursorIndex: at, onActivate: activate } = latest.current;
        if (at >= 0 && activate) activate(list[at]!);
      },
    },
    {
      ...bindingBase,
      id: `list.${idBase}.toggle`,
      keys: "Space",
      title: "Toggle selection",
      hint: toggleHint,
      paneId: toggleHint && paneId ? paneId : undefined,
      when: () => latest.current.multiSelectable && latest.current.onToggle !== undefined && latest.current.cursorIndex >= 0,
      run: () => {
        const { items: list, cursorIndex: at, onToggle: toggle } = latest.current;
        if (at >= 0 && toggle) toggle(list[at]!);
      },
    },
    {
      ...bindingBase,
      id: `list.${idBase}.filter`,
      keys: "/",
      title: "Filter",
      when: () => latest.current.filter !== undefined,
      run: () => {
        filterRef.current?.focus();
        filterRef.current?.select();
      },
    },
    {
      ...bindingBase,
      id: `list.${idBase}.clear-filter`,
      keys: "Escape",
      title: "Clear filter",
      when: () => Boolean(latest.current.filter?.value),
      run: () => latest.current.filter?.onChange(""),
    },
  ];
  useKeymap(bindings, { ref: listRef });

  const onFilterKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "Escape":
      case "Enter":
        event.preventDefault();
        listRef.current?.focus();
        break;
      case "ArrowDown":
        event.preventDefault();
        moveTo(latest.current.cursorIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(latest.current.cursorIndex - 1);
        break;
    }
  };

  let previousGroup: string | null | undefined;
  return (
    <>
      {filter && (
        <div className="filter">
          <span className="c-acc" aria-hidden="true">/</span>
          <input
            ref={filterRef}
            type="search"
            value={filter.value}
            placeholder={filter.placeholder ?? "filter"}
            aria-label={filter.label}
            aria-keyshortcuts="/"
            onChange={event => filter.onChange(event.target.value)}
            onKeyDown={onFilterKeyDown}
          />
        </div>
      )}
      {items.length === 0 && (
        <p className="c-dim" role="status">
          {empty ?? "nothing to show"}
        </p>
      )}
      <ul
        ref={listRef}
        className={cx("rows", className)}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiSelectable || undefined}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        data-pane-primary=""
        data-keyscope="list"
      >
        {items.map((item, index) => {
          const key = keys[index]!;
          const group = getGroup?.(item);
          const heading = group && group !== previousGroup ? group : null;
          previousGroup = group;
          const isCursor = index === cursorIndex;
          const isSelected = selected ? selected.has(key) : isCursor;
          return (
            <Fragment key={key}>
              {heading && (
                <li className="group" role="presentation">
                  {heading}
                </li>
              )}
              <li
                id={optionId(index)}
                className="row"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  listRef.current?.focus();
                  moveTo(index);
                  if (multiSelectable) latest.current.onToggle?.(item);
                }}
                onDoubleClick={() => latest.current.onActivate?.(item)}
              >
                <span className="cur" aria-hidden="true">
                  <span className="g">{isCursor ? "▸" : " "}</span>
                </span>
                {renderItem(item, { cursor: isCursor, selected: isSelected })}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}
