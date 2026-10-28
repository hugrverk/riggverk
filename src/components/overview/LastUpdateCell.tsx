import { useId } from "react";
import { receiptLines, updateAgentsText, updateTimeText } from "../../lib/lastUpdate";
import type { SetupHistoryEntry } from "../../types";
import { StatePill } from "../../ui/StatePill";
import { TButton } from "../../ui/TButton";
import { cx } from "../../ui/tone";

export interface LastUpdateCellProps {
  entry: SetupHistoryEntry;
  /** Backups on disk, for the Backup line. */
  backupCount: number | null;
  span?: 2 | 3;
  /** Why Undo cannot start right now (a task is running), or false. */
  undoDisabled?: string | false;
  /** Starts the undo of this transaction: a dry run, then a confirm, then the rollback. Nothing is written before the confirm. */
  onUndo: (transactionId: string) => void;
}

/**
 * The receipt of the newest update, read from the setup history so it is still there after a restart: what changed,
 * what was checked, what was left for the user and what was backed up, from what the run recorded and nothing more.
 * "Undo this update…" is offered only where the backend says the transaction can be undone (`undoable`: the newest
 * completed one); it starts the same dry run and confirm as `z`.
 */
export function LastUpdateCell({ entry, backupCount, span = 2, undoDisabled = false, onUndo }: LastUpdateCellProps) {
  const labelId = useId();
  const agents = updateAgentsText(entry);
  const time = updateTimeText(entry);
  const title = ["Last update", agents, time].filter(Boolean).join(" · ");
  const lines = receiptLines(entry, backupCount);
  return (
    <section className={cx("ov-cell", span === 2 ? "ov-span2" : "ov-span3")} aria-labelledby={labelId}>
      <div className="ov-ch">
        <span id={labelId} className="ov-lbl">
          {title}
        </span>
        {entry.status === "rolled_back" && <StatePill state="tip">Undone</StatePill>}
      </div>
      <dl className="ov-rcpt">
        {lines.map(line => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {entry.undoable && (
        <TButton keys={[]} disabled={undoDisabled} onClick={() => onUndo(entry.transaction_id)}>
          Undo this update…
        </TButton>
      )}
    </section>
  );
}
