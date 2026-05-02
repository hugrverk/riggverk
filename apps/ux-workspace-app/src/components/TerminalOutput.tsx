export interface ActionResult {
  success: boolean;
  action: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
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
  sectioned = true,
  showNoOutput = true,
}: {
  result: ActionResult;
  sectioned?: boolean;
  showNoOutput?: boolean;
}) {
  return (
    <>
      <div className={`log-status ${result.success ? "log-ok" : "log-fail"}`}>
        <span className="log-prompt">$</span> {result.action}: {result.success ? "OK" : "FAILED"}
        {result.exit_code !== null && ` (exit ${result.exit_code})`}
      </div>
      {sectioned ? (
        <>
          {result.stdout ? (
            <div className="log-section">
              <span className="log-section-label">STDOUT</span>
              <pre className="log-output">{result.stdout}</pre>
            </div>
          ) : null}
          {result.stderr ? (
            <div className="log-section">
              <span className="log-section-label">STDERR</span>
              <pre className="log-output log-stderr">{result.stderr}</pre>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {result.stdout && <pre className="log-output">{result.stdout}</pre>}
          {result.stderr && <pre className="log-output log-stderr">{result.stderr}</pre>}
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
  readyLabel,
  activityIndex,
  activityCellClass,
  sectioned = true,
  showNoOutput = true,
}: {
  runningLabel?: string | null;
  result?: ActionResult | null;
  readyLabel: string;
  activityIndex: number;
  activityCellClass: (index: number) => string;
  sectioned?: boolean;
  showNoOutput?: boolean;
}) {
  if (runningLabel) {
    return <RunningState label={runningLabel} activityIndex={activityIndex} activityCellClass={activityCellClass} />;
  }

  if (result) {
    return <ActionResultOutput result={result} sectioned={sectioned} showNoOutput={showNoOutput} />;
  }

  return <ReadyState label={readyLabel} />;
}
