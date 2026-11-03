import { useId } from "react";
import { routingLine, whenProblem } from "./routing";

export interface RoutingValue { checked: boolean; when: string }

export function RoutingField({ name, suggestion, value, onChange, disabled = false }: {
  name: string; suggestion: string; value: RoutingValue; onChange: (value: RoutingValue) => void; disabled?: boolean;
}) {
  const id = useId();
  const problem = value.checked ? whenProblem(value.when, name) : "";
  return (
    <div className="lib-import-rename">
      <label><input type="checkbox" checked={value.checked} disabled={disabled} onChange={event => onChange({ ...value, checked: event.target.checked })} /> Add a routing line</label>
      <label className="lib-label" htmlFor={`${id}-when`}>Use when</label>
      <input id={`${id}-when`} className="lib-input" value={value.when} disabled={disabled || !value.checked} aria-invalid={problem ? true : undefined} aria-describedby={`${id}-note`} onChange={event => onChange({ ...value, when: event.target.value })} />
      <p id={`${id}-note`} className={problem ? "lib-newdoc-error" : "lib-dim"}>{problem || (suggestion && value.when === suggestion ? "Suggested from its description" : "")}</p>
      {value.checked && <p>In your rules files: <code className="lib-mono">{routingLine(value.when, name)}</code></p>}
    </div>
  );
}
