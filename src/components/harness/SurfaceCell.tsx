import { useId, type ReactNode } from "react";
import { UI_STATE_LABEL, type UiState } from "../../lib/uiState";
import { StatePill } from "../../ui/StatePill";
import { Switch } from "../../ui/Switch";
import { cx } from "../../ui/tone";

export interface SurfaceCellToggle {
  checked: boolean;
  /** Accessible name of the switch. */
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean | string;
  /** What the switch also gates ("also mcp"), told under it. */
  note?: string | null;
}

export interface SurfaceCellProps {
  /** The mono label: "Rules · .claude/CLAUDE.md". */
  label: string;
  /** The one bold line: the reason of a state, or what the surface is. */
  headline: string;
  state: UiState | null;
  /** A muted sentence under the headline. */
  note?: string | null;
  /** The surface id, for the page to find the cell. */
  surface: string;
  /** A decision (or anything with detail and actions) takes the whole row. */
  wide?: boolean;
  /** The keys act on this cell. */
  active?: boolean;
  /** Focus or a click landed in the cell: its surface becomes the one the page keys act on. */
  onActivate?: () => void;
  toggle?: SurfaceCellToggle | null;
  /** Detail under the headline (the rules file, the files in conflict, the Codex keys). */
  children?: ReactNode;
  /** Buttons for the cell's actions. */
  actions?: ReactNode;
}

/**
 * One surface of a harness as a cell of the hairline grid: mono label, a bold line with the state pill, the target
 * switch where one gates the surface, the detail of a decision and its buttons. A cell with a decision in it spans the
 * row and carries the bright top edge. The cell is not a control; the controls inside it are.
 */
export function SurfaceCell({
  label,
  headline,
  state,
  note,
  surface,
  wide = false,
  active = false,
  onActivate,
  toggle,
  children,
  actions,
}: SurfaceCellProps) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  // A wide cell (a decision) tells the switch last, after the detail and the buttons: the decision comes first.
  const setting = toggle && (
    <div className="hp-setting">
      <span>
        Let Riggverk manage this
        {toggle.note && <span className="hp-setting-note">{toggle.note}</span>}
      </span>
      <Switch checked={toggle.checked} label={toggle.label} onChange={toggle.onChange} disabled={toggle.disabled} />
    </div>
  );
  return (
    <article
      className={cx("hp-cell", wide && "hp-span3")}
      aria-labelledby={labelId}
      data-surface={surface}
      data-state={state ?? undefined}
      data-active={active || undefined}
      onFocusCapture={onActivate}
      onClickCapture={onActivate}
    >
      <span className="hp-lbl" id={labelId}>
        {label}
      </span>
      <div className="hp-ch">
        <b>{headline}</b>
        {state && <StatePill state={state}>{UI_STATE_LABEL[state]}</StatePill>}
      </div>
      {note && <p className="hp-why">{note}</p>}
      {!wide && setting}
      {children}
      {actions && <div className="hp-acts">{actions}</div>}
      {wide && setting}
    </article>
  );
}
