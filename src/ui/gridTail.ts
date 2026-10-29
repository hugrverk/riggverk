import type { CSSProperties } from "react";

/**
 * How many columns the last of `count` cells spans so that it closes its row: the cell that would leave empty slots
 * takes them. In a grid of `columns` columns the last cell sits in slot (count - 1) % columns of its row.
 */
export function tailSpan(count: number, columns: number): number {
  return count > 0 ? columns - ((count - 1) % columns) : 1;
}

/** The grid's spans for its last cell at three columns and at two, read by the `-tail` rule of the grid's styles. */
export function tailStyle(count: number): CSSProperties {
  return { "--tail3": tailSpan(count, 3), "--tail2": tailSpan(count, 2) } as CSSProperties;
}
