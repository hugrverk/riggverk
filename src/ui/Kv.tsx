import type { ReactNode } from "react";
import { cx, toneClass, type Tone } from "./tone";

export interface KvItem {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  /** Let a long value wrap instead of truncating. */
  wrap?: boolean;
  /** React key when labels are not unique strings. */
  id?: string;
}

/** Label/value rows: `dl.kv > dt + dd`. */
export function Kv({ items, className, "aria-label": ariaLabel }: { items: readonly KvItem[]; className?: string; "aria-label"?: string }) {
  return (
    <dl className={cx("kv", className)} aria-label={ariaLabel}>
      {items.map((item, index) => (
        <KvRow key={item.id ?? `${index}`} item={item} />
      ))}
    </dl>
  );
}

function KvRow({ item }: { item: KvItem }) {
  return (
    <>
      <dt>{item.label}</dt>
      <dd className={cx(toneClass(item.tone), item.wrap && "wrap") || undefined}>{item.value}</dd>
    </>
  );
}
