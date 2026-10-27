import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { focusPaneById, listPanes, paneOf } from "../keyboard/focus";
import { useKeymap } from "../keyboard/useKeymap";
import type { Binding } from "../keyboard/registry";
import { actionLabel } from "../lib/actionLabel";
import { useMotion } from "../lib/motion";
import { redactTerminalOutput } from "../lib/redactTerminalOutput";
import { useNotify } from "../shell/ShellState";
import { BindingButton } from "../ui/BindingActionKey";
import { Glyph } from "../ui/Glyph";
import { Kbd } from "../ui/Kbd";
import { cx } from "../ui/tone";
import type { ActionResult, ApplyProgress, StatusData } from "../types";
import { completedLabel, Elapsed, RunningProgress, Spinner, TerminalState } from "./TerminalOutput";

export interface OutputStripProps {
  /** `data-pane-id`; also anchors the strip's key hints. Default "output". */
  id?: string;
  wsRunning: string | null;
  /** What the backend last reported for the running task; null until it reports or when nothing runs. */
  progress?: ApplyProgress | null;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
  status: StatusData | null;
  dataFolderOk: boolean;
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
 * For the page that owns an output strip: when a new rollback transaction appears (an apply or uninstall just
 * finished) the strip takes focus, so its result and `z` are in reach instead of dead behind the list
 * the closing review handed focus to. Focus the user placed on another pane is left alone, and a transaction
 * that was already there when the page mounted does nothing. Call it from a component that stays mounted
 * across the review (the page), not from OutputStrip itself, which remounts with the review.
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

/** A result this young when the strip mounts still counts as having just landed. */
const FRESH_RESULT_MS = 1500;

/** Transaction ids are nanosecond timestamps; the tail is what tells two of them apart. */
function shortTransactionId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id;
}

function scrollLogTo(log: HTMLElement | null, to: "top" | "bottom") {
  log?.scrollTo?.({ top: to === "top" ? 0 : log.scrollHeight });
}

/**
 * The terminal as a one-line strip under the page's panes: `❯ ready · workspace valid`, a running
 * task with its progress, or the last result with its rollback button. It expands into the full log
 * (`TerminalState`) while a task runs and when a result arrives; `↵` on the line toggles it, `esc` collapses,
 * otherwise the user's toggle wins. Under full motion a result that lands pops its ✓ and fades the border from ok.
 * Keys while it has focus: `y` copy, `C` clear, `z` roll back the last transaction, `r` refresh, `g g` / `G`
 * top and bottom of the log.
 *
 * It is a pane (`section.pane[data-pane-id]`, reachable with `h`/`l`) without a title or footer; its hints show
 * in the status bar like any pane's. The line is a toggle button with the rollback button as its sibling (buttons
 * never nest). Enter on the toggle is the button's own click; the Enter binding covers the rest of the pane and the
 * status-bar hint.
 */
export function OutputStrip({
  id = "output",
  wsRunning,
  progress,
  wsLog,
  wsLogCompletedAt,
  status,
  dataFolderOk,
  onClear,
  onRefresh,
  rollbackTransactionId,
  onRollback,
}: OutputStripProps) {
  const notify = useNotify();
  const logId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<"top" | "bottom" | null>(null);

  // Open on mount only for a task in flight. A result that is already there stays one line.
  const [expanded, setExpanded] = useState(() => Boolean(wsRunning));
  // A run starting or a new result arriving opens the log. Done while rendering, from the props last seen, so
  // the strip never paints collapsed for a frame first.
  const [seen, setSeen] = useState({ running: wsRunning, log: wsLog });
  if (seen.running !== wsRunning || seen.log !== wsLog) {
    setSeen({ running: wsRunning, log: wsLog });
    if ((wsRunning && !seen.running) || (wsLog && wsLog !== seen.log)) setExpanded(true);
  }

  // The result on screen: a task in flight hides the previous one. One that lands while the strip is mounted, or
  // that is only seconds old when it mounts (the page swaps the review for its panes, and remounts the strip, as the
  // task ends), is flagged once, in full motion only; the animation clears the flag. A strip that mounts onto an
  // older result stays calm. Done while rendering, like `seen`, so the first painted frame already carries it.
  const motion = useMotion();
  const shown = wsRunning ? null : wsLog;
  const [shownSeen, setShownSeen] = useState(shown);
  const [landed, setLanded] = useState<ActionResult | null>(() =>
    shown?.success && motion === "full" && wsLogCompletedAt !== null && Date.now() - wsLogCompletedAt < FRESH_RESULT_MS ? shown : null,
  );
  if (shownSeen !== shown) {
    setShownSeen(shown);
    if (shown?.success && motion === "full") setLanded(shown);
  }
  const justDone = landed !== null && landed === shown;

  // Redaction scans the whole log; do it once per log, not on every render.
  const text = useMemo(() => outputTextOf(wsLog), [wsLog]);
  const latest = useRef({ text, expanded, wsRunning, wsLog, rollbackTransactionId, onClear, onRefresh, onRollback });
  latest.current = { text, expanded, wsRunning, wsLog, rollbackTransactionId, onClear, onRefresh, onRollback };

  useEffect(() => {
    if (!expanded) return;
    // A stacked page scrolls, and the strip sits at its end: bring the log it just opened into view.
    paneRef.current?.scrollIntoView?.({ block: "nearest" });
    // `g g` / `G` on a collapsed strip open it first; the scroll waits for the log to exist.
    if (pendingScroll.current) scrollLogTo(logRef.current, pendingScroll.current);
    pendingScroll.current = null;
  }, [expanded]);

  const collapse = () => {
    // The log is about to be hidden: keep focus in the strip rather than dropping it to the page.
    if (logRef.current?.contains(document.activeElement)) lineRef.current?.focus();
    setExpanded(false);
  };
  const toggle = () => (latest.current.expanded ? collapse() : setExpanded(true));
  const scrollTo = (to: "top" | "bottom") => {
    if (latest.current.expanded) {
      scrollLogTo(logRef.current, to);
      return;
    }
    pendingScroll.current = to;
    setExpanded(true);
  };

  // The rollback button beside the result runs this very binding.
  const rollbackBinding: Binding = {
    id: `outstrip.${id}.rollback`,
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
  };

  const bindings: Binding[] = [
    {
      id: `outstrip.${id}.toggle`,
      keys: "Enter",
      title: "Expand or collapse the output",
      hint: expanded ? "collapse" : "expand",
      group: "Output",
      scope: "pane",
      paneId: id,
      run: toggle,
    },
    {
      id: `outstrip.${id}.collapse`,
      keys: "Escape",
      title: "Collapse the output",
      group: "Output",
      scope: "pane",
      paneId: id,
      // Inactive when collapsed, so Escape falls through to the global one (dismiss the error line).
      when: () => latest.current.expanded,
      run: collapse,
    },
    {
      id: `outstrip.${id}.copy`,
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
      id: `outstrip.${id}.clear`,
      keys: "C",
      title: "Clear output",
      hint: "clear",
      group: "Output",
      scope: "pane",
      paneId: id,
      when: () => (latest.current.onClear && latest.current.wsLog && !latest.current.wsRunning ? true : false),
      run: () => latest.current.onClear?.(),
    },
    rollbackBinding,
    {
      id: `outstrip.${id}.refresh`,
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
      id: `outstrip.${id}.top`,
      keys: "g g",
      title: "Scroll output to top",
      group: "Output",
      scope: "pane",
      paneId: id,
      run: () => scrollTo("top"),
    },
    {
      id: `outstrip.${id}.bottom`,
      keys: "G",
      title: "Scroll output to bottom",
      group: "Output",
      scope: "pane",
      paneId: id,
      run: () => scrollTo("bottom"),
    },
  ];
  useKeymap(bindings);

  // Clicking dead space inside the strip moves focus to the line so the pane's keys keep working.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    event.currentTarget.querySelector<HTMLElement>("[data-pane-primary]")?.focus();
  };

  let summary: ReactNode;
  if (wsRunning) {
    summary = (
      <>
        <Glyph name="prompt" tone="acc" />
        <span className="outstrip-text">
          <span className="outstrip-cmd">{wsRunning}</span>
        </span>
        {/* Expanded, the log below shows its own loader. */}
        <RunningProgress progress={progress} loader={!expanded} />
        <Spinner />
        <Elapsed />
        <span className="c-dim">running</span>
      </>
    );
  } else if (wsLog) {
    summary = (
      <>
        <Glyph name={wsLog.success ? "check" : "fail"} tone={wsLog.success ? "ok" : "fail"} className={wsLog.success ? "tick" : undefined} />
        <span className="outstrip-text">
          <span className="outstrip-cmd">{actionLabel(wsLog.action)}</span>{" "}
          <span className="c-dim">
            · {wsLog.success ? "ok" : "failed"}
            {wsLogCompletedAt !== null && ` · ${completedLabel(wsLogCompletedAt)}`}
          </span>
        </span>
      </>
    );
  } else {
    summary = (
      <>
        <Glyph name="prompt" tone="acc" />
        <span className="outstrip-text">
          <span className="outstrip-cmd">ready</span>{" "}
          <span className="c-dim">
            {status
              ? `· workspace ${dataFolderOk ? "valid" : "invalid"}`
              : "· waiting for workspace status…"}
          </span>
        </span>
      </>
    );
  }

  // The rollback offer belongs to the result: a sibling button beside the line's toggle, never inside it.
  const rollback = !wsRunning && wsLog && rollbackTransactionId && (
    <BindingButton binding={rollbackBinding} label={`rollback ${shortTransactionId(rollbackTransactionId)}`} />
  );

  return (
    <section
      ref={paneRef}
      className={cx("pane", "outstrip", justDone && "just-done")}
      data-pane-id={id}
      data-keyscope="pane"
      aria-label="Output"
      tabIndex={-1}
      onFocus={onFocus}
      onAnimationEnd={event => {
        // The border fade is the last of the success animations; the check's pop finishes inside it.
        if (event.animationName === "outstrip-ok-fade") setLanded(null);
      }}
    >
      <div className="outstrip-line">
        <button
          ref={lineRef}
          type="button"
          className="outstrip-toggle"
          tabIndex={0}
          data-pane-primary=""
          aria-expanded={expanded}
          aria-controls={logId}
          onClick={toggle}
        >
          {summary}
        </button>
        {rollback}
        {/* A mouse-only second target for the toggle; the button beside it is the accessible one. */}
        <span className="outstrip-affordance" aria-hidden="true" onClick={toggle}>
          <Kbd>{expanded ? "esc" : "↵"}</Kbd> {expanded ? "collapse" : "expand"}
        </span>
      </div>
      <div
        id={logId}
        ref={logRef}
        className="outstrip-log scroll-cue"
        role="group"
        aria-label="Output log"
        tabIndex={expanded ? 0 : undefined}
        hidden={!expanded}
      >
        {expanded && (
          // The line above already names the command and when it ran; the log starts at the verdict.
          <TerminalState
            runningLabel={wsRunning}
            result={wsLog}
            completedAt={wsLogCompletedAt ?? undefined}
            readyLabel="ready"
            progress={progress}
            idleContent={<div className="tui-noout">— nothing run yet —</div>}
            header={false}
          />
        )}
      </div>
    </section>
  );
}
