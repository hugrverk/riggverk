import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CopyButton } from "../../components/CopyButton";
import { useSavedRepoDashboardEntries } from "../../lib/savedRepoEntries";
import type { RepoPromptContext } from "../../types";
import {
  composePrompt,
  hasActiveComposerState,
  isOptionDisabled,
  NO_REPO_CONTEXT_VALUE,
  PROMPT_OPTION_DEFS,
  togglePromptOption,
  type PromptRepoContextSection,
} from "./composer";
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
  const [repoEntryId, setRepoEntryId] = useState(NO_REPO_CONTEXT_VALUE);
  const [taskContext, setTaskContext] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(() => new Set());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [repoPromptContext, setRepoPromptContext] = useState<PromptRepoContextSection | null>(null);
  const [repoContextLoading, setRepoContextLoading] = useState(false);
  const [repoContextWarning, setRepoContextWarning] = useState<string | null>(null);
  const { entries: savedRepos, loading: savedReposLoading } = useSavedRepoDashboardEntries();
  const searchRef = useRef<HTMLInputElement>(null);
  const statusTimerRef = useRef<number | null>(null);
  const repoContextSeqRef = useRef(0);

  const group = PROMPT_LOOP_GROUPS[groupIndex] ?? PROMPT_LOOP_GROUPS[0];
  const items = useMemo(() => filterItems(group, query), [group, query]);
  const activeItem = items[itemIndex] ?? items[0] ?? null;

  const selectedRepoEntry = useMemo(
    () => savedRepos.find(e => e.id === repoEntryId) ?? null,
    [savedRepos, repoEntryId],
  );

  const activeRepoContext = useMemo((): PromptRepoContextSection | null => {
    if (!selectedRepoEntry) return null;
    return (
      repoPromptContext ?? {
        label: selectedRepoEntry.label,
        repo_slug: null,
        current_branch: null,
        default_branch: selectedRepoEntry.default_branch?.trim() || null,
      }
    );
  }, [selectedRepoEntry, repoPromptContext]);

  const composedPrompt = useMemo(() => {
    if (!activeItem) return "";
    return composePrompt({
      basePrompt: activeItem.prompt,
      repoContext: activeRepoContext,
      taskContext,
      selectedOptionIds: [...selectedOptions],
    });
  }, [activeItem, activeRepoContext, taskContext, selectedOptions]);

  useEffect(() => {
    if (!selectedRepoEntry) {
      setRepoPromptContext(null);
      setRepoContextLoading(false);
      setRepoContextWarning(null);
      return;
    }

    const seq = ++repoContextSeqRef.current;
    setRepoContextLoading(true);
    setRepoContextWarning(null);
    setRepoPromptContext({
      label: selectedRepoEntry.label,
      repo_slug: null,
      current_branch: null,
      default_branch: selectedRepoEntry.default_branch?.trim() || null,
    });

    invoke<RepoPromptContext>("get_repo_prompt_context", {
      repoPath: selectedRepoEntry.path,
      defaultBranch: selectedRepoEntry.default_branch ?? null,
    })
      .then(ctx => {
        if (seq !== repoContextSeqRef.current) return;
        setRepoPromptContext({
          label: selectedRepoEntry.label,
          repo_slug: ctx.repo_slug,
          current_branch: ctx.current_branch,
          default_branch: ctx.default_branch,
        });
      })
      .catch(() => {
        if (seq !== repoContextSeqRef.current) return;
        setRepoContextWarning(
          "Could not read git metadata; using generic repository context without local path.",
        );
        setRepoPromptContext({
          label: selectedRepoEntry.label,
          repo_slug: null,
          current_branch: null,
          default_branch: selectedRepoEntry.default_branch?.trim() || null,
        });
      })
      .finally(() => {
        if (seq === repoContextSeqRef.current) setRepoContextLoading(false);
      });
  }, [
    selectedRepoEntry?.id,
    selectedRepoEntry?.label,
    selectedRepoEntry?.path,
    selectedRepoEntry?.default_branch,
  ]);

  const composerActive = hasActiveComposerState({
    repoEntryId,
    taskContext,
    selectedOptionIds: selectedOptions,
  });

  useEffect(() => {
    if (itemIndex >= items.length) setItemIndex(0);
  }, [items.length, itemIndex]);

  const showStatus = useCallback((text: string) => {
    setStatus(text);
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => setStatus(null), 1200);
  }, []);

  const clearComposer = useCallback(() => {
    setRepoEntryId(NO_REPO_CONTEXT_VALUE);
    setTaskContext("");
    setSelectedOptions(new Set());
    setRepoPromptContext(null);
    setRepoContextWarning(null);
  }, []);

  const toggleOption = useCallback((optionId: string) => {
    setSelectedOptions(prev => togglePromptOption(prev, optionId));
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
          <label className="prompt-loops-group-select-wrap font-mono">
            <select
              className="repo-dashboard-field prompt-loops-group-select"
              value={groupIndex}
              onChange={e => {
                setGroupIndex(Number(e.target.value));
                setItemIndex(0);
              }}
              aria-label="Prompt group"
            >
              {PROMPT_LOOP_GROUPS.map((g, index) => (
                <option key={g.key} value={index}>{g.group}</option>
              ))}
            </select>
          </label>
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
                  {composerActive ? (
                    <button
                      type="button"
                      className="prompt-loops-composer-reset font-mono"
                      onClick={clearComposer}
                    >
                      Clear composer
                    </button>
                  ) : null}
                </div>

                <div className="prompt-loops-composer font-mono">
                  <label className="prompt-loops-composer-field">
                    <span className="prompt-loops-composer-label">Repo context</span>
                    <select
                      className="repo-dashboard-field prompt-loops-composer-select"
                      value={repoEntryId}
                      onChange={e => setRepoEntryId(e.target.value)}
                      aria-label="Repository context"
                      disabled={savedReposLoading}
                    >
                      <option value={NO_REPO_CONTEXT_VALUE}>No repo context</option>
                      {savedRepos.map(entry => (
                        <option key={entry.id} value={entry.id}>{entry.label}</option>
                      ))}
                    </select>
                  </label>
                  {!savedReposLoading && savedRepos.length === 0 ? (
                    <p className="prompt-loops-composer-note text-muted small">
                      No saved repos yet. Add entries in Repo Dashboard; templates still copy as-is without context.
                    </p>
                  ) : null}
                  {repoContextLoading ? (
                    <p className="prompt-loops-composer-note text-muted small" role="status">
                      Reading git repository context…
                    </p>
                  ) : null}
                  {repoContextWarning ? (
                    <p className="prompt-loops-composer-note text-muted small" role="status">
                      {repoContextWarning}
                    </p>
                  ) : null}

                  <label className="prompt-loops-composer-field">
                    <span className="prompt-loops-composer-label">Task / context (optional)</span>
                    <textarea
                      className="prompt-loops-composer-textarea"
                      value={taskContext}
                      onChange={e => setTaskContext(e.target.value)}
                      placeholder="Add bounded task context visible in the preview"
                      rows={2}
                      aria-label="Optional task or context"
                    />
                  </label>

                  <details
                    className="prompt-loops-options-panel"
                    open={optionsOpen}
                    onToggle={e => setOptionsOpen((e.target as HTMLDetailsElement).open)}
                  >
                    <summary className="prompt-loops-options-summary">Prompt options</summary>
                    {optionsOpen ? (
                    <div
                      className="prompt-loops-options-chips"
                      role="group"
                      aria-label="Prompt options"
                    >
                      {PROMPT_OPTION_DEFS.map(def => {
                        const pressed = selectedOptions.has(def.id);
                        const { disabled, reason } = isOptionDisabled(selectedOptions, def.id);
                        return (
                          <button
                            key={def.id}
                            type="button"
                            className={`prompt-loops-option-chip${pressed ? " prompt-loops-option-chip-active" : ""}`}
                            aria-pressed={pressed}
                            disabled={disabled}
                            title={disabled ? reason : undefined}
                            onClick={() => toggleOption(def.id)}
                          >
                            {def.label}
                          </button>
                        );
                      })}
                    </div>
                    ) : null}
                  </details>
                </div>

                <div className="prompt-loops-prompt-wrap">
                  <CopyButton
                    getText={() => composedPrompt}
                    copyLabel="Copy prompt"
                    copiedLabel="Prompt copied"
                    className="prompt-loops-prompt-copy"
                    fallbackElementId="prompt-loops-active-prompt"
                    onCopySuccess={() => showStatus("prompt copied")}
                    onCopyFailure={() => showStatus("copy failed")}
                  />
                  <pre id="prompt-loops-active-prompt" className="prompt-loops-prompt font-mono">
                    {composedPrompt}
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
