import { useMemo } from "react";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import { useNotify } from "../../shell/ShellState";
import { TButton } from "../../ui/TButton";
import type { ActionResult, ApplyProgress } from "../../types";
import { TerminalState } from "../TerminalOutput";

/** Redacted stdout + stderr, the text Copy puts on the clipboard; null when the run printed nothing. */
export function runOutputText(log: ActionResult | null): string | null {
  if (!log) return null;
  const text = [redactTerminalOutput(log.stdout), redactTerminalOutput(log.stderr)].filter(Boolean).join("\n");
  return text || null;
}

export interface RunDetailsProps {
  wsRunning: string | null;
  progress?: ApplyProgress | null;
  wsLog: ActionResult | null;
  wsLogCompletedAt: number | null;
}

/**
 * The raw output of the run behind the "Details" disclosure: the log as `TerminalState` draws it (redacted: tokens,
 * keys and home folders never show) and a Copy button that copies the same redacted text. Mounted only while the
 * disclosure is open, so the redaction scan happens once per log and only when someone looks.
 */
export function RunDetails({ wsRunning, progress, wsLog, wsLogCompletedAt }: RunDetailsProps) {
  const notify = useNotify();
  const text = useMemo(() => runOutputText(wsLog), [wsLog]);
  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      notify("copied output");
    } catch {
      notify("Copy failed: clipboard is not available");
    }
  };
  return (
    <div className="run-details">
      <div className="run-log scroll-cue" role="group" aria-label="Output log" tabIndex={0}>
        <TerminalState
          runningLabel={wsRunning}
          result={wsLog}
          completedAt={wsLogCompletedAt ?? undefined}
          readyLabel="ready"
          progress={progress}
          idleContent={<div className="tui-noout">— nothing run yet —</div>}
          header={false}
        />
      </div>
      {text !== null && (
        <TButton keys={[]} onClick={() => void copy()}>
          Copy output
        </TButton>
      )}
    </div>
  );
}
