import type { ReceiptLine } from "../../lib/lastUpdate";
import { cx } from "../../ui/tone";

export interface ReceiptProps {
  lines: readonly ReceiptLine[];
  className?: string;
  id?: string;
}

/**
 * The receipt of one run as a definition list: Changed / Checked / Left for you / Backup, each a label and the
 * recorded fact. The lines come from `receiptLines`, which states only what the transaction manifest recorded; this
 * component adds nothing to them.
 */
export function Receipt({ lines, className, id }: ReceiptProps) {
  return (
    <dl id={id} className={cx("receipt", className)}>
      {lines.map(line => (
        <div key={line.label}>
          <dt>{line.label}</dt>
          <dd>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}
