import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "../../components/CopyButton";
import { ToolSectionTabs } from "../../components/ToolSectionTabs";
import { focusPaneById } from "../../keyboard/focus";
import type { Binding } from "../../keyboard/registry";
import { useKeymap } from "../../keyboard/useKeymap";
import { useTransientStatus } from "../../lib/useTransientStatus";
import { Pane } from "../../ui/Pane";
import { PaneList } from "../../ui/PaneList";
import type { RepoDashboardEntry } from "../../types";
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
import type { PromptLoopContextSeed } from "./contextHandoff";
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
  contextSeed?: PromptLoopContextSeed | null;
  /** Called once a seed has been applied so the owner can drop it instead of re-applying it on the next visit. */
  onContextSeedConsumed?: (seedId: string) => void;
  savedRepos?: RepoDashboardEntry[];
  savedReposLoading?: boolean;
}

export function PromptLoopsTool({
  contextSeed = null,
  onContextSeedConsumed,
  savedRepos = [],
  savedReposLoading = false,
}: PromptLoopsToolProps) {
  const [groupIndex, setGroupIndex] = useState(0);
  // The list cursor; falls back to the first prompt when it is unset or filtered out.
  const [itemId, setItemId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { status, showStatus } = useTransientStatus(1200);
  const [repoEntryId, setRepoEntryId] = useState(NO_REPO_CONTEXT_VALUE);
  const [taskContext, setTaskContext] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(() => new Set());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [repoPromptContext, setRepoPromptContext] = useState<PromptRepoContextSection | null>(null);
  const [repoContextLoading, setRepoContextLoading] = useState(false);
  const [repoContextWarning, setRepoContextWarning] = useState<string | null>(null);
  const taskContextRef = useRef<HTMLTextAreaElement>(null);
  const repoContextSeqRef = useRef(0);
  const appliedContextSeedIdRef = useRef<string | null>(null);

  const group = PROMPT_LOOP_GROUPS[groupIndex] ?? PROMPT_LOOP_GROUPS[0];
  const items = useMemo(() => filterItems(group, query), [group, query]);
  const activeItem = items.find(item => item.id === itemId) ?? items[0] ?? null;
  const itemNumbers = useMemo(() => new Map(items.map((item, index) => [item.id, index + 1])), [items]);

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
    if (!contextSeed) return;
    if (appliedContextSeedIdRef.current === contextSeed.id) return;
    appliedContextSeedIdRef.current = contextSeed.id;
    setTaskContext(contextSeed.taskContext);
    if (contextSeed.repoEntryId) {
      setRepoEntryId(contextSeed.repoEntryId);
    }
    showStatus("context loaded from Repo Dashboard");
    onContextSeedConsumed?.(contextSeed.id);
  }, [contextSeed, onContextSeedConsumed, showStatus]);

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


  const selectPromptGroup = useCallback((index: number) => {
    setGroupIndex(index);
    setItemId(null);
  }, []);

  const cycleGroup = (delta: number) => {
    const count = PROMPT_LOOP_GROUPS.length;
    selectPromptGroup((groupIndex + delta + count) % count);
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(composedPrompt);
      showStatus("prompt copied");
    } catch {
      showStatus("copy failed");
    }
  };

  // Tab numbers and `h`/`l` belong to the shell; row movement, `/` and Enter come from the PaneList.
  // Group keys come in two spellings: `<`/`>` (the Nordic Mac `<>` key) and `[`/`]`, which need Option there and
  // Alt is never bound. The first spelling is the one shown in the hints.
  const bindings: Binding[] = [
    {
      id: "prompts.group.prev",
      keys: ["<", "["],
      title: "Previous prompt group",
      group: "Prompt Builder",
      hint: "prev",
      scope: "global",
      run: () => cycleGroup(-1),
    },
    {
      id: "prompts.group.next",
      keys: [">", "]"],
      title: "Next prompt group",
      group: "Prompt Builder",
      hint: "next group",
      scope: "global",
      run: () => cycleGroup(1),
    },
    {
      id: "prompts.copy",
      keys: "y",
      title: "Copy composed prompt",
      group: "Prompt Builder",
      hint: "copy",
      scope: "global",
      when: () => activeItem !== null,
      run: () => void copyPrompt(),
    },
    {
      id: "prompts.context",
      keys: "i",
      title: "Edit task context",
      group: "Prompt Builder",
      hint: "context",
      scope: "global",
      when: () => activeItem !== null,
      run: () => {
        if (!taskContextRef.current) return false;
        taskContextRef.current.focus();
      },
    },
  ];
  useKeymap(bindings);

  return (
    <div className="prompt-loops-tool">
      <div className="screen prompt-loops-main">
        <Pane
          id="prompt-list"
          title="prompts"
          meta={`· ${group.group} · ${items.length}`}
          className="prompt-loops-list-pane"
          bodyClassName="prompt-loops-list-body"
          defaultFocus
        >
          <div className="prompt-loops-group-bar">
            <ToolSectionTabs
              className="prompt-loops-section-tabs"
              items={PROMPT_LOOP_GROUPS.map(g => ({
                id: g.key,
                label: g.group,
                count: g.items.length,
              }))}
              activeId={group.key}
              onSelect={id => {
                const next = PROMPT_LOOP_GROUPS.findIndex(g => g.key === id);
                if (next >= 0) selectPromptGroup(next);
              }}
              ariaLabel="Prompt groups"
            />
            <label className="prompt-loops-group-select-wrap font-mono">
              <select
                className="tool-field prompt-loops-group-select"
                value={groupIndex}
                onChange={e => selectPromptGroup(Number(e.target.value))}
                aria-label="Prompt group"
              >
                {PROMPT_LOOP_GROUPS.map((g, index) => (
                  <option key={g.key} value={index}>{g.group}</option>
                ))}
              </select>
            </label>
          </div>
          <PaneList
            label="Prompts"
            items={items}
            getKey={item => item.id}
            cursorKey={activeItem?.id ?? null}
            onCursorChange={key => setItemId(key)}
            onActivate={() => focusPaneById("prompt-detail")}
            activateHint="compose"
            filter={{ value: query, onChange: setQuery, label: "Filter prompts", placeholder: "filter prompts" }}
            empty="no matching prompts"
            renderItem={item => (
              <>
                <span className="nm">{item.title}</span>
                <span className="meta">{String(itemNumbers.get(item.id) ?? 0).padStart(2, "0")}</span>
              </>
            )}
          />
        </Pane>

        <Pane
          id="prompt-detail"
          title="detail"
          label="Prompt detail"
          className="prompt-loops-detail-pane"
          bodyClassName="prompt-loops-detail-body"
        >
          {activeItem ? (
            <>
              <div className="prompt-loops-detail-head">
                <div className="prompt-loops-detail-text">
                  <h2 className="prompt-loops-detail-title">{activeItem.title}</h2>
                  <p className="prompt-loops-detail-meta text-muted">{activeItem.meta}</p>
                </div>
                <div className="prompt-loops-detail-aside">
                  <span className="prompt-loops-status" role="status">{status}</span>
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
              </div>

              <div className="prompt-loops-composer font-mono">
                <label className="prompt-loops-composer-field">
                  <span className="prompt-loops-composer-label">Repo context</span>
                  <select
                    className="tool-field prompt-loops-composer-select"
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
                    ref={taskContextRef}
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
                <pre
                  id="prompt-loops-active-prompt"
                  className="prompt-loops-prompt font-mono"
                  role="region"
                  aria-label="Composed prompt"
                  tabIndex={0}
                  data-pane-primary=""
                >
                  {composedPrompt}
                </pre>
              </div>
            </>
          ) : (
            <div className="prompt-loops-empty font-mono">select a prompt</div>
          )}
        </Pane>
      </div>
    </div>
  );
}
