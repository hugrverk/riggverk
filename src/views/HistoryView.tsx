import { useId, useState } from "react";
import { Receipt } from "../components/run/Receipt";
import { useHistory } from "../hooks/useHistory";
import { dataFolderUnknownSentence, type DataFolderVerdict } from "../lib/installationView";
import { receiptLines, runMetaText, runPill, runTitle } from "../lib/lastUpdate";
import type { SetupHistoryEntry } from "../types";
import { StatePill } from "../ui/StatePill";
import { TButton } from "../ui/TButton";
import { cx } from "../ui/tone";

export interface HistoryViewProps {
  /** Without a usable workspace folder there is no backup root to read the history from. */
  dataFolderOk: boolean;
  dataFolderVerdict?: DataFolderVerdict;
  /** Backups on disk, for the Backup line. */
  backupCount: number | null;
  /** Label of the workspace task in flight, or null. */
  wsRunning: string | null;
  /** Changes when an apply, uninstall or rollback finishes; the list is read again then. */
  wsLogCompletedAt: number | null;
  /** Starts the undo of a run: a dry run, then a confirm, then the rollback. Nothing is written before the confirm. */
  onUndo: (transactionId: string) => void;
}

interface RunRowProps {
  entry: SetupHistoryEntry;
  open: boolean;
  backupCount: number | null;
  /** The run Undo is offered on, or null; only one run in the list ever has it. */
  undoTarget: string | null;
  undoDisabled: string | false;
  onToggle: () => void;
  onUndo: (transactionId: string) => void;
}

function RunRow({ entry, open, backupCount, undoTarget, undoDisabled, onToggle, onUndo }: RunRowProps) {
  const bodyId = useId();
  const pill = runPill(entry);
  return (
    <li className={cx("hist-run", open && "is-open")}>
      <button type="button" className="hist-run-h" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="hist-run-t">
          <b>{runTitle(entry)}</b>
          <span>{runMetaText(entry)}</span>
        </span>
        <StatePill state={pill.state}>{pill.text}</StatePill>
        <span className="hist-chev" aria-hidden="true" />
      </button>
      <div id={bodyId} className="hist-body" role="region" aria-label={`Receipt: ${runTitle(entry)}`}>
        <div className="hist-inner">
          <Receipt lines={receiptLines(entry, backupCount)} />
          {undoTarget === entry.transaction_id && (
            <TButton keys={[]} disabled={undoDisabled} onClick={() => onUndo(entry.transaction_id)}>
              Undo this update…
            </TButton>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Every update of this workspace, newest first, read from the transaction manifests on disk so the list is complete
 * after a restart: a joined list in which each run opens to its receipt (what changed, what was checked, what was left
 * for the user, what was backed up), from what the run recorded and nothing more. Undo is offered on one run only,
 * the newest completed one (the backend's `undoable`), and starts the same dry run and confirm as `z`; nothing is
 * written before the confirm. The page writes nothing itself.
 */
export function HistoryView({ dataFolderOk, dataFolderVerdict, backupCount, wsRunning, wsLogCompletedAt, onUndo }: HistoryViewProps) {
  const history = useHistory({
    enabled: dataFolderOk,
    // A finished apply, uninstall or rollback changes the history; so does starting and ending a task.
    refreshKey: `${wsLogCompletedAt ?? 0}:${wsRunning ? "run" : "idle"}`,
  });
  // The newest run starts open; a choice the user made wins.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const undoDisabled = wsRunning ? `${wsRunning} is running` : false;

  let body;
  if (!dataFolderOk) {
    body = <p className="hist-note">{dataFolderUnknownSentence(dataFolderVerdict) ?? "History is read from the workspace folder, which Riggverk can't use right now. The Overview says why."}</p>;
  } else if (history.status === "loading") {
    body = <p className="hist-note" role="status">Reading the history…</p>;
  } else if (history.status === "error") {
    body = <p className="hist-note" role="alert">Couldn't read the history. Open the page again to retry.</p>;
  } else if (history.entries.length === 0) {
    body = (
      <p className="hist-note">
        Nothing has been updated yet. Each update Riggverk makes is listed here with what it changed, what it checked and what it left for you.
      </p>
    );
  } else {
    const undoTarget = history.entries.find(entry => entry.undoable && entry.is_newest_completed)?.transaction_id ?? null;
    body = (
      <ul className="runs" aria-label="Updates, newest first">
        {history.entries.map((entry, index) => (
          <RunRow
            key={entry.transaction_id}
            entry={entry}
            open={chosen[entry.transaction_id] ?? index === 0}
            backupCount={backupCount}
            undoTarget={undoTarget}
            undoDisabled={undoDisabled}
            onToggle={() => setChosen(prev => ({ ...prev, [entry.transaction_id]: !(prev[entry.transaction_id] ?? index === 0) }))}
            onUndo={onUndo}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="hist">
      <section className="hist-page" aria-label="History" data-pane-id="page" data-pane-default data-keyscope="pane" tabIndex={-1}>
        <header className="hist-head">
          <h2 className="hist-title">History</h2>
          <p className="hist-sub">Every update, newest first</p>
        </header>
        {body}
      </section>
    </div>
  );
}
