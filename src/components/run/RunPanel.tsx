import { useId, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import { focusPanePrimary, listPanes } from "../../keyboard/focus";
import { useKeymap } from "../../keyboard/useKeymap";
import type { Binding } from "../../keyboard/registry";
import { actionLabel } from "../../lib/actionLabel";
import { formatCheckedAt } from "../../shell/Sidebar";
import { StatePill } from "../../ui/StatePill";
import { TButton } from "../../ui/TButton";
import { cx } from "../../ui/tone";
import type { ActionResult, ApplyProgress } from "../../types";
import { Elapsed } from "../TerminalOutput";
import { RunDetails } from "./RunDetails";

export interface RunPanelProps {
  /** `data-pane-id`; the page hands focus to it when a run leaves a transaction. Default "output". */
  id?: string;
  wsRunning: string | null;
  /** What the backend last reported for the running task; null until it reports or when nothing runs. */
  progress?: ApplyProgress | null;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  /** Dismiss: clear the finished result. */
  onClear?: () => void;
  /** `r`: check again. */
  onRefresh?: () => void;
  /** Transaction the last install or uninstall left; offers Undo (`z`). */
  rollbackTransactionId?: string | null;
  /** Undo that transaction (the dry run and the confirm happen in the owner). */
  onRollback?: () => void;
  /** The visible receipt owns the actions for this outcome. */
  receiptOwnsActions?: boolean;
}

/** How the running task is going: a count and the current file, a phase word, or "working…" while there is nothing to count. */
function RunProgress({ progress }: { progress: ApplyProgress | null | undefined }) {
  const total = progress?.total ?? null;
  if (progress && progress.phase !== "backup" && total !== null && total > 0) {
    const ratio = Math.min(1, Math.max(0, progress.done / total));
    return (
      <>
        <span
          className="run-bar"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Math.min(progress.done, total)}
          aria-valuetext={`${progress.done} of ${total}`}
          style={{ "--p": `${Math.round(ratio * 100)}%` } as CSSProperties}
        >
          <i aria-hidden="true" />
        </span>
        <span className="run-count">{progress.done}/{total}</span>
        {progress.file && (
          <span className="run-file" title={progress.file}>
            {progress.file}
          </span>
        )}
      </>
    );
  }
  return <span className="run-file">{progress?.phase === "backup" ? "backing up…" : "working…"}</span>;
}

/**
 * What a run looks like on the page: while a task runs, its label with a hairline progress bar, the count and the
 * file in progress; once it ends, one line with the outcome (Done or Failed, in words), when it finished and the
 * actions that belong to it: Undo last update… (`z`, only when the run left a transaction), Details and Dismiss.
 * "Details" opens the redacted log with a Copy button; a failed run opens it by itself so the reason is in view.
 * Nothing is rendered before the first run. The receipt of a finished update (what changed, what was checked, what
 * was left for you, what was backed up) is the Last update cell and the History page, read from what the run recorded.
 *
 * It is a pane (`data-pane-id`), so `r` and Escape work with focus inside it; `z` is the app-wide Undo binding.
 */
export function RunPanel({
  id = "output",
  wsRunning,
  progress,
  wsLog,
  wsLogCompletedAt,
  onClear,
  onRefresh,
  rollbackTransactionId,
  onRollback,
  receiptOwnsActions = false,
}: RunPanelProps) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(() => wsLog !== null && !wsLog.success);
  // A new result starts closed, a failed one open. Done while rendering, from the log last seen, so it never paints
  // in the wrong state first.
  const [seenLog, setSeenLog] = useState<ActionResult | null>(wsLog);
  if (seenLog !== wsLog) {
    setSeenLog(wsLog);
    setExpanded(wsLog !== null && !wsLog.success);
  }

  const latest = useRef({ expanded, wsRunning, onRefresh });
  latest.current = { expanded, wsRunning, onRefresh };
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // The panel is about to disappear with the focused Dismiss button in it: hand focus to the page's default pane first.
  const dismiss = () => {
    const panes = listPanes().filter(pane => pane !== panelRef.current);
    const next = panes.find(pane => pane.hasAttribute("data-pane-default")) ?? panes[0];
    if (next) focusPanePrimary(next);
    onClear?.();
  };

  const collapse = () => {
    // The log is about to be hidden: keep focus in the panel rather than dropping it to the page.
    toggleRef.current?.focus();
    setExpanded(false);
  };
  const bindings: Binding[] = [
    {
      id: `runpanel.${id}.collapse`,
      keys: "Escape",
      title: "Close the run details",
      group: "Output",
      scope: "pane",
      paneId: id,
      // Inactive when closed, so Escape falls through to the global one (dismiss the error line).
      when: () => latest.current.expanded,
      run: collapse,
    },
    {
      id: `runpanel.${id}.refresh`,
      keys: "r",
      title: "Check again",
      hint: "check",
      group: "Output",
      scope: "pane",
      paneId: id,
      when: () => (latest.current.onRefresh ? (latest.current.wsRunning ? "a task is running" : true) : false),
      run: () => latest.current.onRefresh?.(),
    },
  ];
  useKeymap(bindings);

  if (!wsRunning && !wsLog) return null;

  // Clicking dead space inside the panel moves focus to its primary button so the pane's keys keep working.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    event.currentTarget.querySelector<HTMLElement>("[data-pane-primary]")?.focus();
  };

  const finished = !wsRunning && wsLog;
  const outcome = finished ? (wsLog.success ? "ok" : "fix") : null;
  return (
    <section
      ref={panelRef}
      className={cx("run-panel", wsRunning ? "is-running" : outcome === "fix" && "is-failed")}
      data-pane-id={id}
      data-keyscope="pane"
      aria-label="Run"
      tabIndex={-1}
      onFocus={onFocus}
    >
      <div className="run-line">
        {wsRunning ? (
          <>
            <span className="run-lbl" role="status">
              Running · <span className="run-cmd">{wsRunning}</span>
            </span>
            <RunProgress progress={progress} />
            <Elapsed />
          </>
        ) : (
          wsLog && (
            <span className="run-outcome" role="status">
              <StatePill state={outcome ?? "ok"}>{wsLog.success ? "Done" : "Failed"}</StatePill>
              <span className="run-cmd">{actionLabel(wsLog.action)}</span>
              {wsLogCompletedAt !== null && <span className="run-when">{formatCheckedAt(new Date(wsLogCompletedAt))}</span>}
            </span>
          )
        )}
        {finished && (
          <span className="run-actions">
            {!receiptOwnsActions && rollbackTransactionId && onRollback && (
              <TButton keys={["z"]} shortcut="z" onClick={onRollback}>
                Undo last update…
              </TButton>
            )}
            <button
              ref={toggleRef}
              type="button"
              className="tbtn"
              data-pane-primary=""
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(open => !open)}
            >
              <span className="tbtn-label">Details</span>
            </button>
            {!receiptOwnsActions && onClear && (
              <TButton keys={[]} onClick={dismiss}>
                Dismiss
              </TButton>
            )}
          </span>
        )}
      </div>
      <div id={detailsId} hidden={!(finished && expanded)}>
        {finished && expanded && <RunDetails wsRunning={wsRunning} progress={progress} wsLog={wsLog} wsLogCompletedAt={wsLogCompletedAt} />}
      </div>
    </section>
  );
}
