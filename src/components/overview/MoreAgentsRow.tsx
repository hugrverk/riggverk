import { HARNESS_LABELS } from "../../lib/harnessInstallation";
import { listText } from "../../lib/overviewModel";
import type { InstallAgent } from "../../types";
import { TButton } from "../../ui/TButton";

export interface MoreAgentsRowProps {
  /** The agents that are off, in sidebar order. */
  disabled: readonly InstallAgent[];
  /** Turning an agent on is a Settings switch. */
  onAdd: () => void;
}

/** "Cursor, Copilot, Pi and Kilo are off." with the names as dashed chips and a way to Settings. Not rendered when every agent is on. */
export function MoreAgentsRow({ disabled, onAdd }: MoreAgentsRowProps) {
  if (disabled.length === 0) return null;
  const names = disabled.map(harness => HARNESS_LABELS[harness]);
  return (
    <section className="ov-cell ov-span3 ov-more" aria-label="Agents that are off">
      <span>
        {listText(names)} {disabled.length === 1 ? "is" : "are"} off.
      </span>
      <span className="ov-chips" aria-hidden="true">
        {names.map(name => (
          <span key={name}>{name}</span>
        ))}
      </span>
      <TButton keys={[]} onClick={onAdd}>
        Add agents…
      </TButton>
    </section>
  );
}
