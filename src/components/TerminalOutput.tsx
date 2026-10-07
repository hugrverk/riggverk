import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { actionLabel } from "../lib/actionLabel";
import { applyOutputLineTone } from "../lib/installPlan";
import { useMotion, type MotionLevel } from "../lib/motion";
import { redactTerminalOutput } from "../lib/redactTerminalOutput";
import { Glyph } from "../ui/Glyph";
import { cx, toneClass } from "../ui/tone";
import type { ActionResult, ApplyProgress } from "../types";

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

/**
 * Owns its animation tick so only this small component re-renders while a task runs. A span, so it can sit inside a button.
 * Motion "off" (the setting or the OS preference) is the idle loader: no tick, a static dim row.
 */
export function ActivityLoader({ idle = false }: { idle?: boolean }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const motion = useMotion();
  const still = idle || motion === "off";

  useEffect(() => {
    if (still) return;
    const id = window.setInterval(() => setActiveIndex(i => (i + 1) % ACTIVITY_CELLS), ACTIVITY_STEP_MS);
    return () => window.clearInterval(id);
  }, [still]);

  return (
    <span
      className={`terminal-activity${still ? " terminal-activity-idle" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: ACTIVITY_CELLS }, (_, i) => <span key={i} className={activityCellClass(i, activeIndex)} />)}
    </span>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_STEP_MS = 100;

/** One braille cell that turns while a task runs; a still `·` when motion is off. Decorative: the task text says "running". */
export function Spinner() {
  const [frame, setFrame] = useState(0);
  const still = useMotion() === "off";

  useEffect(() => {
    if (still) return;
    const id = window.setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), SPINNER_STEP_MS);
    return () => window.clearInterval(id);
  }, [still]);

  return (
    <span className="g spin" aria-hidden="true">
      {still ? "·" : SPINNER_FRAMES[frame]}
    </span>
  );
}

/** "1.2s" while motion runs (100 ms ticks); whole seconds, ticking once a second, when it is off. */
export function formatElapsed(ms: number, motion: MotionLevel): string {
  return motion === "off" ? `${Math.floor(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** Time since it mounted. Decorative for assistive technology: a counter that changes ten times a second is not announced. */
export function Elapsed() {
  const motion = useMotion();
  const [start] = useState(() => Date.now());
  const [ms, setMs] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setMs(Date.now() - start), motion === "off" ? 1000 : 100);
    return () => window.clearInterval(id);
  }, [motion, start]);

  return (
    <span className="elapsed" aria-hidden="true">
      {formatElapsed(ms, motion)}
    </span>
  );
}

const PROGRESS_CELLS = 10;

/**
 * Ten character cells, the fill clipped to `done / total`: `██████░░░░`. The fill moves with a 160 ms clip-path
 * transition; the stylesheet turns transitions off for motion "off", so the bar jumps there.
 */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const cells = (glyph: string) => Array.from({ length: PROGRESS_CELLS }, (_, i) => <span key={i} className="g">{glyph}</span>);
  return (
    <span
      className={cx("pbar", ratio >= 1 && "done")}
      role="progressbar"
      aria-label="Progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(done, total)}
      aria-valuetext={`${done} of ${total}`}
      style={{ "--p": `${Math.round(ratio * 100)}%` } as CSSProperties}
    >
      <span className="track" aria-hidden="true">{cells("░")}</span>
      <span className="fill" aria-hidden="true">{cells("█")}</span>
    </span>
  );
}

/** What a progress event says to show: a bar with its count and file, or only a phase word (no total yet, or backing up). */
function readProgress(progress: ApplyProgress | null | undefined) {
  const total = progress?.total ?? null;
  const counted = progress !== null && progress !== undefined && progress.phase !== "backup" && total !== null && total > 0;
  return {
    bar: counted ? { done: progress.done, total } : null,
    file: progress?.file ?? null,
    backingUp: progress?.phase === "backup",
  };
}

/**
 * The strip line's middle while a task runs: `[██████░░░░] 4/7 skills/handoff/SKILL.md`, or the loader and a phase
 * word (`backing up…`, `working…`) while there is nothing to count. The file is ellipsized, never wrapped.
 * `loader` false drops the loader when the open log below already shows one.
 */
export function RunningProgress({ progress, loader = true }: { progress?: ApplyProgress | null; loader?: boolean }) {
  const { bar, file, backingUp } = readProgress(progress);
  if (bar) {
    return (
      <>
        <ProgressBar done={bar.done} total={bar.total} />
        <span className="c-dim pcount">{bar.done}/{bar.total}</span>
        {file && <span className="c-dim pfile" title={file}>{file}</span>}
      </>
    );
  }
  return (
    <>
      {loader && <ActivityLoader />}
      <span className="c-dim pfile">{backingUp ? "backing up…" : "working…"}</span>
    </>
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

const WRITTEN_FILES_CAP = 40;

interface WrittenFile {
  /** Counts up for the whole task, so a line keeps its key (and does not animate again) when older ones drop off. */
  id: number;
  file: string;
}

/** The files of the running task, each appended as the backend reports it; only the latest are kept. */
function useWrittenFiles(progress: ApplyProgress | null | undefined): WrittenFile[] {
  const [written, setWritten] = useState<{ files: WrittenFile[]; last: string | null; count: number }>({
    files: [],
    last: null,
    count: 0,
  });
  const file = progress?.phase === "apply" ? progress.file : null;
  // Derived while rendering, so a file never paints a frame late.
  if (file && file !== written.last) {
    setWritten({
      files: [...written.files.slice(1 - WRITTEN_FILES_CAP), { id: written.count, file }],
      last: file,
      count: written.count + 1,
    });
  }
  return written.files;
}

/**
 * `header` false leaves out the `❯ command` line, for a host that already shows it (the output strip's own line).
 * `progress` is what the backend last reported: the log names the count and file in progress and the time so far,
 * and lists the files as they are written. Only the label sits in the live region; the changing numbers do not.
 */
export function RunningState({
  label,
  header = true,
  progress = null,
}: {
  label: string;
  header?: boolean;
  progress?: ApplyProgress | null;
}) {
  const { bar, file, backingUp } = readProgress(progress);
  const detail = bar ? `${bar.done}/${bar.total}${file ? ` · ${file}` : ""}` : backingUp ? "backing up" : null;
  const files = useWrittenFiles(progress);
  return (
    <>
      {header && <CommandLine label={label} caret />}
      <div className="tui-progress" role="status" aria-label={`${label} running`}>
        <ActivityLoader />
        <span className="tui-progress-label">
          working…
          <span aria-hidden="true">
            {detail && ` · ${detail}`}
            {" · "}
            <Elapsed />
          </span>
        </span>
      </div>
      {files.length > 0 && (
        <pre className="tui-out c-dim tui-tail" aria-label="Files written">
          {files.map(entry => (
            <span key={entry.id} className="tail-line">
              {entry.file}
            </span>
          ))}
        </pre>
      )}
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
  progress = null,
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
  /** What the backend last reported for the running task. */
  progress?: ApplyProgress | null;
}) {
  if (runningLabel) {
    return <RunningState key={runningLabel} label={runningLabel} header={header} progress={progress} />;
  }

  if (result) {
    return <ActionResultOutput result={result} completedAt={completedAt} sectioned={sectioned} showNoOutput={showNoOutput} header={header} />;
  }

  if (idleContent) {
    return <>{idleContent}</>;
  }

  return <ReadyState label={readyLabel} />;
}
