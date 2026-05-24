import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CopyButton } from "../../components/CopyButton";
import { PROMPT_LOOP_GROUPS } from "./data";
import type { PromptLoopGroup, PromptLoopItem } from "./types";

function filterItems(group: PromptLoopGroup, query: string): PromptLoopItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return group.items;
  return group.items.filter(item => {
    const haystack = [group.group, item.title, item.meta, item.prompt].join("\n").toLowerCase();
    return haystack.includes(q);
  });
}

interface PromptLoopsToolProps {
  toolsSwitcher?: ReactNode;
}

export function PromptLoopsTool({ toolsSwitcher }: PromptLoopsToolProps) {
  const [groupIndex, setGroupIndex] = useState(0);
  const [itemIndex, setItemIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const statusTimerRef = useRef<number | null>(null);

  const group = PROMPT_LOOP_GROUPS[groupIndex] ?? PROMPT_LOOP_GROUPS[0];
  const items = useMemo(() => filterItems(group, query), [group, query]);
  const activeItem = items[itemIndex] ?? items[0] ?? null;

  useEffect(() => {
    if (itemIndex >= items.length) setItemIndex(0);
  }, [items.length, itemIndex]);

  const showStatus = useCallback((text: string) => {
    setStatus(text);
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => setStatus(null), 1200);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement !== searchRef.current) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (document.activeElement === searchRef.current) return;
      if (!items.length) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setItemIndex(i => Math.min(items.length - 1, i + 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setItemIndex(i => Math.max(0, i - 1));
      }
      if (event.key >= "1" && event.key <= "4") {
        const next = Number(event.key) - 1;
        if (PROMPT_LOOP_GROUPS[next]) {
          setGroupIndex(next);
          setItemIndex(0);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [items.length]);

  return (
    <div className="prompt-loops-tool">
      <aside className="prompt-loops-sidebar">
        <div className="tool-context-brand font-mono">
          <span className="tools-title-dot" aria-hidden="true" />
          <span>kretsverket.prompt.loops</span>
        </div>
        <nav className="prompt-loops-nav" aria-label="Prompt groups">
          {PROMPT_LOOP_GROUPS.map((g, index) => (
            <button
              key={g.key}
              type="button"
              className={`prompt-loops-nav-btn${index === groupIndex ? " prompt-loops-nav-btn-active" : ""}`}
              onClick={() => {
                setGroupIndex(index);
                setItemIndex(0);
              }}
              aria-current={index === groupIndex ? "true" : undefined}
            >
              <span className="prompt-loops-nav-label">{g.group}</span>
              <span className="prompt-loops-count">{g.items.length}</span>
            </button>
          ))}
        </nav>
        <footer className="tool-sidebar-footer font-mono">
          {toolsSwitcher}
          <div className="tool-sidebar-hints">
            <div><span className="prompt-loops-pill">1–4</span> group</div>
            <div><span className="prompt-loops-pill">/</span> search</div>
            <div><span className="prompt-loops-pill">↑↓</span> navigate</div>
          </div>
        </footer>
      </aside>

      <section className="prompt-loops-main">
        <header className="prompt-loops-topbar">
          <div className="prompt-loops-titleline font-mono">
            <strong>{group.group}</strong>
            <span className="text-muted"> / {items.length} prompt{items.length === 1 ? "" : "s"}</span>
          </div>
          <div className="prompt-loops-search">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setItemIndex(0);
              }}
              placeholder="filter prompts"
              aria-label="Filter prompts"
            />
          </div>
        </header>

        <div className="prompt-loops-workspace">
          <div className="prompt-loops-list-pane">
            {items.length === 0 ? (
              <div className="prompt-loops-empty font-mono">no matching prompts</div>
            ) : (
              items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className={`prompt-loops-card${index === itemIndex ? " prompt-loops-card-active" : ""}`}
                  onClick={() => setItemIndex(index)}
                  aria-current={index === itemIndex ? "true" : undefined}
                >
                  <div className="prompt-loops-card-head">
                    <div className="prompt-loops-card-title">{item.title}</div>
                    <div className="prompt-loops-card-id font-mono">{String(index + 1).padStart(2, "0")}</div>
                  </div>
                  <div className="prompt-loops-card-meta">{item.meta}</div>
                </button>
              ))
            )}
          </div>

          <div className="prompt-loops-detail-pane">
            {activeItem ? (
              <>
                <div className="prompt-loops-detail-head">
                  <div>
                    <h2 className="prompt-loops-detail-title">{activeItem.title}</h2>
                    <p className="prompt-loops-detail-meta text-muted">{activeItem.meta}</p>
                  </div>
                </div>
                <div className="prompt-loops-prompt-wrap">
                  <CopyButton
                    getText={() => activeItem.prompt}
                    copyLabel="Copy prompt"
                    copiedLabel="Prompt copied"
                    className="prompt-loops-prompt-copy"
                    fallbackElementId="prompt-loops-active-prompt"
                    onCopySuccess={() => showStatus("prompt copied")}
                    onCopyFailure={() => showStatus("copy failed")}
                  />
                  <pre id="prompt-loops-active-prompt" className="prompt-loops-prompt font-mono">
                    {activeItem.prompt}
                  </pre>
                </div>
              </>
            ) : (
              <div className="prompt-loops-empty font-mono">select a prompt</div>
            )}
          </div>
        </div>
      </section>

      {status && (
        <div className="prompt-loops-status font-mono prompt-loops-status-show" role="status">
          {status}
        </div>
      )}
    </div>
  );
}
