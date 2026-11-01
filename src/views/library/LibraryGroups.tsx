import { useId, type MouseEvent } from "react";
import { StateMark } from "../../ui/StatePill";
import type { GroupActionId, LibraryGroup, LibraryRow, RowVerb } from "./model";

interface RowViewProps {
  row: LibraryRow;
  /** Disambiguates the row key when one list shows the same item under two topics (search). */
  scope: string;
  onVerb: (row: LibraryRow, verb: RowVerb) => void;
}

/**
 * One row of a group: the name with a one-line description (or the mono path), a small tag, the state ring and the
 * verbs. The first verb is the row's main action: it is the keyboard stop that the arrow keys move between, and a
 * click on the row anywhere else runs it too. The state is said in words (visually hidden next to the ring), never by
 * the ring alone; the one decision is a filled square with its words in view.
 */
function RowView({ row, scope, onVerb }: RowViewProps) {
  const nameId = useId();
  const main = row.verbs[0];
  const onRowClick = (event: MouseEvent<HTMLLIElement>) => {
    if (!main || (event.target as Element).closest("button, a, input, textarea, summary")) return;
    onVerb(row, main);
  };
  return (
    <li
      className={`lib-row${row.indent ? " is-indent" : ""}${main ? " has-action" : ""}`}
      data-row-key={`${scope}/${row.key}`}
      onClick={onRowClick}
    >
      <div className="lib-row-main">
        <div className="lib-row-name">
          <b id={nameId}>{row.name}</b>
          {row.note && <span className="lib-tag">{row.note}</span>}
        </div>
        {row.desc ? (
          <div className="lib-row-desc">{row.desc}</div>
        ) : row.path ? (
          <div className="lib-row-path">{row.path}</div>
        ) : null}
      </div>
      <div className="lib-row-end">
        {row.tag && <span className={`lib-tag${row.tag.kind === "yours" ? " is-yours" : ""}`}>{row.tag.label}</span>}
        {row.state?.state === "decide" ? (
          <span className="lib-decide">{row.state.label}</span>
        ) : row.state ? (
          <span className="lib-state">
            <StateMark state={row.state.state} />
            <span className="visually-hidden">{row.state.label}</span>
          </span>
        ) : null}
        {row.verbs.map((verb, index) => (
          <button
            key={verb.label}
            type="button"
            className="lib-verb"
            data-row-primary={index === 0 ? "" : undefined}
            aria-describedby={nameId}
            onClick={() => onVerb(row, verb)}
          >
            {verb.label}
          </button>
        ))}
      </div>
    </li>
  );
}

interface GroupViewProps {
  group: LibraryGroup;
  scope: string;
  onVerb: (row: LibraryRow, verb: RowVerb) => void;
  onGroupAction: (id: GroupActionId) => void;
}

/** A hairline box of rows under its label, as System Settings groups its rows. */
export function GroupView({ group, scope, onVerb, onGroupAction }: GroupViewProps) {
  const labelId = useId();
  return (
    <section className="lib-group-wrap" aria-labelledby={labelId}>
      <div className="lib-group-head">
        <h3 id={labelId}>{group.label}</h3>
        {group.hint && <span>{group.hint}</span>}
        {group.action && (
          <button type="button" className="lib-verb" onClick={() => onGroupAction(group.action!.id)}>
            {group.action.label}
          </button>
        )}
      </div>
      <div className="lib-group">
        {group.notes && group.notes.length > 0 && (
          <div className="lib-notes" role="group" aria-label="Skill pack problems">
            {group.notes.map(line => (
              <div key={line.key} className="lib-note">
                <StateMark state="fix" />
                <span>
                  <b>{line.label}</b> · {line.text}
                </span>
              </div>
            ))}
          </div>
        )}
        {group.rows.length > 0 ? (
          <ul className="lib-rows" role="list">
            {group.rows.map(row => (
              <RowView key={row.key} row={row} scope={scope} onVerb={onVerb} />
            ))}
          </ul>
        ) : (
          group.empty && (
            <p className="lib-empty">
              {group.empty}
              {group.emptyPath && <span className="lib-row-path"> {group.emptyPath}</span>}
            </p>
          )
        )}
      </div>
    </section>
  );
}
