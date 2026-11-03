import { useId } from "react";
import { routingLine, whenProblem } from "./routing";

/** What the field holds: whether the skill gets a routing line, and its "Use when" text. */
export interface RoutingValue {
  checked: boolean;
  when: string;
}

interface RoutingFieldProps {
  /** The skill's name as it will be installed (after a rename). */
  name: string;
  /** The suggestion from its description, or "". */
  suggestion: string;
  value: RoutingValue;
  onChange: (value: RoutingValue) => void;
  disabled?: boolean;
}

/**
 * "Use when…" for one imported skill: the line the app writes into the imported pack's `routing.md`, which the next
 * Update adds to every rules file under "Pack skill routing". The exact line is shown as it is typed, so nothing
 * reaches the agents' rules unseen.
 */
export function RoutingField({ name, suggestion, value, onChange, disabled = false }: RoutingFieldProps) {
  const id = useId();
  const problem = value.checked ? whenProblem(value.when, name) : "";
  const note = problem || (value.checked && suggestion !== "" && value.when === suggestion ? "Suggested from its description." : "");

  return (
    <div className="lib-import-routing">
      <label className="lib-import-routing-toggle">
        <input
          type="checkbox"
          checked={value.checked}
          disabled={disabled}
          onChange={event => onChange({ ...value, checked: event.target.checked })}
        />
        Add a routing line
      </label>
      <label className="lib-label" htmlFor={`${id}-when`}>Use when</label>
      <input
        id={`${id}-when`}
        className="lib-input"
        type="text"
        value={value.when}
        autoComplete="off"
        disabled={disabled || !value.checked}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-note`}
        onChange={event => onChange({ ...value, when: event.target.value })}
      />
      <p id={`${id}-note`} className={problem ? "lib-newdoc-error" : "lib-dim"} hidden={value.checked && note === ""}>
        {note || (value.checked ? "" : "Agents can still pick it from its description.")}
      </p>
      {value.checked && !problem && (
        <p className="lib-import-routing-line">
          In your rules files: <code className="lib-mono">{routingLine(value.when, name)}</code>
        </p>
      )}
    </div>
  );
}
