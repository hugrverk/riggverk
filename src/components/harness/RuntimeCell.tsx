import type { ReactNode } from "react";
import type { KvItem } from "../../ui/Kv";
import { cx, toneClass, type Tone } from "../../ui/tone";

export interface RuntimeCellProps {
  /** The verdict in a word or two ("synced", "diverged", "workspace folder unusable"). */
  verdict: { text: string; tone: Tone };
  rows: readonly KvItem[];
  /** After the rows: the OpenCode model override. */
  children?: ReactNode;
}

/**
 * What the harness reports about itself at runtime: a verdict and the facts behind it. Runtime health is never a state
 * of its own and has no pill; the verdict is a plain word whose tone only shades the text. Rows flow into as many
 * columns as the cell has room for.
 */
export function RuntimeCell({ verdict, rows, children }: RuntimeCellProps) {
  return (
    <section className="hp-cell hp-span3 hp-runtime" aria-label="Runtime">
      <span className="hp-lbl">Runtime</span>
      <div className="hp-ch">
        <b className={toneClass(verdict.tone) || undefined}>{verdict.text}</b>
      </div>
      {rows.length > 0 && (
        <dl className="hp-facts" aria-label="Runtime facts">
          {rows.map((row, index) => (
            <div key={row.id ?? `${index}`} className="hp-fact">
              <dt>{row.label}</dt>
              <dd className={cx(toneClass(row.tone), row.wrap && "wrap") || undefined}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  );
}
