import type { ReactNode } from "react";
import type { KvItem } from "../../ui/Kv";
import { cx, toneClass, type Tone } from "../../ui/tone";

/** A row without a label continues the row above it; together they are one fact. */
function groupFacts(rows: readonly KvItem[]): KvItem[][] {
  const groups: KvItem[][] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && row.label === "") last.push(row);
    else groups.push([row]);
  }
  return groups;
}

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
 * columns as the cell has room for; a row with a label and the unlabelled rows that follow it (skill-load names)
 * are one block across the full width.
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
          {groupFacts(rows).map((group, index) => (
            <div key={group[0]!.id ?? `${index}`} className={cx("hp-fact", group.length > 1 && "hp-fact-block")}>
              <dt>{group[0]!.label}</dt>
              {group.map((row, rowIndex) => (
                <dd key={row.id ?? `${rowIndex}`} className={cx(toneClass(row.tone), row.wrap && "wrap") || undefined}>
                  {row.value}
                </dd>
              ))}
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  );
}
