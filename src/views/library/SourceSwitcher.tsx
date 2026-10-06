import type { LibrarySourceType } from "../LibraryView";

export interface LibrarySourceTab {
  id: LibrarySourceType;
  /** Short visible label. */
  label: string;
  /** Full name (tooltip). */
  title: string;
  count?: number;
}

interface SourceSwitcherProps {
  sources: readonly LibrarySourceTab[];
  activeId: LibrarySourceType;
  onSelect: (id: LibrarySourceType) => void;
}

/**
 * The library sources with their counts, one click each. It wraps when the pane is narrow, which the pane
 * title (a single ellipsised line) cannot do; `[` and `]` step through the same list from the keyboard.
 */
export function SourceSwitcher({ sources, activeId, onSelect }: SourceSwitcherProps) {
  return (
    <div className="lib-sources" role="group" aria-label="Library source type">
      {sources.map((source) => (
        <button
          key={source.id}
          type="button"
          className="lib-source"
          title={source.title}
          aria-current={source.id === activeId ? "true" : undefined}
          onClick={() => onSelect(source.id)}
        >
          {source.label}
          {source.count !== undefined && <span className="c-dim"> {source.count}</span>}
        </button>
      ))}
    </div>
  );
}
