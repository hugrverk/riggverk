import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { actionLabel } from "../lib/actionLabel";
import { applyOutputLineTone } from "../lib/installPlan";
import { redactTerminalOutput } from "../lib/redactTerminalOutput";
import { Glyph } from "../ui/Glyph";
import { toneClass } from "../ui/tone";
import type { ActionResult } from "../types";

// Re-exported so existing component-level imports keep working; the type lives in `types.ts`.
export type { ActionResult };

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return "earlier";
}

/** "08:29:04 · 2m ago": the clock time of the run and how long ago it was. */
export function completedLabel(ts: number): string {
  const clock = new Date(ts).toLocaleTimeString("sv-SE", { hour12: false });
  return `${clock} · ${relativeTime(ts)}`;
}

const ACTIVITY_CELLS = 8;
const ACTIVITY_STEP_MS = 110;

function activityCellClass(index: number, activeIndex: number): string {
  const distance = (index - activeIndex + ACTIVITY_CELLS) % ACTIVITY_CELLS;
  if (distance === 0) return "terminal-activity-cell terminal-activity-cell-active";
  if (distance === 1 || distance === ACTIVITY_CELLS - 1) return "terminal-activity-cell terminal-activity-cell-mid";
  if (distance === 2 || distance === ACTIVITY_CELLS - 2) return "terminal-activity-cell terminal-activity-cell-low";
  return "terminal-activity-cell";
}

/** Owns its animation tick so only this small component re-renders while a task runs. A span, so it can sit inside a button. */
export function ActivityLoader({ idle = false }: { idle?: boolean }) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (idle) return;
    const id = window.setInterval(() => setActiveIndex(i => (i + 1) % ACTIVITY_CELLS), ACTIVITY_STEP_MS);
    return () => window.clearInterval(id);
  }, [idle]);

  return (
    <span
      className={`terminal-activity${idle ? " terminal-activity-idle" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: ACTIVITY_CELLS }, (_, i) => <span key={i} className={activityCellClass(i, activeIndex)} />)}
    </span>
  );
}

/** `── stdout ──────`: a labelled rule. The rule is drawn by CSS; the label stays text. */
function OutputBar({ label, tone }: { label: string; tone?: "fail" }) {
  return (
    <div className={`tui-bar${tone ? ` ${toneClass(tone)}` : ""}`}>
      <span aria-hidden="true">── </span>
      <span>{label}</span>
      <span className="tui-bar-rule" aria-hidden="true" />
    </div>
  );
}

/** Lines written by an apply get a tone per leading word; other output stays plain. */
function OutputText({ text, action, className }: { text: string; action: string; className?: string }) {
  const toned = action.startsWith("apply_setup");
  const lines = text.split("\n");
  return (
    <pre className={`tui-out${className ? ` ${className}` : ""}`}>
      {lines.map((line, index) => {
        const tone = toned ? applyOutputLineTone(line) : null;
        const content: ReactNode = tone ? <span className={toneClass(tone)}>{line}</span> : line;
        return (
          <Fragment key={index}>
            {content}
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        );
      })}
    </pre>
  );
}

function CommandLine({ label, caret, when }: { label: string; caret?: boolean; when?: string }) {
  return (
    <div className="tui-cmdline">
      <Glyph name="prompt" tone="acc" />
      <span className="tui-cmd">{label}</span>
      {caret && <span className="tui-caret" aria-hidden="true" />}
      {when && <span className="tui-when">{when}</span>}
    </div>
  );
}

/** `header` false leaves out the `❯ command` line, for a host that already shows it (the output strip's own line). */
export function RunningState({ label, header = true }: { label: string; header?: boolean }) {
  return (
    <>
      {header && <CommandLine label={label} caret />}
      <div className="tui-progress" role="status" aria-label={`${label} running`}>
        <ActivityLoader />
        <span className="tui-progress-label">working…</span>
      </div>
    </>
  );
}

export function ReadyState({ label }: { label: string }) {
  return <CommandLine label={label} caret />;
}

export function ActionResultOutput({
  result,
  completedAt,
  sectioned = true,
  showNoOutput = true,
  header = true,
}: {
  result: ActionResult;
  completedAt?: number;
  sectioned?: boolean;
  showNoOutput?: boolean;
  /** The `❯ command · when` line; off for a host that already shows it (the output strip's own line). */
  header?: boolean;
}) {
  const [safeStdout, safeStderr] = useMemo(
    () => [redactTerminalOutput(result.stdout), redactTerminalOutput(result.stderr)],
    [result.stdout, result.stderr],
  );
  const redacted = safeStdout !== result.stdout || safeStderr !== result.stderr;

  return (
    <>
      {header && <CommandLine label={actionLabel(result.action)} when={completedAt !== undefined ? completedLabel(completedAt) : undefined} />}
      <div className={`tui-statusline ${result.success ? "c-ok" : "c-fail"}`}>
        <Glyph name={result.success ? "check" : "fail"} />
        <span className="tui-status-text">
          {result.success ? "completed" : "failed"}
          {result.exit_code !== null && ` · exit ${result.exit_code}`}
          {redacted && " · output redacted"}
        </span>
      </div>
      {sectioned ? (
        <>
          {result.stdout ? (
            <>
              <OutputBar label="stdout" />
              <OutputText text={safeStdout} action={result.action} />
            </>
          ) : null}
          {result.stderr ? (
            <>
              <OutputBar label="stderr" tone="fail" />
              <OutputText text={safeStderr} action={result.action} className="c-fail" />
            </>
          ) : null}
        </>
      ) : (
        <>
          {result.stdout && <OutputText text={safeStdout} action={result.action} />}
          {result.stderr && <OutputText text={safeStderr} action={result.action} className="c-fail" />}
        </>
      )}
      {showNoOutput && !result.stdout && !result.stderr && (
        <div className="tui-noout">— no output —</div>
      )}
    </>
  );
}

export function TerminalState({
  runningLabel,
  result,
  completedAt,
  readyLabel,
  idleContent,
  sectioned = true,
  showNoOutput = true,
  header = true,
}: {
  runningLabel?: string | null;
  result?: ActionResult | null;
  completedAt?: number;
  readyLabel: string;
  idleContent?: ReactNode;
  sectioned?: boolean;
  showNoOutput?: boolean;
  /** The `❯ command` line of the running and finished states; off when the host shows the command itself. */
  header?: boolean;
}) {
  if (runningLabel) {
    return <RunningState label={runningLabel} header={header} />;
  }

  if (result) {
    return <ActionResultOutput result={result} completedAt={completedAt} sectioned={sectioned} showNoOutput={showNoOutput} header={header} />;
  }

  if (idleContent) {
    return <>{idleContent}</>;
  }

  return <ReadyState label={readyLabel} />;
}
