import { useEffect, useMemo, useRef } from "react";
import { focusPaneById, listPanes, paneOf } from "../keyboard/focus";
import { useKeymap } from "../keyboard/useKeymap";
import type { Binding } from "../keyboard/registry";
import { redactTerminalOutput } from "../lib/redactTerminalOutput";
import { useNotify } from "../shell/ShellState";
import { Pane } from "../ui/Pane";
import { toneClass } from "../ui/tone";
import type { ActionResult, StatusData } from "../types";
import { ReadyState, TerminalState } from "./TerminalOutput";

export interface OutputPaneProps {
  /** `data-pane-id`; also anchors the pane's key hints. Default "output". */
  id?: string;
  wsRunning: string | null;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  status: StatusData | null;
  workspaceValid: boolean;
  gitAvailable: boolean;
  canRunReleaseCheck: boolean;
  /** `C`: clear the output. */
  onClear?: () => void;
  /** `r`: refresh status. */
  onRefresh?: () => void;
  /** Transaction the last install or uninstall left; offers `z`. */
  rollbackTransactionId?: string | null;
  /** `z`: roll back that transaction (dry run and confirm happen in the owner). */
  onRollback?: () => void;
}

/**
 * For the page that owns an OutputPane: when a new rollback transaction appears (an apply or uninstall just
 * finished) the output pane takes focus, so its result and `z` are in reach instead of dead behind the list
 * the closing review handed focus to. Focus the user placed on another pane is left alone, and a transaction
 * that was already there when the page mounted does nothing. Call it from a component that stays mounted
 * across the review (the page), not from OutputPane itself, which remounts with the review.
 */
export function useFocusOutputOnNewTransaction(transactionId: string | null | undefined, paneId = "output"): void {
  const seen = useRef(transactionId);
  useEffect(() => {
    const previous = seen.current;
    seen.current = transactionId;
    if (!transactionId || transactionId === previous) return;
    const active = document.activeElement;
    const activePane = active ? paneOf(active) : null;
    const panes = listPanes();
    const defaultPane = panes.find(pane => pane.hasAttribute("data-pane-default")) ?? panes[0];
    // Free: nothing holds focus, or it sits where the closing review left it (the page's default pane).
    const free = !active || active === document.body || active.closest(".topline") !== null || !activePane || activePane === defaultPane;
    if (free) focusPaneById(paneId);
  }, [transactionId, paneId]);
}

/** Redacted stdout + stderr, the text `y` copies. */
export function outputTextOf(log: ActionResult | null): string | null {
  if (!log) return null;
  const text = [redactTerminalOutput(log.stdout), redactTerminalOutput(log.stderr)].filter(Boolean).join("\n");
  return text || null;
}

function scrollPaneBody(id: string, to: "top" | "bottom") {
  const body = document.querySelector<HTMLElement>(`[data-pane-id="${id}"] .pane-body`);
  if (!body) return;
  body.scrollTo?.({ top: to === "top" ? 0 : body.scrollHeight });
}

/**
 * The terminal as a pane: `❯ action`, a status line, `── stdout ──`, then the text. Idle, it shows the
 * workspace context and the commands worth trying. Keys while it has focus: `y` copy, `C` clear,
 * `z` roll back the last transaction, `r` refresh, `g g` / `G` top and bottom.
 */
export function OutputPane({
  id = "output",
  wsRunning,
  wsLog,
  wsLogCompletedAt,
  status,
  workspaceValid,
  gitAvailable,
  canRunReleaseCheck,
  onClear,
  onRefresh,
  rollbackTransactionId,
  onRollback,
}: OutputPaneProps) {
  const notify = useNotify();
  // Redaction scans the whole log; do it once per log, not on every render.
  const text = useMemo(() => outputTextOf(wsLog), [wsLog]);
  const latest = useRef({ text, wsRunning, wsLog, rollbackTransactionId, onClear, onRefresh, onRollback });
  latest.current = { text, wsRunning, wsLog, rollbackTransactionId, onClear, onRefresh, onRollback };

  const bindings: Binding[] = [
    {
      id: `output.${id}.copy`,
      keys: "y",
      title: "Copy output",
      hint: "copy output",
      group: "Output",
      scope: "pane",
      paneId: id,
      when: () => latest.current.text !== null,
      run: () => {
        const value = latest.current.text;
        if (value === null) return false;
        void (async () => {
          try {
            await navigator.clipboard.writeText(value);
            notify("copied output");
          } catch {
            notify("copy failed: clipboard is not available");
          }
        })();
      },
    },
    {
      id: `output.${id}.clear`,
      keys: "C",
      title: "Clear output",
      hint: "clear",
      group: "Output",
      scope: "pane",
      paneId: id,
      when: () => (latest.current.onClear && latest.current.wsLog && !latest.current.wsRunning ? true : false),
      run: () => latest.current.onClear?.(),
    },
    {
      id: `output.${id}.rollback`,
      keys: "z",
      title: "Roll back the last transaction",
      hint: "rollback",
      group: "Output",
      scope: "pane",
      paneId: id,
      when: () => {
        if (!latest.current.rollbackTransactionId || !latest.current.onRollback) return false;
        return latest.current.wsRunning ? "a task is running" : true;
      },
      run: () => latest.current.onRollback?.(),
    },
    {
      id: `output.${id}.refresh`,
      keys: "r",
      title: "Refresh status",
      hint: "refresh",
      group: "Output",
      scope: "pane",
      paneId: id,
      when: () => (latest.current.onRefresh ? (latest.current.wsRunning ? "a task is running" : true) : false),
      run: () => latest.current.onRefresh?.(),
    },
    {
      id: `output.${id}.top`,
      keys: "g g",
      title: "Scroll to top",
      group: "Output",
      scope: "pane",
      paneId: id,
      run: () => scrollPaneBody(id, "top"),
    },
    {
      id: `output.${id}.bottom`,
      keys: "G",
      title: "Scroll to bottom",
      group: "Output",
      scope: "pane",
      paneId: id,
      run: () => scrollPaneBody(id, "bottom"),
    },
  ];
  useKeymap(bindings);

  const verdict = wsRunning
    ? { text: "running", tone: undefined }
    : wsLog
      ? { text: wsLog.success ? "ok" : "failed", tone: wsLog.success ? ("ok" as const) : ("fail" as const) }
      : { text: "ready", tone: undefined };
  const command = wsRunning ?? wsLog?.action.split(" ")[0];

  return (
    <Pane
      id={id}
      title="output"
      label="Output"
      scrollable
      meta={
        <>
          {"· "}
          {command ? `${command} · ` : null}
          <span className={toneClass(verdict.tone) || undefined}>{verdict.text}</span>
        </>
      }
    >
      <div className="out">
        <TerminalState
          runningLabel={wsRunning}
          result={wsLog}
          completedAt={wsLogCompletedAt ?? undefined}
          readyLabel="operations ready"
          idleContent={
            <>
              <ReadyState label="operations ready" />
              {status ? (
                <div className="tui-idle">
                  <span>
                    workspace: {workspaceValid ? "valid" : "invalid"}
                    {gitAvailable && ` · branch: ${status.branch}`}
                    {` · targets: ${status.enabled_rule_target_ids.length} rules, ${status.enabled_config_target_ids.length} configs`}
                  </span>
                  <span className="c-dim">
                    {canRunReleaseCheck
                      ? "try: :update <target> · :preview <target> · :release-check"
                      : "try: :update <target> · :preview <target>"}
                  </span>
                </div>
              ) : (
                <div className="tui-idle">
                  <span className="c-dim">waiting for workspace status…</span>
                </div>
              )}
            </>
          }
        />
      </div>
    </Pane>
  );
}
