import { useId } from "react";
import type { AgentCardModel } from "../../lib/overviewModel";
import type { RulesOverrideWarning } from "../../lib/rulesView";
import type { InstallAgent } from "../../types";
import { StateMark, StatePill } from "../../ui/StatePill";
import { cx } from "../../ui/tone";

export interface AgentCellProps {
  card: AgentCardModel;
  /** Codex only: AGENTS.override.md replaces AGENTS.md, so the base is silently off. */
  override?: RulesOverrideWarning | null;
  onOpen: (harness: InstallAgent) => void;
}

/**
 * One enabled agent: its name (the cell's one button, which opens the agent's page; the whole cell is its click
 * target), the pill for its aggregate state, one row per surface with its state in words, and the sentence of the most
 * urgent row. A cell with a decision in it carries a bright top edge. Runtime health only ever adds a sentence here.
 */
export function AgentCell({ card, override = null, onOpen }: AgentCellProps) {
  const baseId = useId();
  const noteId = `${baseId}-note`;
  const pillId = `${baseId}-pill`;
  const describedBy = [card.badge ? pillId : null, card.notes.length > 0 ? noteId : null].filter(Boolean).join(" ") || undefined;
  return (
    <article className="ov-cell ov-agent" data-state={card.badge?.state}>
      <span className="ov-lbl">Agent</span>
      <div className="ov-ch">
        <button type="button" className="ov-open" aria-describedby={describedBy} onClick={() => onOpen(card.harness)}>
          {card.label}
        </button>
        {card.badge && (
          <StatePill id={pillId} state={card.badge.state}>
            {card.badge.text}
          </StatePill>
        )}
      </div>
      {card.rows.length > 0 && (
        <ul className="ov-mini" aria-label={`${card.label} surfaces`}>
          {card.rows.map(row => (
            <li key={row.surface}>
              <span>{row.label}</span>
              <span className={cx("ov-val", row.state && `is-${row.state}`)}>
                {row.state && <StateMark state={row.state} />}
                {row.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {override && (
        <p className="ov-alert" role="alert">
          <b>{override.title}.</b> {override.detail}
        </p>
      )}
      {card.notes.length > 0 && (
        <p id={noteId} className="ov-note">
          {card.notes.map((note, index) => (
            <span key={index}>{note}</span>
          ))}
        </p>
      )}
    </article>
  );
}
