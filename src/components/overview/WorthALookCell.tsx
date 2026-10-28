import { useId } from "react";
import type { WorthALook } from "../../lib/overviewModel";
import type { InstallAgent } from "../../types";
import { cx } from "../../ui/tone";

export interface WorthALookCellProps {
  look: WorthALook;
  span?: 1 | 3;
  /** Opens the agent's page, where the full security rows are. */
  onOpen: (harness: InstallAgent) => void;
}

/**
 * Risky security findings of the enabled agents, one row per agent, each a link to that agent's page. Advice only: it
 * never counts towards a state. Not rendered when there is nothing risky to show.
 */
export function WorthALookCell({ look, span = 1, onOpen }: WorthALookCellProps) {
  const labelId = useId();
  if (look.count === 0) return null;
  return (
    <section className={cx("ov-cell", span === 3 && "ov-span3")} aria-labelledby={labelId}>
      <span id={labelId} className="ov-lbl">
        Worth a look · {look.count}
      </span>
      <ul className="ov-mini">
        {look.rows.map(row => (
          <li key={row.harness}>
            <button type="button" className="ov-row-link" onClick={() => onOpen(row.harness)}>
              <span>{row.label}</span>
              <span className="ov-val">{row.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
