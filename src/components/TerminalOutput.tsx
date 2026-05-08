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
}: {
  activityIndex: number;
  activityCellClass: (index: number) => string;
}) {
  void activityIndex;
  return (
    <div className="terminal-activity" aria-hidden="true">
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
      <div className="log-running"><span className="log-prompt">$</span> {label}…</div>
      <ActivityLoader activityIndex={activityIndex} activityCellClass={activityCellClass} />
    </>
  );
}

export function ReadyState({ label }: { label: string }) {
  return <div className="log-empty"><span className="log-prompt">$</span> {label}</div>;
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
      <div className={`log-status ${result.success ? "log-ok" : "log-fail"}`}>
        <span className="log-prompt">$</span> {result.action}: {result.success ? "OK" : "FAILED"}
        {result.exit_code !== null && ` (exit ${result.exit_code})`}
        {completedAt !== undefined && (
          <span className="log-status-when"> &middot; {relativeTime(completedAt)}</span>
        )}
        {redacted && <span className="log-status-when"> &middot; output redacted</span>}
      </div>
      {sectioned ? (
        <>
          {result.stdout ? (
            <div className="log-section">
              <span className="log-section-label">STDOUT</span>
              <pre className="log-output">{safeStdout}</pre>
            </div>
          ) : null}
          {result.stderr ? (
            <div className="log-section">
              <span className="log-section-label">STDERR</span>
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
        <div className="log-no-output"><span className="log-prompt">$</span> no output</div>
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
