import type { CSSProperties } from "react";
import type { OverviewId } from "../hooks/useInstallationOverview";
import { MATRIX_COLUMNS, type MatrixRowModel } from "../lib/installationView";
import { Glyph } from "../ui/Glyph";
import { cx } from "../ui/tone";

export interface SurfaceMatrixProps {
  rows: readonly MatrixRowModel[];
  /** The target whose row is emphasised (the cursor of the harness list). */
  selectedId?: OverviewId;
}

/**
 * Installed state of every target against every surface kind. A CSS grid, not preformatted text: each cell is
 * a glyph (shape carries the state, colour only reinforces it) plus a visually hidden text label, and the
 * legend below spells the glyphs out.
 */
export function SurfaceMatrix({ rows, selectedId }: SurfaceMatrixProps) {
  return (
    <>
      <div
        className="matrix-grid"
        role="table"
        aria-label="Installed surfaces"
        style={{ "--matrix-cols": MATRIX_COLUMNS.length } as CSSProperties}
      >
        <div className="matrix-row" role="row">
          <span className="h" role="columnheader">
            <span className="visually-hidden">target</span>
          </span>
          {MATRIX_COLUMNS.map(column => (
            <span key={column} className="h" role="columnheader">
              {column}
            </span>
          ))}
        </div>
        {rows.map(row => (
          <div key={row.id} className="matrix-row" role="row">
            <span className={cx(row.id === selectedId && "c-head")} role="rowheader">
              {row.label}
            </span>
            {row.cells.map(cell => (
              <span
                key={cell.column}
                className="cell"
                role="cell"
                title={`${row.label} ${cell.column}: ${cell.display.label}`}
              >
                <Glyph name={cell.display.glyph} tone={cell.display.tone} />
                <span className="visually-hidden">{cell.display.label}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="matrix-legend" aria-label="Legend">
        <span><Glyph name="ok" tone="ok" /> current</span>
        <span><Glyph name="partial" tone="warn" /> update / not installed</span>
        <span><Glyph name="fail" tone="fail" /> conflict</span>
        <span><Glyph name="none" tone="dim" /> off / n/a</span>
      </div>
    </>
  );
}
