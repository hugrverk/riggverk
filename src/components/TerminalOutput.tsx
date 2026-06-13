import { redactTerminalOutput } from "../lib/redactTerminalOutput";

export interface ActionResult {
  success: boolean;
  action: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return "earlier";
}

export function ActivityLoader({
  activityIndex,
  activityCellClass,
  idle = false,
}: {
  activityIndex: number;
  activityCellClass: (index: number) => string;
  idle?: boolean;
}) {
  void activityIndex;
  return (
    <div
      className={`terminal-activity${idle ? " terminal-activity-idle" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: 8 }, (_, i) => <span key={i} className={activityCellClass(i)} />)}
    </div>
  );
}

export function RunningState({
  label,
  activityIndex,
  activityCellClass,
}: {
  label: string;
  activityIndex: number;
  activityCellClass: (index: number) => string;
}) {
  return (
    <>
      <div className="tui-cmdline tui-running">
        <span className="log-prompt">❯</span>
        <span className="tui-cmd">{label}</span>
        <span className="tui-caret" aria-hidden="true" />
      </div>
      <div className="tui-progress" role="status" aria-label={`${label} running`}>
        <ActivityLoader activityIndex={activityIndex} activityCellClass={activityCellClass} />
        <span className="tui-progress-label">working…</span>
      </div>
    </>
  );
}

export function ReadyState({ label }: { label: string }) {
  return (
    <div className="tui-cmdline log-empty">
      <span className="log-prompt">❯</span>
      <span className="tui-cmd">{label}</span>
    </div>
  );
}

export function ActionResultOutput({
  result,
  completedAt,
  sectioned = true,
  showNoOutput = true,
}: {
  result: ActionResult;
  completedAt?: number;
  sectioned?: boolean;
  showNoOutput?: boolean;
}) {
  const safeStdout = redactTerminalOutput(result.stdout);
  const safeStderr = redactTerminalOutput(result.stderr);
  const redacted = safeStdout !== result.stdout || safeStderr !== result.stderr;

  return (
    <>
      <div className="tui-cmdline">
        <span className="log-prompt">❯</span>
        <span className="tui-cmd">{result.action}</span>
        {completedAt !== undefined && (
          <span className="tui-when">{relativeTime(completedAt)}</span>
        )}
      </div>
      <div
        className={`tui-statusline ${result.success ? "tui-statusline-ok" : "tui-statusline-fail"}`}
      >
        <span className="tui-status-mark" aria-hidden="true">{result.success ? "✓" : "✗"}</span>
        <span className="tui-status-text">
          {result.success ? "completed" : "failed"}
          {result.exit_code !== null && ` · exit ${result.exit_code}`}
          {redacted && " · output redacted"}
        </span>
      </div>
      {sectioned ? (
        <>
          {result.stdout ? (
            <div className="tui-block">
              <span className="tui-block-label">stdout</span>
              <pre className="log-output">{safeStdout}</pre>
            </div>
          ) : null}
          {result.stderr ? (
            <div className="tui-block tui-block-fail">
              <span className="tui-block-label">stderr</span>
              <pre className="log-output log-stderr">{safeStderr}</pre>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {result.stdout && <pre className="log-output">{safeStdout}</pre>}
          {result.stderr && <pre className="log-output log-stderr">{safeStderr}</pre>}
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
  activityIndex,
  activityCellClass,
  sectioned = true,
  showNoOutput = true,
}: {
  runningLabel?: string | null;
  result?: ActionResult | null;
  completedAt?: number;
  readyLabel: string;
  idleContent?: React.ReactNode;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  sectioned?: boolean;
  showNoOutput?: boolean;
}) {
  if (runningLabel) {
    return <RunningState label={runningLabel} activityIndex={activityIndex} activityCellClass={activityCellClass} />;
  }

  if (result) {
    return <ActionResultOutput result={result} completedAt={completedAt} sectioned={sectioned} showNoOutput={showNoOutput} />;
  }

  if (idleContent) {
    return <>{idleContent}</>;
  }

  return <ReadyState label={readyLabel} />;
}
