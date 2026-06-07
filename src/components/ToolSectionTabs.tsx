import { useCallback, useRef, type KeyboardEvent } from "react";

export interface ToolSectionTabItem {
  id: string;
  label: string;
  count?: string | number;
}

interface ToolSectionTabsProps {
  items: ToolSectionTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  className?: string;
}

export function ToolSectionTabs({
  items,
  activeId,
  onSelect,
  ariaLabel,
  className,
}: ToolSectionTabsProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTab = useCallback((index: number) => {
    tabRefs.current[index]?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!items.length) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % items.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(items[index].id);
      return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      onSelect(items[nextIndex].id);
      focusTab(nextIndex);
    }
  };

  return (
    <div
      className={`tool-section-tabs${className ? ` ${className}` : ""}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => {
        const selected = item.id === activeId;
        const tabLabel =
          item.count != null && item.count !== ""
            ? `${item.label}, ${item.count}`
            : item.label;
        return (
          <button
            key={item.id}
            ref={el => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`tool-section-tab${selected ? " tool-section-tab-active" : ""}`}
            onClick={() => onSelect(item.id)}
            onKeyDown={e => handleKeyDown(e, index)}
            aria-label={tabLabel}
          >
            <span className="tool-section-tab-label" aria-hidden="true">
              {item.label}
            </span>
            {item.count != null && item.count !== "" ? (
              <span className="tool-section-tab-count" aria-hidden="true">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
